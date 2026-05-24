import { randomUUID } from "node:crypto";
import type { ModelRouter } from "../../claworks/model-router.js";
import type { RbacCheckInput, RbacCheckResult } from "../../claworks/robot-identity.js";
import { buildEventContext } from "../../kernel/event-context.js";
import { CW_EVENTS } from "../../kernel/event-names.js";
import { globalMetrics } from "../../kernel/metrics.js";
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
  type CallPlaybookFn,
  type ConnectorInvokeFn,
  type NotifyFn,
  type StepExecutorDeps,
} from "./step-executor.js";

export interface PlaybookEngine {
  loadFromPacks(packs: LoadedPack[]): Promise<void>;
  /**
   * 动态加载（或替换）单个 Playbook 定义（热重载用）。
   * 若同 id 已存在则替换，否则新增。
   */
  load(playbook: PlaybookDefinition): void;
  /**
   * 按 id 卸载一个 Playbook（热移除用）。
   */
  unload(id: string): void;
  list(): PlaybookDefinition[];
  /** Alias for list() for readability in integration tests and external consumers. */
  listPlaybooks(): PlaybookDefinition[];
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
  /**
   * Sweep HITL entries past their expiresAt deadline and auto-resume them
   * with the configured on_timeout decision. Returns count of expired runs.
   */
  expireStaleHitl(): Promise<number>;
  setLlmComplete(fn: LlmCompleteFn | undefined): void;
  setNotify(fn: NotifyFn | undefined): void;
  setConnectorInvoke(fn: ConnectorInvokeFn | undefined): void;
  setPublishAnomaly(fn: ((payload: Record<string, unknown>) => Promise<void>) | undefined): void;
  setContextEngine(
    engine: import("../../kernel/context-engine.js").ContextEngine | undefined,
  ): void;
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
  scriptRun?: import("./step-executor.js").ScriptRunFn;
  reloadPacks?: () => Promise<Record<string, unknown>>;
  reloadPackById?: (
    packId: string,
  ) => Promise<import("../../pack-loader/index.js").LoadedPack | null>;
  a2aPeers?: import("../../claworks/a2a-peers.js").A2aPeerConfig[];
  modelRouter?: ModelRouter;
  rbacCheck?: (input: RbacCheckInput) => RbacCheckResult;
  logger?: (msg: string) => void;
  /** Pack action registry — passed through to step-executor for dynamic dispatch */
  actionRegistry?: import("../../kernel/action-registry.js").ActionRegistry;
  /** Pack intent registry — passed through to function-executor */
  intentRegistry?: import("../../kernel/intent-registry.js").IntentRegistry;
  /** 生产模式：stub 步骤 fail-closed */
  productionMode?: boolean;
  /** 发布异常事件 */
  publishAnomaly?: (payload: Record<string, unknown>) => Promise<void>;
  /**
   * 对话上下文引擎（可选）。
   * 提供后，Playbook 启动时自动将最近 N 轮对话历史注入为 _session 变量，
   * 供 LLM 步骤通过 {{_session.history}} 使用，无需在 Playbook 内额外查询。
   */
  contextEngine?: import("../../kernel/context-engine.js").ContextEngine;
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
  // Per-playbook concurrency counter — prevents runaway parallel invocations
  const concurrencyMap = new Map<string, number>();
  const MAX_CONCURRENT_PER_PLAYBOOK = 8;
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
  let scriptRun = deps.scriptRun;
  const productionMode = deps.productionMode ?? false;
  let publishAnomaly = deps.publishAnomaly;

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

    // Role guard: if Playbook declares required_role, check input.user_role
    if (def.required_role) {
      const roleOrder = ["viewer", "operator", "admin"] as const;
      const requiredIdx = roleOrder.indexOf(def.required_role);
      const userRole = String(input.user_role ?? "");
      const userIdx = roleOrder.indexOf(userRole as (typeof roleOrder)[number]);
      if (userIdx < requiredIdx) {
        deps.logger?.(
          `[claworks:playbook] role denied for '${playbookId}': need ${def.required_role}, got '${userRole}'`,
        );
        return {
          id: `denied-${Date.now()}`,
          playbookId,
          status: "failed",
          startedAt: new Date(),
          completedAt: new Date(),
          input,
          steps: [],
          error: `权限不足：需要 ${def.required_role} 角色`,
        };
      }
    }

    // Concurrency guard: reject if this playbook already has too many running instances
    const currentConcurrency = concurrencyMap.get(playbookId) ?? 0;
    if (currentConcurrency >= MAX_CONCURRENT_PER_PLAYBOOK) {
      deps.logger?.(
        `[claworks:playbook] concurrency limit reached for '${playbookId}' (${currentConcurrency}/${MAX_CONCURRENT_PER_PLAYBOOK}) — dropping run`,
      );
      return {
        id: `dropped-${Date.now()}`,
        playbookId,
        status: "failed",
        startedAt: new Date(),
        completedAt: new Date(),
        input,
        steps: [],
        error: `concurrency_limit_exceeded: ${playbookId}`,
      };
    }
    concurrencyMap.set(playbookId, currentConcurrency + 1);

    const runId = randomUUID();
    const _pbStartMs = Date.now();
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
    globalMetrics.increment(CW_EVENTS.PLAYBOOK_STARTED, { playbook_id: playbookId });

    const ctx: PlaybookStepContext = {
      runId,
      playbookId,
      variables: {
        ...input,
        payload: input,
        trigger: input, // {{trigger.xxx}} 语法支持
        // {{event.payload.xxx}} 语法支持（与 payload.xxx / trigger.xxx 等价）
        event: { payload: input },
        _now: new Date().toISOString(),
        _now_ts: Date.now(),
        _now_date: new Date().toLocaleDateString("zh-CN"),
        _now_weekday: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date().getDay()],
        _robot_name: deps.robot.name,
        _robot_id: deps.robot.id ?? deps.robot.name,
        steps: {},
        // 自动注入会话历史：Playbook 通过 {{_session.history}} 获取最近对话
        // 避免每个 LLM 步骤重复查询，符合"热路径预计算"原则
        _session: buildSessionContext(
          String(input.session_id ?? input.sessionId ?? ""),
          deps.contextEngine,
        ),
        // 信息流预计算：从触发 payload 自动推断领域/实体/情感，注入 _ctx，
        // step-executor 中 buildLlmContext 直接消费，无需 LLM 步骤内重新分析
        _ctx: buildEventContext(
          input as Record<string, unknown>,
          def.trigger.kind === "event" ? def.trigger.pattern : undefined,
        ),
      },
      objectStore: deps.objectStore,
      kb: deps.kb,
      robot: deps.robot,
      publishEvent,
      ontology,
      reloadPacks,
      a2aPeers,
      connectorInvoke: deps.connectorInvoke,
      logger: deps.logger,
      ...partialCtx,
    };

    try {
      // Playbook 级全局超时保护（默认 5 分钟，可在 Playbook def 中配置 timeout_seconds）
      const playbookTimeoutMs = (def.timeout_seconds ?? 300) * 1000;
      const timeoutHandle = setTimeout(() => {
        if (run.status === "running") {
          run.status = "failed";
          run.error = `Playbook exceeded global timeout of ${def.timeout_seconds ?? 300}s`;
          run.completedAt = new Date();
          publishEvent?.(CW_EVENTS.PLAYBOOK_FAILED, "playbook-engine", {
            playbook_id: playbookId,
            run_id: runId,
            error: run.error,
            timeout: true,
          }).catch(() => {});
        }
      }, playbookTimeoutMs);
      await runSteps(def, run, ctx, 0).finally(() => clearTimeout(timeoutHandle));
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
      globalMetrics.increment(CW_EVENTS.PLAYBOOK_FAILED, { playbook_id: playbookId });
      globalMetrics.recordDuration("playbook.duration_ms", Date.now() - _pbStartMs, {
        playbook_id: playbookId,
        status: "failed",
      });
      // 发布 playbook.failed 事件，触发 error_recovery_notify Playbook
      publishEvent?.(CW_EVENTS.PLAYBOOK_FAILED, "playbook-engine", {
        playbook_id: playbookId,
        run_id: runId,
        error: run.error,
        user_id: String(input.user_id ?? input.sender_id ?? ""),
        original_text: String(input.text ?? input.message ?? ""),
        failed_at: run.completedAt.toISOString(),
      }).catch(() => {});
      // EvolveEngine 订阅此事件做失败案例分析
      publishEvent?.(CW_EVENTS.PLAYBOOK_RUN_FAILED, "playbook-engine", {
        playbook_id: playbookId,
        run_id: runId,
        error: run.error,
        steps: run.steps.length,
        duration_ms: Date.now() - _pbStartMs,
      }).catch(() => {});
    }

    if (run.status === "completed") {
      run.output = summarizeRunOutput(ctx.variables);
      globalMetrics.increment(CW_EVENTS.PLAYBOOK_COMPLETED, { playbook_id: playbookId });
      globalMetrics.recordDuration("playbook.duration_ms", Date.now() - _pbStartMs, {
        playbook_id: playbookId,
        status: "completed",
      });
      // EvolveEngine 和 verify() 需要此事件；同时将机器人回复写入对话历史
      publishEvent?.(CW_EVENTS.PLAYBOOK_RUN_COMPLETED, "playbook-engine", {
        playbook_id: playbookId,
        run_id: runId,
        steps: run.steps.length,
        duration_ms: Date.now() - _pbStartMs,
      }).catch(() => {});
      // 将 Playbook 产生的回复文本记录为 assistant 轮次，保持对话历史完整
      recordAssistantTurnOnCompletion(input, ctx.variables, playbookId, runId, deps.contextEngine);
    }

    runs.set(runId, run);
    persistRun(upsertRun, run, suspended.get(runId));
    // Release concurrency slot when run reaches a terminal or suspended state
    if (run.status !== "running") {
      releaseConcurrency(playbookId);
    }
    return run;
  }
  // Decrement concurrency counter when a run completes (any terminal status)
  function releaseConcurrency(playbookId: string): void {
    const cur = concurrencyMap.get(playbookId) ?? 1;
    if (cur <= 1) {
      concurrencyMap.delete(playbookId);
    } else {
      concurrencyMap.set(playbookId, cur - 1);
    }
  }

  async function runSteps(
    def: PlaybookDefinition,
    run: PlaybookRun,
    ctx: PlaybookStepContext,
    fromIndex: number,
  ): Promise<void> {
    for (let i = fromIndex; i < def.steps.length; i++) {
      try {
        await executePlaybookStep(def.steps[i], ctx, run, stepDeps());
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
      scriptRun,
      a2aPeers,
      modelRouter,
      rbacCheck: deps.rbacCheck,
      triggerPlaybook: (playbookId, input) => triggerInternal(playbookId, input),
      callPlaybook: async (playbookId, params, parentRunId) => {
        const child = await triggerInternal(playbookId, {
          ...params,
          parent_run_id: parentRunId,
        });
        return { output: child.output, status: child.status };
      },
      actionRegistry: deps.actionRegistry,
      intentRegistry: deps.intentRegistry,
      logger: deps.logger,
      productionMode,
      publishAnomaly,
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

    load(playbook: PlaybookDefinition) {
      if (playbook.id) {
        playbooks.set(playbook.id, playbook);
      }
    },

    unload(id: string) {
      playbooks.delete(id);
    },

    list() {
      return [...playbooks.values()];
    },

    listPlaybooks() {
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

    setPublishAnomaly(fn) {
      publishAnomaly = fn;
    },

    setContextEngine(engine) {
      deps.contextEngine = engine;
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
        .toSorted((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
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

    async expireStaleHitl() {
      const expired = deps.hitl.expireStale?.() ?? [];
      let count = 0;
      for (const { pending, decision } of expired) {
        const { runId, stepId } = pending;
        try {
          deps.logger?.(
            `[claworks:hitl] auto-expire run=${runId} step=${stepId} decision=${decision}`,
          );
          if (decision === "abort") {
            // Mark the run as failed with a timeout reason
            const run = await this.getRun(runId);
            if (run) {
              run.status = "failed";
              run.error = `HITL timeout: step '${stepId}' expired with on_timeout=abort`;
              run.completedAt = new Date();
            }
            if (deps.notify) {
              await deps.notify({
                message: `[HITL 超时] Playbook ${runId} 步骤 ${stepId} 超时后已终止（on_timeout=abort）`,
              });
            }
          } else {
            await this.submitHitlDecision(runId, stepId, decision, "auto-escalated by timeout");
          }
          count += 1;
        } catch (err) {
          deps.logger?.(
            `[claworks:hitl] expiry failed for run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
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

      if (run.status === "completed") {
        recordAssistantTurnOnCompletion(
          pending.input,
          ctx.variables,
          pending.playbookId,
          runId,
          deps.contextEngine,
        );
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

/**
 * 从 Playbook 最终变量中提取机器人回复文本，用于写入对话历史。
 * 按约定优先级查找：reply > response > answer > message > output > result
 */
function extractResponseText(variables: Record<string, unknown>): string | null {
  const candidates = ["reply", "response", "answer", "message", "output", "result"];
  for (const key of candidates) {
    const val = variables[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

function recordAssistantTurnOnCompletion(
  input: Record<string, unknown>,
  variables: Record<string, unknown>,
  playbookId: string,
  runId: string,
  contextEngine?: import("../../kernel/context-engine.js").ContextEngine,
): void {
  const sessionId = String(input.session_id ?? input.sessionId ?? "").trim();
  if (!sessionId || !contextEngine) return;
  const replyText = extractResponseText(variables);
  if (replyText) {
    contextEngine.append(sessionId, "assistant", replyText, {
      playbook_id: playbookId,
      run_id: runId,
    });
  }
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

/** JSON.stringify with circular reference protection. */
function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) {
        return "[Circular]";
      }
      seen.add(val);
    }
    return val as unknown;
  });
}

function persistRun(
  stmt: ReturnType<CwDatabase["prepare"]>,
  run: PlaybookRun,
  susp?: SuspendedExecution,
): void {
  const stepsJson =
    susp != null
      ? safeJsonStringify({ logs: run.steps, suspended: susp } satisfies StepsPersistence)
      : safeJsonStringify(run.steps);
  stmt.run(
    run.id,
    run.playbookId,
    run.status,
    safeJsonStringify(run.input),
    run.output ? safeJsonStringify(run.output) : null,
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

/**
 * 从 ContextEngine 构建会话上下文摘要，注入为 _session 变量。
 *
 * 数据形态（Playbook 中可直接访问）：
 *   {{_session.session_id}}        — 会话 ID
 *   {{_session.turn_count}}        — 历史轮次数
 *   {{_session.history_text}}      — 可直接粘贴进 Prompt 的文本格式历史
 *   {{_session.history}}           — 原始轮次数组（role/content/timestamp）
 */
function buildSessionContext(
  sessionId: string,
  contextEngine?: import("../../kernel/context-engine.js").ContextEngine,
): Record<string, unknown> {
  if (!sessionId || !contextEngine) {
    return { session_id: sessionId, turn_count: 0, history: [], history_text: "" };
  }

  const turns = contextEngine.getRecent(sessionId, 10);
  const historyText = turns
    .map((t) => `[${t.role === "user" ? "用户" : "机器人"}] ${t.content}`)
    .join("\n");

  return {
    session_id: sessionId,
    turn_count: turns.length,
    history: turns,
    history_text: historyText,
  };
}
