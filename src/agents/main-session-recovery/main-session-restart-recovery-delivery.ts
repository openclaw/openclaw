import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveRestartRecoveryChannelAuthority } from "../../config/sessions/restart-recovery-state.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isTrustedMessageActionTurnIngress } from "../../gateway/message-action-turn-capability.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import {
  deliveryContextKey,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";

export function hasRestartRecoveryMessageActionAuthority(entry: SessionEntry): boolean {
  const authority = resolveRestartRecoveryChannelAuthority(entry);
  // Keep the pre-dispatch gate identical to recovered capability minting.
  return (
    authority !== undefined && isTrustedMessageActionTurnIngress(authority.deliveryContext.channel)
  );
}

/** Internal continuations never inherit channel authority; every other message-tool recovery must. */
export function requiresRestartRecoveryMessageActionAuthority(entry: SessionEntry): boolean {
  return (
    entry.restartRecoverySourceReplyDeliveryMode === "message_tool_only" &&
    entry.restartRecoverySourceIngress !== "internal"
  );
}

export function resolveRestartRecoveryDeliveryContext(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  includeSessionDeliveryFallback?: boolean;
  sessionKey: string;
}): (DeliveryContext & { channel: string; to: string }) | undefined {
  const activeRunDeliveryContext = normalizeDeliveryContext(
    params.entry.restartRecoveryDeliveryContext,
  );
  // A claim with no context is intentionally transcript-only. Only legacy
  // rows without a claim may fall back to the session delivery route.
  const hasActiveRunDeliveryClaim =
    normalizeOptionalString(params.entry.restartRecoveryDeliveryRunId) !== undefined;
  const deliveryContext =
    normalizeDeliveryContext(params.entry.pendingFinalDelivery?.context) ??
    activeRunDeliveryContext ??
    (params.includeSessionDeliveryFallback && !hasActiveRunDeliveryClaim
      ? deliveryContextFromSession(params.entry)
      : undefined);
  const channel = normalizeOptionalString(deliveryContext?.channel);
  const to = normalizeOptionalString(deliveryContext?.to);
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  if (
    params.cfg &&
    resolveSendPolicy({
      cfg: params.cfg,
      entry: params.entry,
      sessionKey: params.sessionKey,
      channel,
      chatType: params.entry.chatType,
    }) === "deny"
  ) {
    return undefined;
  }
  return { ...deliveryContext, channel, to };
}

type RestartRecoveryDeliveryScope = MainSessionRecoveryStoreTarget & {
  sessionId: string;
  recoveryRunId: string;
  lifecycleGeneration: string;
  deliveryContext: DeliveryContext & { channel: string; to: string };
  cfg?: OpenClawConfig;
  shouldContinue?: () => boolean;
};

/** The delivery attempt retains worker facts; committed writes revoke its route or policy. */
export async function prepareRestartRecoveryDeliveryCurrent(
  input: RestartRecoveryDeliveryScope,
): Promise<{ isCurrent: (cfg?: OpenClawConfig) => boolean; release: () => void }> {
  const params = { ...input, deliveryContext: { ...input.deliveryContext } };
  const source = captureIncognitoSessionSource(params);
  const claim =
    source && !("kind" in source)
      ? source.actor.sessions.captureCurrent(params.sessionKey)
      : undefined;
  let entry: SessionEntry | undefined;
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  if (!source) {
    try {
      await withSessionEntryReadOnlyInWorker(
        { ...params, projection: "list" },
        () => {},
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          entry = read.value;
          if (!owner.source) {
            return;
          }
          const project = (value: SessionEntry | undefined) =>
            value && {
              sessionId: value.sessionId,
              abortedLastRun: value.abortedLastRun,
              recoveryRunId: value.restartRecoveryDeliveryRunId,
              sourceReplyMode: value.restartRecoverySourceReplyDeliveryMode,
              context: resolveRestartRecoveryDeliveryContext({
                entry: value,
                sessionKey: params.sessionKey,
              }),
              sendPolicy: value.sendPolicy,
              chatType: value.chatType,
            };
          retained = retainPreparedSessionEntryPredicate({
            databaseIdentity: `file:${owner.source.databaseIdentity}`,
            sessionKey: resolveSqliteSessionKey(params.sessionKey, owner.source.agentId),
            entry,
            matches: (before, after) => isDeepStrictEqual(project(before), project(after)),
          });
        },
      );
    } catch (error) {
      retained?.release();
      throw error;
    }
  }
  const isCurrent = (cfg = params.cfg) => {
    if (
      params.shouldContinue?.() === false ||
      getAgentEventLifecycleGeneration() !== params.lifecycleGeneration
    ) {
      return false;
    }
    if (source && "kind" in source) {
      source.assertCurrent();
      return false;
    }
    source?.admissionSignal?.throwIfAborted();
    claim?.assertCurrent();
    const facts = source?.actor.sessions.readSteering(params.sessionKey);
    const current = source
      ? facts && {
          ...facts,
          restartRecoveryDeliveryContext:
            facts.pendingFinalDeliveryContext ?? facts.restartRecoveryDeliveryContext,
        }
      : retained?.isCurrent()
        ? entry
        : undefined;
    return (
      current?.sessionId === params.sessionId &&
      current.abortedLastRun !== true &&
      current.restartRecoveryDeliveryRunId === params.recoveryRunId &&
      // A retained route is not permission for an automatic resumption notice.
      current.restartRecoverySourceReplyDeliveryMode !== "message_tool_only" &&
      deliveryContextKey(
        resolveRestartRecoveryDeliveryContext({
          cfg,
          entry: current,
          sessionKey: params.sessionKey,
        }),
      ) === deliveryContextKey(params.deliveryContext)
    );
  };
  return { isCurrent, release: () => retained?.release() };
}

export async function announceRestartRecoveryResumption(
  params: RestartRecoveryDeliveryScope & {
    gatewayRuntime: GatewayRecoveryRuntime;
    isCurrent?: (cfg?: OpenClawConfig) => boolean;
  },
): Promise<void> {
  let prepared: Awaited<ReturnType<typeof prepareRestartRecoveryDeliveryCurrent>> | undefined;
  try {
    prepared = params.isCurrent ? undefined : await prepareRestartRecoveryDeliveryCurrent(params);
    const isCurrent = params.isCurrent ?? prepared!.isCurrent;
    if (!isCurrent()) {
      return;
    }
    await params.gatewayRuntime.sendRecoveryNotice({
      ...params.deliveryContext,
      text: "I'm continuing your interrupted request now (the gateway has just restarted).  Don't be concerned with the lack of typing; I am working behind the scenes and I'll send a message when I'm done!",
      idempotencyKey: `main-session-restart-recovery:${params.recoveryRunId}:resumed-notice`,
      liveOnly: true,
      isCurrent,
    });
  } catch (error) {
    // A notice failure must not replay an already admitted recovery turn.
    mainSessionRecoveryLog.warn(
      `failed to announce restart recovery ${params.sessionKey}: ${String(error)}`,
    );
  } finally {
    prepared?.release();
  }
}
