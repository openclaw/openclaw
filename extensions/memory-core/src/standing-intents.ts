import { randomUUID } from "node:crypto";
import { getDatabaseEngineInput } from "openclaw/plugin-sdk/database-engine-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { pathEntryExists } from "openclaw/plugin-sdk/path-existence-runtime";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  openOpenClawAgentSqliteWorkerStoreV2,
  runQueuedStoreWrite,
  type SqliteWorkerCommand,
  type StoreWriterQueue,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { captureMemoryAgentDatabaseOptions } from "./memory-agent-database.js";
import { memoryCpuProcessEntrypoints } from "./memory/manager-cpu-entrypoints.js";
import {
  DEFAULT_INTENT_COOLDOWN_SECONDS,
  DEFAULT_INTENT_EXPIRY_MS,
  DEFAULT_INTENT_MAX_FIRES,
  normalizeCreatorSender,
  prepareStandingIntentMatch,
  type StandingIntent,
  type StandingIntentOperations,
  type StandingIntentWorkerOperations,
  type StandingIntentRow,
  type StandingIntentStatus,
} from "./standing-intents-model.js";

type DatabaseOptions = ReturnType<typeof captureMemoryAgentDatabaseOptions>;
type MaintenanceSchedule = (path: string, nextDueAt: number | null) => void;
// Queue, committed-absence facts, and the selected scheduler share one process owner.
const maintenance = resolveGlobalSingleton<{
  schedule: MaintenanceSchedule | undefined;
  owners: Map<MaintenanceSchedule, () => void>;
  lifecycleFacts: Map<string, { empty: boolean }>;
  // Deadlines learned from completed operations survive a service reload, so reloading for one
  // agent does not sweep every other agent database again.
  knownDueAt: Map<string, number>;
  sweeps: { active: number; waiting: Array<() => void> };
  operationQueues: Map<string, StoreWriterQueue>;
}>(Symbol.for("openclaw.memoryCore.standingIntents"), () => ({
  schedule: undefined,
  owners: new Map<MaintenanceSchedule, () => void>(),
  lifecycleFacts: new Map<string, { empty: boolean }>(),
  knownDueAt: new Map<string, number>(),
  sweeps: { active: 0, waiting: [] },
  operationQueues: new Map<string, StoreWriterQueue>(),
}));
const { lifecycleFacts, knownDueAt, sweeps, operationQueues } = maintenance;
// Startup and unknown deadlines make every agent due at once; bound how many sweeps open a store.
const MAX_CONCURRENT_SWEEPS = 2;

function recordDueAt(path: string, nextDueAt: number | null): void {
  if (nextDueAt === null) {
    knownDueAt.delete(path);
  } else {
    knownDueAt.set(path, nextDueAt);
  }
  maintenance.schedule?.(path, nextDueAt);
}

async function withSweepSlot<T>(run: () => Promise<T>): Promise<T> {
  if (sweeps.active >= MAX_CONCURRENT_SWEEPS) {
    // A released slot is handed to the next waiter without being freed in between.
    await new Promise<void>((resolve) => {
      sweeps.waiting.push(resolve);
    });
  } else {
    sweeps.active += 1;
  }
  try {
    return await run();
  } finally {
    const next = sweeps.waiting.shift();
    if (next) {
      next();
    } else {
      sweeps.active -= 1;
    }
  }
}

export {
  DEFAULT_INTENT_COOLDOWN_SECONDS,
  DEFAULT_INTENT_EXPIRY_MS,
  DEFAULT_INTENT_MAX_FIRES,
  INTENT_INJECTION_MAX_CHARS,
  buildStandingIntentContext,
  encodeStandingIntentChannelScope,
  encodeStandingIntentSenderScope,
  isEligibleStandingIntentTurn,
  type IntentScope,
  type StandingIntent,
  type StandingIntentStatus,
} from "./standing-intents-model.js";

async function isMissingSqliteAgentDatabase(path: string): Promise<boolean> {
  return getDatabaseEngineInput("agent") === undefined && !(await pathEntryExists(path));
}

function executeStandingIntent<Key extends keyof StandingIntentOperations>(
  params: { agentId: string; assertCurrent?: () => void },
  command: { type: Key; input: StandingIntentOperations[Key]["input"] },
  options?: DatabaseOptions,
): Promise<StandingIntentOperations[Key]["output"]>;
async function executeStandingIntent(
  params: { agentId: string; assertCurrent?: () => void },
  command: SqliteWorkerCommand<StandingIntentOperations>,
  options: DatabaseOptions = captureMemoryAgentDatabaseOptions(params.agentId),
): Promise<StandingIntentOperations[keyof StandingIntentOperations]["output"]> {
  const assertCurrent = params.assertCurrent;
  return runQueuedStoreWrite({
    queues: operationQueues,
    storePath: options.path,
    label: "Standing intent",
    async fn() {
      assertCurrent?.();
      const facts = lifecycleFacts.get(options.path);
      if (command.type === "match" && facts?.empty) {
        return [];
      }
      // Sweeps only maintain stored rows. Opening a missing SQLite agent database would
      // create and prepare it during Gateway startup, before any agent has used it.
      if (command.type === "sweep" && (await isMissingSqliteAgentDatabase(options.path))) {
        assertCurrent?.();
        if (facts) {
          facts.empty = true;
        }
        recordDueAt(options.path, Infinity);
        return undefined;
      }
      // Keep committed absence in owner order with creates and lifecycle transitions.
      if (facts) {
        facts.empty = false;
      }
      const worker = await openOpenClawAgentSqliteWorkerStoreV2<StandingIntentWorkerOperations>(
        options,
        { version: 2, assertCurrent: () => assertCurrent?.() },
        {
          moduleUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.standingIntents),
          input: undefined,
        },
      );
      try {
        await worker.prepare();
        const result = await worker.execute(command, () => assertCurrent?.());
        if (facts) {
          facts.empty = result.nextDueAt === Infinity;
        }
        recordDueAt(options.path, result.nextDueAt);
        return result.value;
      } finally {
        await worker.close();
      }
    },
  });
}

export function startStandingIntentMaintenance(params: {
  agentIds: string[];
  scheduler: PluginServiceSchedulerV1;
  warn: (message: string) => void;
}): () => void {
  const { scheduler } = params;
  const targets = new Map(
    params.agentIds.map((agentId) => {
      const options = captureMemoryAgentDatabaseOptions(agentId);
      return [options.path, { agentId, options, facts: { empty: false } }] as const;
    }),
  );
  const jobs = new Map<string, ReturnType<PluginServiceSchedulerV1["schedule"]>>();
  const schedule = (path: string, nextDueAt: number | null) => {
    const target = targets.get(path);
    if (!target || !maintenance.owners.has(schedule) || scheduler.signal.aborted) {
      return;
    }
    jobs.get(path)?.cancel();
    jobs.delete(path);
    if (nextDueAt === Infinity) {
      return;
    }
    jobs.set(
      path,
      scheduler.schedule({
        id: path,
        atMs: nextDueAt ?? scheduler.now(),
        async run() {
          try {
            await withSweepSlot(() =>
              executeStandingIntent(
                { agentId: target.agentId, assertCurrent: () => scheduler.signal.throwIfAborted() },
                { type: "sweep", input: { nowMs: scheduler.now() } },
                target.options,
              ),
            );
          } catch (error) {
            if (!scheduler.signal.aborted) {
              params.warn(`memory-core: standing intent maintenance failed: ${String(error)}`);
              schedule(path, scheduler.now() + 30_000);
            }
          }
        },
      }),
    );
  };
  // Known deadlines are already overdue-safe: a past deadline runs immediately. Only databases
  // without one (first start, added agents, failed sweeps) need a recovery sweep now.
  const scheduleKnown = (path: string) => schedule(path, knownDueAt.get(path) ?? null);
  maintenance.owners.set(schedule, () => {
    for (const path of targets.keys()) {
      scheduleKnown(path);
    }
  });
  maintenance.schedule = schedule;
  for (const [path, { facts }] of targets) {
    lifecycleFacts.set(path, facts);
    scheduleKnown(path);
  }
  return () => {
    maintenance.owners.delete(schedule);
    if (maintenance.schedule === schedule) {
      const predecessor = [...maintenance.owners].at(-1);
      maintenance.schedule = predecessor?.[0];
      predecessor?.[1]();
    }
    for (const job of jobs.values()) {
      job.cancel();
    }
    for (const [path, { facts }] of targets) {
      if (lifecycleFacts.get(path) === facts) {
        lifecycleFacts.delete(path);
      }
    }
  };
}

export async function createStandingIntent(params: {
  agentId: string;
  assertCurrent?: () => void;
  description: string;
  triggerKeywords: string[];
  channelScope?: string | null;
  senderScope?: string | null;
  creatorSender: string;
  expiresAt?: number;
  maxFires?: number;
  cooldownSeconds?: number;
  sourceSessionId?: string | null;
  nowMs?: number;
}): Promise<StandingIntent> {
  const nowMs = params.nowMs ?? Date.now();
  const row: StandingIntentRow = {
    id: randomUUID(),
    description: params.description,
    trigger_keywords: JSON.stringify(params.triggerKeywords),
    trigger_embedding: null,
    channel_scope: params.channelScope ?? null,
    sender_scope: params.senderScope ?? null,
    creator_sender: normalizeCreatorSender(params.creatorSender),
    status: "armed",
    expires_at: params.expiresAt ?? nowMs + DEFAULT_INTENT_EXPIRY_MS,
    max_fires: params.maxFires ?? DEFAULT_INTENT_MAX_FIRES,
    fire_count: 0,
    cooldown_seconds: params.cooldownSeconds ?? DEFAULT_INTENT_COOLDOWN_SECONDS,
    last_fired_at: null,
    created_at: nowMs,
    source_session_id: params.sourceSessionId ?? null,
  };
  return executeStandingIntent(params, { type: "create", input: row });
}

export async function listStandingIntents(params: {
  agentId: string;
  assertCurrent?: () => void;
  status?: StandingIntentStatus;
  nowMs?: number;
}): Promise<StandingIntent[]> {
  return executeStandingIntent(params, {
    type: "list",
    input: { status: params.status, nowMs: params.nowMs },
  });
}

export async function cancelStandingIntent(params: {
  agentId: string;
  assertCurrent?: () => void;
  id: string;
}): Promise<StandingIntent | null> {
  return executeStandingIntent(params, { type: "cancel", input: { id: params.id } });
}

export async function matchStandingIntents(params: {
  agentId: string;
  prompt: string;
  channel?: string;
  provider?: string;
  accountId?: string;
  senderId?: string;
  nowMs?: number;
  assertCurrent?: () => void;
}): Promise<StandingIntent[]> {
  const input = prepareStandingIntentMatch(params);
  return input ? executeStandingIntent(params, { type: "match", input }) : [];
}
