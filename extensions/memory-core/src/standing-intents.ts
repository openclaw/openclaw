import { randomUUID } from "node:crypto";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { openOpenClawAgentSqliteWorkerStoreV2 } from "openclaw/plugin-sdk/sqlite-runtime";
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
const lifecycleListeners = new Set<(path: string, nextDueAt: number | null) => void>();

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

async function executeStandingIntent<Key extends keyof StandingIntentOperations>(
  params: { agentId: string; assertCurrent?: () => void },
  command: { type: Key; input: StandingIntentOperations[Key]["input"] },
  options: DatabaseOptions = captureMemoryAgentDatabaseOptions(params.agentId),
): Promise<StandingIntentOperations[Key]["output"]> {
  const assertCurrent = params.assertCurrent;
  assertCurrent?.();
  const capturedCommand = structuredClone(command);
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
    let result = await worker.execute(capturedCommand, () => assertCurrent?.());
    if (result.kind === "schema-prepared") {
      // Only confirmed schema-only completion permits the separate business dispatch.
      result = await worker.execute(capturedCommand, () => assertCurrent?.());
    }
    if (result.kind === "schema-prepared") {
      throw new Error("Standing-intent schema changed before its business operation");
    }
    for (const listener of lifecycleListeners) {
      listener(options.path, result.nextDueAt);
    }
    return result.value;
  } finally {
    await worker.close();
  }
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
      return [options.path, { agentId, options }] as const;
    }),
  );
  const jobs = new Map<string, ReturnType<PluginServiceSchedulerV1["schedule"]>>();
  const schedule = (path: string, nextDueAt: number | null) => {
    const target = targets.get(path);
    if (!target || scheduler.signal.aborted) {
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
            await executeStandingIntent(
              { agentId: target.agentId, assertCurrent: () => scheduler.signal.throwIfAborted() },
              { type: "sweep", input: { nowMs: scheduler.now() } },
              target.options,
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
  lifecycleListeners.add(schedule);
  // Restart must process overdue expiry/cooldown before trusting a retained deadline.
  for (const path of targets.keys()) {
    schedule(path, null);
  }
  return () => {
    lifecycleListeners.delete(schedule);
    for (const job of jobs.values()) {
      job.cancel();
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
