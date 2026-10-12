import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  resolveSessionTranscriptRuntimeTarget,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import { resolveSessionKeyBySessionIdAsync } from "../config/sessions/session-accessor.transcript-target.js";
import type { SessionTranscriptRuntimeScope } from "../config/sessions/session-accessor.types.js";
import { readSessionEntrySummariesInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { captureIncognitoSessionSource } from "../config/sessions/session-incognito-binding.js";
import { resolvePersistedSessionStoreOwnerForTarget } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey, toAgentStoreSessionKey } from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import {
  resolveExistingSessionKeyForRequest,
  resolveStoredSessionKeyForSessionId,
} from "./command/session.js";
import type { AgentRunSessionTarget } from "./run-session-target.types.js";

/** Canonical SQLite target resolved from the storage-neutral run identity. */
type ResolvedAgentRunSessionTarget = SessionTranscriptRuntimeTarget;

class AgentRunSessionTargetResolutionError extends Error {
  readonly code = "session-key-missing";

  constructor(sessionId: string) {
    super(`Cannot resolve a session key for existing session: ${sessionId}`);
    this.name = "AgentRunSessionTargetResolutionError";
  }
}

/** Resolves the active runtime target used by current run/session internals. */
export async function resolveAgentRunSessionTarget(
  input: {
    agentId?: string;
    config?: OpenClawConfig;
    missingSessionKey: "create" | "resolve-existing";
    sessionId: string;
    sessionFile?: string;
    sessionKey?: string;
    sessionTarget?: AgentRunSessionTarget;
  },
  prepareTarget?: (scope: SessionTranscriptRuntimeScope) => Promise<{
    target: SessionTranscriptRuntimeTarget;
    assertCurrent: () => void;
  }>,
): Promise<ResolvedAgentRunSessionTarget> {
  const params = {
    ...input,
    sessionTarget: input.sessionTarget ? { ...input.sessionTarget } : undefined,
  };
  const config = params.config ?? getRuntimeConfig();
  const sessionTarget = params.sessionTarget;
  const targetAgentId = normalizeOptionalString(sessionTarget?.agentId);
  const targetSessionId = normalizeOptionalString(sessionTarget?.sessionId);
  const targetSessionKey = normalizeOptionalString(sessionTarget?.sessionKey);
  const targetStorePath = normalizeOptionalString(sessionTarget?.storePath);
  const hasCompleteTypedTarget = Boolean(
    targetAgentId && targetSessionId && targetSessionKey && targetStorePath,
  );
  const legacySessionFile = normalizeOptionalString(params.sessionFile);
  const suppliedSessionKey = normalizeOptionalString(params.sessionKey);
  const legacyMarker = parseSqliteSessionFileMarker(legacySessionFile);
  const recognizedCompatibilityKey = Boolean(
    legacySessionFile?.startsWith("agent:") || legacySessionFile?.startsWith("in-memory:"),
  );
  const fileBackedCompatibilityValue = Boolean(
    legacySessionFile &&
    !recognizedCompatibilityKey &&
    (path.isAbsolute(legacySessionFile) ||
      legacySessionFile.includes("/") ||
      legacySessionFile.includes("\\") ||
      legacySessionFile.endsWith(".jsonl")),
  );
  const plainCompatibilitySessionKey =
    !fileBackedCompatibilityValue && legacySessionFile === (targetSessionId ?? params.sessionId)
      ? legacySessionFile
      : undefined;
  if (
    !hasCompleteTypedTarget &&
    legacySessionFile &&
    !legacyMarker &&
    (fileBackedCompatibilityValue ||
      (!plainCompatibilitySessionKey &&
        !recognizedCompatibilityKey &&
        legacySessionFile !== suppliedSessionKey &&
        legacySessionFile !== targetSessionKey))
  ) {
    throw new Error(
      "File-backed transcript targets are unsupported; migrate the session to SQLite first",
    );
  }
  const agentId = targetAgentId ?? legacyMarker?.agentId ?? params.agentId;
  const sessionId = targetSessionId ?? legacyMarker?.sessionId ?? params.sessionId;
  const recognizedCompatibilitySessionKey = recognizedCompatibilityKey
    ? legacySessionFile
    : undefined;
  const compatibilitySessionKey =
    recognizedCompatibilitySessionKey ??
    (params.missingSessionKey === "create" ? plainCompatibilitySessionKey : undefined);
  const activeMarker = hasCompleteTypedTarget ? undefined : legacyMarker;
  const markerSource = activeMarker ? captureIncognitoSessionSource(activeMarker) : undefined;
  const markerEntries = activeMarker
    ? markerSource && "kind" in markerSource
      ? []
      : await readSessionEntrySummariesInWorker({
          agentId: activeMarker.agentId,
          storePath: activeMarker.storePath,
        })
    : [];
  const markerMatches = activeMarker
    ? markerEntries.filter(({ entry }) => entry.sessionId === activeMarker.sessionId)
    : [];
  const markerSessionKey = activeMarker
    ? resolvePreferredSessionKeyForSessionIdMatches(
        markerMatches.map(({ sessionKey, entry }) => [sessionKey, entry]),
        activeMarker.sessionId,
      )
    : undefined;
  if (
    activeMarker &&
    !targetSessionKey &&
    !suppliedSessionKey &&
    markerMatches.length > 0 &&
    !markerSessionKey
  ) {
    throw new Error("Legacy SQLite transcript marker session key is ambiguous");
  }
  const preliminarySessionKey =
    targetSessionKey ?? suppliedSessionKey ?? compatibilitySessionKey ?? markerSessionKey;
  const preliminaryCompatibilityKeyAgentId = parseAgentSessionKey(compatibilitySessionKey)?.agentId;
  if (
    !targetSessionKey &&
    !suppliedSessionKey &&
    preliminarySessionKey === compatibilitySessionKey &&
    preliminaryCompatibilityKeyAgentId &&
    agentId &&
    preliminaryCompatibilityKeyAgentId !== agentId
  ) {
    throw new Error("Compatibility session key conflicts with the supplied agent identity");
  }
  const targetStoreOwner = resolvePersistedSessionStoreOwnerForTarget({
    config,
    sessionKey: preliminarySessionKey,
    storePath: targetStorePath,
  });
  const trustExplicitAlternateStoreAgent = Boolean(
    targetAgentId &&
    targetStorePath &&
    !parseAgentSessionKey(preliminarySessionKey)?.agentId &&
    targetStoreOwner.kind === "none",
  );
  const shouldResolveConfiguredStoreRow =
    params.missingSessionKey === "resolve-existing" &&
    !preliminarySessionKey &&
    !targetStorePath &&
    !legacyMarker;
  const configuredStoreResolution = shouldResolveConfiguredStoreRow
    ? agentId
      ? resolveStoredSessionKeyForSessionId({
          cfg: config,
          sessionId,
          agentId,
        })
      : resolveExistingSessionKeyForRequest({ cfg: config, sessionId })
    : undefined;
  const fixedAgentId =
    (hasCompleteTypedTarget || trustExplicitAlternateStoreAgent ? targetAgentId : undefined) ??
    legacyMarker?.agentId ??
    configuredStoreResolution?.agentId;
  const lookupAgentId =
    fixedAgentId ??
    resolveSessionAgentId({
      agentId: targetAgentId ?? params.agentId,
      config,
      sessionKey:
        preliminarySessionKey ?? (params.missingSessionKey === "create" ? sessionId : undefined),
    });
  const lookupStorePath =
    targetStorePath ??
    legacyMarker?.storePath ??
    configuredStoreResolution?.storePath ??
    resolveSessionStorePathCore(config.session?.store, { agentId: lookupAgentId });
  const storedSessionKey =
    configuredStoreResolution?.sessionKey ??
    (params.missingSessionKey === "resolve-existing" &&
    !preliminarySessionKey &&
    !shouldResolveConfiguredStoreRow
      ? await resolveSessionKeyBySessionIdAsync({
          agentId: lookupAgentId,
          sessionId,
          storePath: lookupStorePath,
        })
      : undefined);
  const createdSessionKey =
    params.missingSessionKey === "create"
      ? toAgentStoreSessionKey({ agentId: lookupAgentId, requestKey: sessionId })
      : undefined;
  const sessionKey = preliminarySessionKey ?? storedSessionKey ?? createdSessionKey;
  const suppliedKeyAgentId = parseAgentSessionKey(suppliedSessionKey)?.agentId;
  const targetKeyAgentId = parseAgentSessionKey(targetSessionKey)?.agentId;
  const candidateMarkerKey = targetSessionKey ?? suppliedSessionKey;
  const candidateMarkerEntry = candidateMarkerKey
    ? markerEntries.find(({ sessionKey: candidateKey }) => candidateKey === candidateMarkerKey)
        ?.entry
    : undefined;
  if (
    activeMarker &&
    ((targetAgentId && targetAgentId !== activeMarker.agentId) ||
      (targetSessionId && targetSessionId !== activeMarker.sessionId) ||
      (params.agentId && params.agentId !== activeMarker.agentId) ||
      (targetKeyAgentId && targetKeyAgentId !== activeMarker.agentId) ||
      (suppliedKeyAgentId && suppliedKeyAgentId !== activeMarker.agentId) ||
      (targetStorePath && path.resolve(targetStorePath) !== path.resolve(activeMarker.storePath)))
  ) {
    throw new Error("Legacy SQLite transcript marker conflicts with the supplied session identity");
  }
  if (
    activeMarker &&
    candidateMarkerKey &&
    candidateMarkerEntry &&
    candidateMarkerEntry.sessionId !== activeMarker.sessionId
  ) {
    throw new Error("Legacy SQLite transcript marker conflicts with the supplied session key");
  }
  if (!sessionKey) {
    throw new AgentRunSessionTargetResolutionError(sessionId);
  }
  const effectiveAgentId =
    fixedAgentId ??
    resolveSessionAgentId({
      agentId: targetAgentId ?? params.agentId,
      config,
      fallbackAgentId: lookupAgentId,
      sessionKey,
    });
  const storePath =
    targetStorePath ??
    legacyMarker?.storePath ??
    resolveSessionStorePathCore(config.session?.store, { agentId: effectiveAgentId });
  const scope = {
    ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
    sessionId,
    sessionKey,
    storePath,
    ...(sessionTarget?.threadId !== undefined ? { threadId: sessionTarget.threadId } : {}),
  };
  const prepared = prepareTarget ? await prepareTarget(scope) : undefined;
  const target = prepared?.target ?? (await resolveSessionTranscriptRuntimeTarget(scope));
  prepared?.assertCurrent();
  return target;
}

/** Applies identity fields from the explicit target before legacy backfills run. */
export function applyAgentRunSessionTargetIdentity<
  T extends {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
    sessionTarget?: AgentRunSessionTarget;
  },
>(params: T): T {
  const target = params.sessionTarget;
  if (!target) {
    return params;
  }
  return {
    ...params,
    agentId: normalizeOptionalString(target.agentId) ?? params.agentId,
    sessionId: normalizeOptionalString(target.sessionId) ?? params.sessionId,
    sessionKey: normalizeOptionalString(target.sessionKey) ?? params.sessionKey,
  };
}
