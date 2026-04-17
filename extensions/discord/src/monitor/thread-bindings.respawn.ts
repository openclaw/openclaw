import {
  isSpawnAcpAcceptedResult,
  spawnAcpDirect,
  type SpawnAcpContext,
  type SpawnAcpParams,
} from "openclaw/plugin-sdk/acp-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { SessionBindingRecord } from "openclaw/plugin-sdk/conversation-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { maybeSendBindingMessage } from "./thread-bindings.discord-api.js";
import { toSessionBindingRecord } from "./thread-bindings.manager.js";
import type { ThreadBindingManager } from "./thread-bindings.types.js";

/**
 * Narrow manager interface required by respawn. Accepts the full
 * `ThreadBindingManager` at runtime, but the type surface stays minimal to
 * match the wider `DiscordThreadBindingLookup` shape used elsewhere. Callers
 * pass the real manager through; tests can stub only what this helper needs.
 */
export type RespawnThreadBindingManagerLike = Pick<
  ThreadBindingManager,
  "accountId" | "getByThreadId" | "bindTarget" | "getIdleTimeoutMs" | "getMaxAgeMs"
>;

const log = createSubsystemLogger("discord/thread-bindings-respawn");

/**
 * Phase 11 P3: per-thread mutex so concurrent inbound messages landing on the
 * same bound thread with a stale/dead session only trigger ONE respawn. The
 * second/third inbound awaits the in-flight respawn and then uses the new
 * binding record — no duplicate ACP children, no duplicate banners.
 */
const RESPAWN_IN_FLIGHT_BY_THREAD = new Map<string, Promise<RespawnBoundAcpThreadResult>>();

export type RespawnBoundAcpThreadInput = {
  cfg: OpenClawConfig;
  /** The stale/ended/dead binding that needs respawning. */
  binding: SessionBindingRecord;
  /** The Discord thread binding manager (own local state, preserves webhook). */
  threadBindingsManager: RespawnThreadBindingManagerLike;
  /** Inbound message that triggered the respawn, used for the banner. */
  triggeringMessagePreview?: string;
  /** Optional override for the new label; defaults to existing label + "-restart". */
  labelSuffix?: string;
};

export type RespawnBoundAcpThreadResult =
  | {
      ok: true;
      newBinding: SessionBindingRecord;
      newSessionKey: string;
      agentId: string;
    }
  | {
      ok: false;
      error: string;
      errorCode: "respawn_failed" | "missing_agent_id" | "missing_thread_id";
    };

function resolveRespawnAgentId(binding: SessionBindingRecord): string | undefined {
  const metadataAgentId = normalizeOptionalString(
    typeof binding.metadata?.agentId === "string" ? binding.metadata.agentId : undefined,
  );
  if (metadataAgentId) {
    return metadataAgentId;
  }
  // Fallback: derive from the old session key.
  const derived = normalizeOptionalString(resolveAgentIdFromSessionKey(binding.targetSessionKey));
  return derived || undefined;
}

function resolveRespawnLabel(params: {
  binding: SessionBindingRecord;
  suffix: string;
}): string | undefined {
  const raw = normalizeOptionalString(
    typeof params.binding.metadata?.label === "string" ? params.binding.metadata.label : undefined,
  );
  if (!raw) {
    return params.suffix ? params.suffix.trim() : undefined;
  }
  if (!params.suffix) {
    return raw;
  }
  // Avoid repeatedly suffixing the same thread across multiple restarts.
  return raw.endsWith(params.suffix) ? raw : `${raw}${params.suffix}`;
}

async function doRespawn(input: RespawnBoundAcpThreadInput): Promise<RespawnBoundAcpThreadResult> {
  const conversation = input.binding.conversation;
  const threadId = normalizeOptionalString(conversation.conversationId);
  if (!threadId) {
    return { ok: false, errorCode: "missing_thread_id", error: "bound thread id missing" };
  }
  const agentId = resolveRespawnAgentId(input.binding);
  if (!agentId) {
    return { ok: false, errorCode: "missing_agent_id", error: "bound agent id missing" };
  }

  const manager = input.threadBindingsManager;
  const existingLocal = manager.getByThreadId(threadId);
  const channelId = normalizeOptionalString(existingLocal?.channelId) ?? threadId;
  const label = resolveRespawnLabel({
    binding: input.binding,
    suffix: normalizeOptionalString(input.labelSuffix) ?? "-restart",
  });
  const idleTimeoutMs = manager.getIdleTimeoutMs();
  const maxAgeMs = manager.getMaxAgeMs();

  // Spawn a fresh ACP child. We deliberately use placement="current" so the
  // spawn path does NOT create a brand-new Discord thread — we will rebind the
  // new session to the existing thread below (which preserves the webhook).
  // We use a zero-text task that is never actually dispatched as user-visible
  // work; the real triggering message is delivered by the inbound worker after
  // rebind returns.
  const spawnParams: SpawnAcpParams = {
    task: "__thread_respawn__",
    agentId,
    mode: "session",
    thread: true,
    label,
  };
  const spawnCtx: SpawnAcpContext = {
    agentChannel: conversation.channel,
    agentAccountId: conversation.accountId,
    agentTo: `channel:${threadId}`,
    agentThreadId: threadId,
  };

  let spawnResult;
  try {
    spawnResult = await spawnAcpDirect(spawnParams, spawnCtx);
  } catch (err) {
    log.warn("thread respawn: spawnAcpDirect threw", {
      threadId,
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      errorCode: "respawn_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!isSpawnAcpAcceptedResult(spawnResult)) {
    log.warn("thread respawn: spawn rejected", {
      threadId,
      agentId,
      errorCode: spawnResult.errorCode,
      error: spawnResult.error,
    });
    return {
      ok: false,
      errorCode: "respawn_failed",
      error: `${spawnResult.errorCode}: ${spawnResult.error}`,
    };
  }
  const newSessionKey = spawnResult.childSessionKey;

  // Rebind in-place: same threadId, same channelId, new sessionKey.
  // bindTarget's existing webhook-credential reuse (lines 469-491 in
  // thread-bindings.manager.ts) preserves the ⚙ webhook identity byte-equal.
  // This also clears any endedAt/endedReason (new record omits them).
  const existingMetadata =
    (existingLocal?.metadata && typeof existingLocal.metadata === "object"
      ? { ...existingLocal.metadata }
      : undefined) ?? {};
  const rebound = await manager.bindTarget({
    threadId,
    channelId,
    createThread: false,
    targetKind: "acp",
    targetSessionKey: newSessionKey,
    agentId,
    label,
    boundBy: "system",
    metadata: {
      ...existingMetadata,
      agentId,
      ...(label ? { label } : {}),
      restartedAt: Date.now(),
      previousSessionKey: input.binding.targetSessionKey,
    },
  });

  if (!rebound) {
    return {
      ok: false,
      errorCode: "respawn_failed",
      error: "thread rebind in-place failed after spawn",
    };
  }

  // Post a "session restarted" banner via the webhook identity (preserves ⚙).
  const bannerText = "⚙️ Session restarted. Picking up from your message.";
  try {
    await maybeSendBindingMessage({
      cfg: input.cfg,
      record: rebound,
      text: bannerText,
    });
  } catch (err) {
    // Banner failure is non-fatal; routing still proceeds to the new session.
    log.warn("thread respawn: banner send failed", {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const nextRecord = toSessionBindingRecord(rebound, {
    idleTimeoutMs,
    maxAgeMs,
  });

  log.info("thread respawn: rebind complete", {
    threadId,
    channelId,
    agentId,
    previousSessionKey: input.binding.targetSessionKey,
    newSessionKey,
  });

  return {
    ok: true,
    newBinding: nextRecord,
    newSessionKey,
    agentId,
  };
}

/**
 * Respawn a fresh ACP child for a thread whose previously-bound session is
 * stale/ended. Rebinds in place on the same thread, preserves webhook creds,
 * posts a banner, and returns the new session binding record so the caller
 * can route the current inbound message to the new child.
 *
 * Race protection: concurrent calls for the same threadId share one in-flight
 * Promise. Only one ACP child is spawned; all concurrent inbounds receive the
 * same new binding.
 */
export async function respawnBoundAcpThread(
  input: RespawnBoundAcpThreadInput,
): Promise<RespawnBoundAcpThreadResult> {
  const threadId = normalizeOptionalString(input.binding.conversation.conversationId);
  if (!threadId) {
    return { ok: false, errorCode: "missing_thread_id", error: "bound thread id missing" };
  }
  const existing = RESPAWN_IN_FLIGHT_BY_THREAD.get(threadId);
  if (existing) {
    return await existing;
  }
  const promise = doRespawn(input).finally(() => {
    RESPAWN_IN_FLIGHT_BY_THREAD.delete(threadId);
  });
  RESPAWN_IN_FLIGHT_BY_THREAD.set(threadId, promise);
  return await promise;
}

export const __testing = {
  clearInFlightRespawns() {
    RESPAWN_IN_FLIGHT_BY_THREAD.clear();
  },
};
