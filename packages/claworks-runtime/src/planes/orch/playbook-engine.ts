import { randomUUID } from "node:crypto";
import type { ModelRouter } from "../../claworks/model-router.js";
import type { RbacCheckInput, RbacCheckResult } from "../../claworks/robot-identity.js";
import type { KnowledgeBase, RobotInfo } from "../../kernel/types.js";
import type { LoadedPack } from "../../pack-loader/index.js";
import type { CwDatabase } from "../data/db.js";
import type { ObjectStore } from "../data/object-store.js";
import type { HitlGate } from "./hitl-gate.js";
import type {
  PlaybookDefinition,
  PlaybookRun,
  PlaybookStepContext,
  StepLog,
} from "./playbook-types.js";
import {
  executePlaybookStep,
  HitlSuspendedError,
  StepFailedError,
  type LlmCompleteFn,
  type ConnectorInvokeFn,
  type NotifyFn,
  type StepExecutorDeps,
} from "./step-executor.js";

export interface PlaybookEngine {
  loadFromPacks(packs: LoadedPack[]): Promise<void>;
  list(): PlaybookDefinition[];
  trigger(
    playbookId: string,
    input: Record<string, unknown>,
    ctx?: Partial<PlaybookStepContext>,
  ): Promise<PlaybookRun>;
  getRun(runId: string): Promise<PlaybookRun | null>;
  listRuns(opts: { playbookId?: string; status?: string; limit?: number }): Promise<PlaybookRun[]>;
  submitHitlDecision(
    runId: string,
    stepId: string,
    decision: string,
    comment?: string,
  ): Promise<PlaybookRun>;
  reloadPack(packId: string): Promise<void>;
  /** Restore waiting_hitl runs from DB after process restart */
  hydrateSuspendedRuns(): Promise<number>;
  setLlmComplete(fn: LlmCompleteFn | undefined): void;
  setNotify(fn: NotifyFn | undefined): void;
  setConnectorInvoke(fn: ConnectorInvokeFn | undefined): void;
}

export type PlaybookEngineDeps = {
  db: CwDatabase;
  objectStore: ObjectStore;
  kb: KnowledgeBase;
  robot: RobotInfo;
  hitl: HitlGate;
  llmComplete?: LlmCompleteFn;
  notify?: NotifyFn;
  connectorInvoke?: ConnectorInvokeFn;
  publishEvent?: (
    type: string,
    source: string,
    payload: Record<string, unknown>,
    correlationId?: string,
  ) => Promise<void>;
  ontology?: import("../data/ontology-engine.js").OntologyEngine;
  subagentRun?: import("./step-executor.js").SubagentRunFn;
  skillRun?: import("./step-executor.js").SkillRunFn;
  reloadPacks?: () => Promise<Record<string, unknown>>;
  reloadPackById?: (
    packId: string,
  ) => Promise<import("../../pack-loader/index.js").LoadedPack | null>;
  a2aPeers?: import("../../claworks/a2a-peers.js").A2aPeerConfig[];
  modelRouter?: ModelRouter;
  rbacCheck?: (input: RbacCheckInput) => RbacCheckResult;
  logger?: (msg: string) => void;
};

type RunRow = {
  id: string;
  playbook_id: string;
  status: string;
  input: string;
  output: string | null;
  error: string | null;
  steps: string;
  started_at: number;
  completed_at: number | null;
};

type SuspendedExecution = {
  playbookId: string;
  input: Record<string, unknown>;
  variables: Record<string, unknown>;
  nextStepIndex: number;
  hitlStepId: string;
};

type StepsPersistence = {
  logs: StepLog[];
  suspended?: SuspendedExecution;
};

export { HitlSuspendedError } from "./step-executor.js";

export function createPlaybookEngine(deps: PlaybookEngineDeps): PlaybookEngine {
  const playbooks = new Map<string, PlaybookDefinition>();
  const runs = new Map<string, PlaybookRun>();
  const suspended = new Map<string, SuspendedExecution>();
  const db = deps.db;
  let llmComplete = deps.llmComplete;
  let notify = deps.notify;
  let connectorInvoke = deps.connectorInvoke;
  const publishEvent = deps.publishEvent;
  const ontology = deps.ontology;
  const reloadPacks = deps.reloadPacks;
  const reloadPackById = deps.reloadPackById;
  const a2aPeers = deps.a2aPeers ?? [];
  const modelRouter = deps.modelRouter;
  let subagentRun = deps.subagentRun;
  let skillRun = deps.skillRun;

  const upsertRun = db.prepare(`
    INSERT INTO cw_playbook_runs (id, playbook_id, status, input, output, error, steps, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      output = excluded.output,
      error = excluded.error,
      steps = excluded.steps,
      completed_at = excluded.completed_at
  `);
  const selectRun = db.prepare("SELECT * FROM cw_playbook_runs WHERE id = ?");
  const selectWaitingHitl = db.prepare(
    "SELECT * FROM cw_playbook_runs WHERE status = 'waiting_hitl'",
  );

  function storeSuspended(runId: string, data: SuspendedExecution): void {
    suspended.set(runId, data);
  }

  function clearSuspended(runId: string): void {
    suspended.delete(runId);
  }

  async function triggerInternal(
    playbookId: string,
    input: Record<string, unknown>,
    partialCtx?: Partial<PlaybookStepContext>,
  ): Promise<PlaybookRun> {
    const def = playbooks.get(playbookId);
    if (!def) {
      throw new Error(`Playbook not found: ${playbookId}`);
    }

    const runId = randomUUID();
    const run: PlaybookRun = {
      id: runId,
      playbookId,
      status: "running",
      startedAt: new Date(),
      input,
      steps: [],
    };
    runs.set(runId, run);
    persistRun(upsertRun, run, suspended.get(runId));

    const ctx: PlaybookStepContext = {
      runId,
      playbookId,
      variables: {
        ...input,
        payload: input,
        trigger: input, // {{trigger.xxx}} 语法支持
        _now: new Date().toISOString(),
        _now_ts: Date.now(),
        steps: {},
      },
      objectStore: deps.objectStore,
      kb: deps.kb,
      robot: deps.robot,
      publishEvent,
      ontology,
      reloadPacks,
      a2aPeers,
      ...partialCtx,
    };

    try {
      await runSteps(def, run, ctx, 0);
    } catch (err) {
      if (err instanceof HitlSuspendedError) {
        const stepIndex = def.steps.findIndex((s) => s.id === err.stepId);
        storeSuspended(runId, {
          playbookId,
          input,
          variables: { ...ctx.variables },
          nextStepIndex: stepIndex >= 0 ? stepIndex + 1 : def.steps.length,
          hitlStepId: err.stepId,
        });
        run.status = "waiting_hitl";
        persistRun(upsertRun, run, suspended.get(runId));
        return run;
      }
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      run.completedAt = new Date();
      clearSuspended(runId);
    }

    if (run.status === "completed") {
      run.output = summarizeRunOutput(ctx.variables);
    }

    runs.set(runId, run);
    persistRun(upsertRun, run, suspended.get(runId));
    return run;
  }

  async function runSteps(
    def: PlaybookDefinition,
    run: PlaybookRun,
    ctx: PlaybookStepContext,
    fromIndex: number,
  ): Promise<void> {
    for (let i = fromIndex; i < def.steps.length; i++) {
      try {
        await executePlaybookStep(def.steps[i]!, ctx, run, stepDeps());
      } catch (err) {
        if (err instanceof HitlSuspendedError) {
          throw err;
        }
        if (err instanceof StepFailedError && err.policy === "continue") {
          deps.logger?.(`[claworks:playbook] step ${err.stepId} failed (continue): ${err.message}`);
          continue;
        }
        throw err;
      }
    }
    if (run.status === "running") {
      run.status = "completed";
      run.completedAt = new Date();
      run.output = summarizeRunOutput(ctx.variables);
    }
  }

  function stepDeps(): StepExecutorDeps {
    return {
      objectStore: deps.objectStore,
      kb: deps.kb,
      robot: deps.robot,
      hitl: deps.hitl,
      llmComplete,
      notify,
      connectorInvoke,
      subagentRun,
      skillRun,
      a2aPeers,
      modelRouter,
      rbacCheck: deps.rbacCheck,
      triggerPlaybook: (playbookId, input) => triggerInternal(playbookId, input),
      logger: deps.logger,
    };
  }

  function queryRunsFromDb(opts: {
    playbookId?: string;
    status?: string;
    limit: number;
  }): PlaybookRun[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.playbookId) {
      conditions.push("playbook_id = ?");
      params.push(opts.playbookId);
    }
    if (opts.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(opts.limit);
    const sql = `SELECT * FROM cw_playbook_runs ${where} ORDER BY started_at DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params) as RunRow[];
    return rows.map(rowToRun);
  }

  return {
    async loadFromPacks(packs) {
      playbooks.clear();
      for (const pack of packs) {
        for (const pb of pack.playbooks) {
          if (pb.id) {
            playbooks.set(pb.id, pb);
          }
        }
      }
    },

    list() {
      return [...playbooks.values()];
    },

    setLlmComplete(fn) {
      llmComplete = fn;
    },

    setNotify(fn) {
      notify = fn;
    },

    setConnectorInvoke(fn) {
      connectorInvoke = fn;
    },

    async trigger(playbookId, input, partialCtx) {
      return triggerInternal(playbookId, input, partialCtx);
    },

    async getRun(runId) {
      if (runs.has(runId)) {
        return runs.get(runId)!;
      }
      const row = selectRun.get(runId) as RunRow | undefined;
      if (!row) {
        return null;
      }
      const run = rowToRun(row);
      const { suspended: susp } = parseStepsPersistence(row.steps);
      if (susp && run.status === "waiting_hitl") {
        suspended.set(runId, susp);
      }
      runs.set(runId, run);
      return run;
    },

    async listRuns(opts) {
      const limit = opts.limit ?? 50;
      const dbRuns = queryRunsFromDb({
        playbookId: opts.playbookId,
        status: opts.status,
        limit: limit * 2,
      });
      const byId = new Map<string, PlaybookRun>();
      for (const run of dbRuns) {
        byId.set(run.id, run);
      }
      for (const run of runs.values()) {
        if (opts.playbookId && run.playbookId !== opts.playbookId) {
          continue;
        }
        if (opts.status && run.status !== opts.status) {
          continue;
        }
        byId.set(run.id, run);
      }
      return [...byId.values()]
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, limit);
    },

    async hydrateSuspendedRuns() {
      const rows = selectWaitingHitl.all() as RunRow[];
      let count = 0;
      for (const row of rows) {
        const run = rowToRun(row);
        const { suspended: susp } = parseStepsPersistence(row.steps);
        if (!susp) {
          deps.logger?.(
            `[claworks:playbook] waiting_hitl run ${row.id} missing suspended metadata`,
          );
          continue;
        }
        runs.set(run.id, run);
        suspended.set(run.id, susp);
        count += 1;
      }
      return count;
    },

    async reloadPack(packId) {
      if (reloadPackById) {
        const pack = await reloadPackById(packId);
        if (!pack) {
          throw new Error(`Pack not found: ${packId}`);
        }
        return;
      }
      if (reloadPacks) {
        await reloadPacks();
        return;
      }
      throw new Error("Pack reload is not configured");
    },

    async submitHitlDecision(runId, stepId, decision, comment) {
      const run = await this.getRun(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      const pending = suspended.get(runId);
      if (!pending) {
        throw new Error(`Run ${runId} is not waiting for HITL`);
      }

      const step = run.steps.find((s) => s.stepId === stepId);
      if (step) {
        step.status = "completed";
        step.completedAt = new Date();
        step.output = { decision, comment };
      }

      const def = playbooks.get(pending.playbookId);
      if (!def) {
        throw new Error(`Playbook not found: ${pending.playbookId}`);
      }

      const ctx: PlaybookStepContext = {
        runId,
        playbookId: pending.playbookId,
        variables: {
          ...pending.variables,
          payload: pending.input,
          steps: pending.variables.steps ?? {},
          hitl_decision: decision,
          hitl_comment: comment ?? "",
        },
        objectStore: deps.objectStore,
        kb: deps.kb,
        robot: deps.robot,
        publishEvent,
        ontology,
        reloadPacks,
        a2aPeers,
      };

      run.status = "running";
      clearSuspended(runId);

      try {
        await runSteps(def, run, ctx, pending.nextStepIndex);
      } catch (err) {
        if (err instanceof HitlSuspendedError) {
          const stepIndex = def.steps.findIndex((s) => s.id === err.stepId);
          storeSuspended(runId, {
            playbookId: pending.playbookId,
            input: pending.input,
            variables: { ...ctx.variables },
            nextStepIndex: stepIndex >= 0 ? stepIndex + 1 : def.steps.length,
            hitlStepId: err.stepId,
          });
          run.status = "waiting_hitl";
        } else {
          run.status = "failed";
          run.error = err instanceof Error ? err.message : String(err);
          run.completedAt = new Date();
          clearSuspended(runId);
        }
      }

      runs.set(runId, run);
      persistRun(upsertRun, run, suspended.get(runId));
      return run;
    },
  };
}

function summarizeRunOutput(variables: Record<string, unknown>): Record<string, unknown> {
  const { steps: _steps, payload, ...rest } = variables;
  return { ...rest, payload };
}

function parseStepsPersistence(raw: string): StepsPersistence {
  const parsed = JSON.parse(raw) as StepsPersistence | StepLog[];
  if (Array.isArray(parsed)) {
    return { logs: reviveStepLogs(parsed) };
  }
  return {
    logs: reviveStepLogs(parsed.logs ?? []),
    suspended: parsed.suspended,
  };
}

function reviveStepLogs(logs: StepLog[]): StepLog[] {
  return logs.map((log) => ({
    ...log,
    startedAt: log.startedAt instanceof Date ? log.startedAt : new Date(log.startedAt),
    completedAt: log.completedAt
      ? log.completedAt instanceof Date
        ? log.completedAt
        : new Date(log.completedAt)
      : undefined,
  }));
}

function persistRun(
  stmt: ReturnType<CwDatabase["prepare"]>,
  run: PlaybookRun,
  susp?: SuspendedExecution,
): void {
  const stepsJson =
    susp != null
      ? JSON.stringify({ logs: run.steps, suspended: susp } satisfies StepsPersistence)
      : JSON.stringify(run.steps);
  stmt.run(
    run.id,
    run.playbookId,
    run.status,
    JSON.stringify(run.input),
    run.output ? JSON.stringify(run.output) : null,
    run.error ?? null,
    stepsJson,
    run.startedAt.getTime(),
    run.completedAt?.getTime() ?? null,
  );
}

function rowToRun(row: RunRow): PlaybookRun {
  const { logs } = parseStepsPersistence(row.steps);
  return {
    id: row.id,
    playbookId: row.playbook_id,
    status: row.status as PlaybookRun["status"],
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    input: JSON.parse(row.input) as Record<string, unknown>,
    output: row.output ? (JSON.parse(row.output) as Record<string, unknown>) : undefined,
    error: row.error ?? undefined,
    steps: logs,
  };
}
