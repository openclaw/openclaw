/**
 * Resolves command session lifecycle and persisted thinking state.
 */
import crypto from "node:crypto";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../../auto-reply/thinking.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { hasProviderOwnedSession } from "../../config/sessions/entry-freshness.js";
import {
  hasTerminalMainSessionTranscriptNewerThanRegistrySync,
  resolveSessionLifecycleTimestamps,
} from "../../config/sessions/lifecycle.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
} from "../../config/sessions/reset-policy.js";
import { resolveChannelResetConfig, resolveSessionResetType } from "../../config/sessions/reset.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { isModelSelectionLocked } from "../../sessions/model-overrides.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { resolveDefaultAgentId } from "../agent-scope-config.js";
import { clearBootstrapSnapshotOnSessionRollover } from "../bootstrap-cache.js";
import { clearAllCliSessions } from "../cli-session.js";
import { transitionMainSessionRecovery } from "../main-session-recovery/main-session-recovery-state.js";
import { resolveSessionKeyForRequestCore } from "./session-request.js";

export {
  buildExplicitSessionIdSessionKey,
  resolveExistingSessionKeyForRequest,
  resolveSessionKeyForRequestCore,
  resolveStoredSessionKeyForSessionId,
} from "./session-request.js";

/** Resolved command session identity plus backing store metadata. */
type SessionResolution = {
  sessionAgentId: string;
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: InternalSessionEntry;
  storePath: string;
  isNewSession: boolean;
  previousSessionId?: string;
  persistedThinking?: ThinkLevel;
  persistedVerbose?: VerboseLevel;
};

export function clearRotatedSessionMetadata(entry: InternalSessionEntry): InternalSessionEntry {
  const next = {
    ...entry,
    sessionFile: undefined,
    status: undefined,
    lifecycleRunId: undefined,
    lastRunId: undefined,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    abortedLastRun: undefined,
    restartRecoveryForceSafeTools: undefined,
    restartRecoveryDeliveryContext: undefined,
    restartRecoveryDeliveryMediaUrls: undefined,
    restartRecoveryDisableMessageTool: undefined,
    restartRecoverySuppressTextDelivery: undefined,
    restartRecoveryDeliveryRequestFingerprint: undefined,
    restartRecoveryDeliveryRunId: undefined,
    restartRecoveryDeliverySourceRunId: undefined,
    restartRecoveryBeforeAgentReplyState: undefined,
    restartRecoveryDeliveryReceiptState: undefined,
    restartRecoveryDeliveryToolCallId: undefined,
    restartRecoveryRequesterAccountId: undefined,
    restartRecoveryRequesterSenderId: undefined,
    restartRecoverySameChannelThreadRequired: undefined,
    restartRecoverySourceIngress: undefined,
    restartRecoverySourceReplyDeliveryMode: undefined,
    restartRecoveryTerminalDeliveryEvidence: undefined,
    restartRecoveryTerminalRunIds: undefined,
    sessionStartedAt: undefined,
    sessionDiffBaseline: undefined,
    sessionDiffBaselineCapture: undefined,
    lastInteractionAt: undefined,
    pendingTranscriptRepair: undefined,
  };
  transitionMainSessionRecovery(next, { kind: "clear" });
  clearAllCliSessions(next);
  return next;
}

/** Resolves or creates the session used by one agent command request. */
export function resolveSession(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionResolution {
  const sessionCfg = opts.cfg.session;
  const {
    agentId: resolvedAgentId,
    sessionKey,
    sessionEntry,
    storePath,
  } = resolveSessionKeyForRequestCore({
    cfg: opts.cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    agentId: opts.agentId,
  });
  const now = Date.now();

  const sessionAgentId =
    (opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : undefined) ??
    resolvedAgentId ??
    parseAgentSessionKey(sessionKey)?.agentId ??
    tryResolveLegacyCompatibilityAgentId(opts.cfg) ??
    resolveDefaultAgentId(opts.cfg, {
      surface: "agent command session ownership",
      hint: "Pass --agent <id> or an agent-prefixed --session-key.",
    });

  const resetType = resolveSessionResetType({ sessionKey });
  const channelReset = resolveChannelResetConfig({
    sessionCfg,
    channel: sessionDeliveryChannel(sessionEntry),
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    resetOverride: channelReset,
  });
  const requestedSessionId = opts.sessionId?.trim() || undefined;
  const terminalMainTranscriptNewerThanRegistry =
    sessionEntry && !requestedSessionId
      ? hasTerminalMainSessionTranscriptNewerThanRegistrySync({
          entry: sessionEntry,
          sessionScope: sessionCfg?.scope,
          sessionKey,
          agentId: sessionAgentId,
          mainKey: sessionCfg?.mainKey,
          storePath,
        })
      : false;
  const lockedModelSelection = isModelSelectionLocked(sessionEntry);
  const skipImplicitExpiry =
    resetPolicy.configured !== true && hasProviderOwnedSession(sessionEntry);
  const fresh = sessionEntry
    ? lockedModelSelection ||
      (!terminalMainTranscriptNewerThanRegistry &&
        (skipImplicitExpiry ||
          evaluateSessionFreshness({
            updatedAt: sessionEntry.updatedAt,
            ...resolveSessionLifecycleTimestamps({
              entry: sessionEntry,
              agentId: sessionAgentId,
              sessionKey,
              storePath,
            }),
            now,
            policy: resetPolicy,
          }).fresh))
    : false;
  const sessionId =
    requestedSessionId || (fresh ? sessionEntry?.sessionId : undefined) || crypto.randomUUID();
  const isNewSession = !fresh && !requestedSessionId;
  const resolvedSessionEntry =
    isNewSession && sessionEntry ? clearRotatedSessionMetadata(sessionEntry) : sessionEntry;

  clearBootstrapSnapshotOnSessionRollover({
    sessionKey,
    previousSessionId: isNewSession ? sessionEntry?.sessionId : undefined,
  });

  // Behavior overrides belong to the logical session, not one transcript id.
  // Carry them across every rollover; explicit `default` directives clear them.
  const persistedThinking = sessionEntry?.thinkingLevel
    ? normalizeThinkLevel(sessionEntry.thinkingLevel)
    : undefined;
  const persistedVerbose = sessionEntry?.verboseLevel
    ? normalizeVerboseLevel(sessionEntry.verboseLevel)
    : undefined;

  return {
    sessionAgentId,
    sessionId,
    sessionKey,
    sessionEntry: resolvedSessionEntry,
    storePath,
    isNewSession,
    previousSessionId: isNewSession ? sessionEntry?.sessionId : undefined,
    persistedThinking,
    persistedVerbose,
  };
}
