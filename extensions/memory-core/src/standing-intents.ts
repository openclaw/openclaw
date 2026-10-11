import { randomUUID } from "node:crypto";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  openOpenClawAgentSqliteWorkerStore,
  runOpenClawAgentWriteAdmission,
  withOpenClawAgentDatabaseRuntime,
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
): Promise<StandingIntentOperations[Key]["output"]> {
  const assertCurrent = params.assertCurrent;
  assertCurrent?.();
  const capturedCommand = structuredClone(command);
  const options = captureMemoryAgentDatabaseOptions(params.agentId);
  return runOpenClawAgentWriteAdmission(
    options,
    async (_identity, assertAdmission) =>
      // Caller expiry refuses its operation, never a coalesced physical open.
      withOpenClawAgentDatabaseRuntime(
        options,
        async ({ db }) => {
          assertCurrent?.();
          const worker = await openOpenClawAgentSqliteWorkerStore<StandingIntentWorkerOperations>(
            options,
            db,
            {
              moduleUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.standingIntents),
              input: undefined,
            },
          );
          try {
            const assertPublication = () => {
              assertAdmission();
              assertCurrent?.();
            };
            let result = await worker.execute(capturedCommand, assertPublication);
            if (result.kind === "schema-prepared") {
              // Only confirmed schema-only completion permits the separate business dispatch.
              result = await worker.execute(capturedCommand, assertPublication);
            }
            if (result.kind === "schema-prepared") {
              throw new Error("Standing-intent schema changed before its business operation");
            }
            return result.value;
          } finally {
            await worker.close();
          }
        },
        assertAdmission,
      ),
    true,
  );
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

export async function sweepStandingIntents(params: {
  agentId: string;
  nowMs?: number;
}): Promise<void> {
  return executeStandingIntent(params, { type: "sweep", input: { nowMs: params.nowMs } });
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
