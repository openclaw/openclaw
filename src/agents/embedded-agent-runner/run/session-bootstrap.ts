import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { getReplyOperationSessionReader } from "../../../auto-reply/reply/reply-run-registry.state.js";
import { assertRequiredWorkerSelection } from "../../../config/required-worker-profile.js";
import {
  resolveSessionStorePathCore,
  SESSION_TOTAL_TOKENS_VERSION,
} from "../../../config/sessions.js";
import { parseSqliteSessionFileMarker } from "../../../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  resolveSessionTranscriptRuntimeTarget,
  type SessionTranscriptRuntimeTarget,
} from "../../../config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionTranscriptRuntimeScope } from "../../../config/sessions/session-accessor.types.js";
import { assertSessionEntryCohortScope } from "../../../config/sessions/session-entry-cohort-scope.js";
import { readSessionEntryInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { resolvePersistedSessionStoreOwnerForTarget } from "../../../config/sessions/session-store-owner.js";
import { prepareSessionEntryPresenceRead } from "../../../config/sessions/session-transcript-worker-runtime.js";
import {
  SessionTranscriptWriterClaimReboundError,
  type InitialSessionTranscriptWriter,
  type SessionTranscriptWriterFence,
} from "../../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import type { ContextEngineSessionTarget } from "../../../context-engine/types.js";
import {
  emitAgentEventIfCurrent,
  getAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../../../sessions/session-id-resolution.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import {
  resolveSessionKeyForRequestCore,
  resolveStoredSessionKeyForSessionId,
} from "../../command/session.js";
import {
  applyAgentRunSessionTargetIdentity,
  resolveAgentRunSessionTarget,
} from "../../run-session-target.js";
import {
  AGENT_RUN_SUPERSEDED_ERROR,
  AGENT_RUN_SUPERSEDED_STOP_REASON,
} from "../../run-termination.js";
import { redactRunIdentifier } from "../../workspace-run.js";
import { log } from "../logger.js";
import { supersedeEmbeddedAgentRunByRunId } from "../runs.js";
import type {
  RunEmbeddedAgentInternalParams,
  RunEmbeddedAgentParamsWithSessionFile,
} from "./internal-params.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { resolveAgentHarnessRunAdmissionError } from "./setup.js";

const NO_REAL_CONVERSATION_MESSAGES_REASON = "no real conversation messages";

function resolveSessionTargetAgentId(
  params: Pick<RunEmbeddedAgentParams, "agentId" | "config" | "sessionTarget">,
  sessionKey: string | undefined,
  markerAgentId?: string,
): string {
  const targetAgentId = normalizeOptionalString(params.sessionTarget?.agentId);
  const targetStorePath = normalizeOptionalString(params.sessionTarget?.storePath);
  const targetStoreOwner = resolvePersistedSessionStoreOwnerForTarget({
    config: params.config ?? {},
    sessionKey,
    storePath: targetStorePath,
  });
  if (
    targetAgentId &&
    targetStorePath &&
    !parseAgentSessionKey(sessionKey)?.agentId &&
    targetStoreOwner.kind === "none"
  ) {
    return targetAgentId;
  }
  return (
    markerAgentId ??
    resolveSessionAgentId({
      agentId: targetAgentId ?? params.agentId,
      config: params.config,
      sessionKey,
    })
  );
}

export function buildContextEngineCompactionSessionTarget(params: {
  agentId?: string;
  config?: RunEmbeddedAgentParams["config"];
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: RunEmbeddedAgentParams["sessionTarget"];
}): ContextEngineSessionTarget {
  const targetAgentId = normalizeOptionalString(params.sessionTarget?.agentId);
  const targetSessionId = normalizeOptionalString(params.sessionTarget?.sessionId);
  const targetSessionKey = normalizeOptionalString(params.sessionTarget?.sessionKey);
  const targetStorePath = normalizeOptionalString(params.sessionTarget?.storePath);
  const completeTarget = Boolean(
    targetAgentId && targetSessionId && targetSessionKey && targetStorePath,
  );
  const marker = completeTarget ? undefined : parseSqliteSessionFileMarker(params.sessionFile);
  const suppliedSessionKey = normalizeOptionalString(params.sessionKey);
  const candidateSessionKey = targetSessionKey ?? suppliedSessionKey;
  const candidateKeyAgentId = parseAgentSessionKey(candidateSessionKey)?.agentId;
  const suppliedEntry =
    marker && candidateSessionKey
      ? loadSessionEntryReadOnly({
          agentId: marker.agentId,
          sessionKey: candidateSessionKey,
          storePath: marker.storePath,
        })
      : undefined;
  const markerMatches = marker
    ? listSessionEntriesReadOnly({
        agentId: marker.agentId,
        storePath: marker.storePath,
      }).filter(({ entry }) => entry.sessionId === marker.sessionId)
    : [];
  const preferredMarkerSessionKey = marker
    ? resolvePreferredSessionKeyForSessionIdMatches(
        markerMatches.map(({ sessionKey, entry }) => [sessionKey, entry]),
        marker.sessionId,
      )
    : undefined;
  const markerSessionKey = marker
    ? suppliedEntry?.sessionId === marker.sessionId || (candidateSessionKey && !suppliedEntry)
      ? candidateSessionKey
      : preferredMarkerSessionKey
    : undefined;
  if (marker && markerMatches.length > 0 && !markerSessionKey) {
    throw new Error("Legacy compaction transcript identity is ambiguous");
  }
  if (
    marker &&
    ((targetAgentId && targetAgentId !== marker.agentId) ||
      (targetSessionId && targetSessionId !== marker.sessionId) ||
      (candidateKeyAgentId && candidateKeyAgentId !== marker.agentId) ||
      (targetStorePath && path.resolve(targetStorePath) !== path.resolve(marker.storePath)) ||
      (candidateSessionKey && suppliedEntry && suppliedEntry.sessionId !== marker.sessionId))
  ) {
    throw new Error("Legacy compaction transcript identity is inconsistent");
  }
  const sessionKey = completeTarget
    ? targetSessionKey
    : marker
      ? markerSessionKey
      : (targetSessionKey ?? suppliedSessionKey);
  const agentId = resolveSessionTargetAgentId(params, sessionKey, marker?.agentId);
  const storePath =
    targetStorePath ??
    marker?.storePath ??
    resolveSessionStorePathCore(params.config?.session?.store, { agentId });
  return {
    agentId,
    sessionId: targetSessionId ?? marker?.sessionId ?? params.sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(storePath ? { storePath } : {}),
    ...(params.sessionTarget?.threadId !== undefined
      ? { threadId: params.sessionTarget.threadId }
      : {}),
  };
}

export function isNoRealConversationCompactionNoop(params: {
  ok?: boolean;
  compacted?: boolean;
  reason?: string;
}): boolean {
  return (
    params.ok === true &&
    params.compacted === false &&
    params.reason === NO_REAL_CONVERSATION_MESSAGES_REASON
  );
}

export async function resetNoRealConversationTokenSnapshot(params: {
  sessionTarget: SessionTranscriptRuntimeTarget | undefined;
  sessionPersistence?: RunEmbeddedAgentParams["sessionPersistence"];
  assertActive: () => void;
}): Promise<void> {
  if (!params.sessionTarget || params.sessionPersistence === "detached") {
    return;
  }
  params.assertActive();
  try {
    await patchSessionEntryCore(
      params.sessionTarget,
      () => ({
        totalTokens: 0,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        inputTokens: undefined,
        outputTokens: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        contextBudgetStatus: undefined,
        updatedAt: Date.now(),
      }),
      {
        skipMaintenance: true,
        takeCacheOwnership: true,
        assertCommitAllowed: params.assertActive,
      },
    );
    params.assertActive();
  } catch (err) {
    params.assertActive();
    log.warn(
      `[context-overflow-precheck] failed to reset stale context snapshot for ` +
        `${params.sessionTarget.sessionKey}: ${String(err)}`,
    );
  }
}

/** Best-effort identity lookup retains the agent that owns an unqualified stored key. */
function backfillSessionIdentity(
  params: Pick<RunEmbeddedAgentParams, "config" | "sessionId" | "sessionKey" | "agentId">,
): Pick<RunEmbeddedAgentInternalParams, "agentId" | "sessionKey"> {
  const trimmed = normalizeOptionalString(params.sessionKey);
  if (trimmed) {
    return { sessionKey: trimmed };
  }
  if (!params.config || !params.sessionId) {
    return {};
  }
  try {
    const resolved = normalizeOptionalString(params.agentId)
      ? resolveStoredSessionKeyForSessionId({
          cfg: params.config,
          sessionId: params.sessionId,
          agentId: params.agentId,
        })
      : resolveSessionKeyForRequestCore({
          cfg: params.config,
          sessionId: params.sessionId,
        });
    return {
      sessionKey: normalizeOptionalString(resolved.sessionKey),
      agentId: normalizeOptionalString(params.agentId) ?? normalizeOptionalString(resolved.agentId),
    };
  } catch (err) {
    log.warn(
      `[backfillSessionIdentity] Failed to resolve sessionKey for sessionId=${redactRunIdentifier(sanitizeForLog(params.sessionId))}: ${formatErrorMessage(err)}`,
    );
    return {};
  }
}

/** Prepare canonical session identity without acquiring execution or placement ownership. */
export async function prepareEmbeddedRunSession(paramsInput: RunEmbeddedAgentInternalParams) {
  const contextEngineAgentId =
    normalizeOptionalString(paramsInput.sessionTarget?.agentId) ??
    normalizeOptionalString(paramsInput.agentId);
  const queuedLifecycleGeneration = getAgentEventLifecycleGeneration();
  const supplied = applyAgentRunSessionTargetIdentity(paramsInput);
  // Carry the lookup's owner into every admission; a bare stored key cannot encode it.
  const paramsBase = {
    ...supplied,
    ...backfillSessionIdentity(supplied),
  };
  let sessionAdmission: AgentSessionWriterAdmissionSnapshot | undefined;
  const assertWorkerSelection = () =>
    assertRequiredWorkerSelection(paramsBase.config ?? {}, {
      agentRuntime: paramsBase.agentHarnessId ?? paramsBase.agentHarnessRuntimeOverride,
    });
  const reader =
    paramsBase.sessionPersistence !== "detached"
      ? getReplyOperationSessionReader(paramsBase.replyOperation)
      : undefined;
  const assertActive = paramsBase.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(paramsBase.admittedRunContext, paramsBase.abortSignal)
    : undefined;
  const prepareTarget = reader
    ? async (scope: SessionTranscriptRuntimeScope) => {
        sessionAdmission = await assertAgentHarnessRunAdmission(paramsBase, scope);
        assertWorkerSelection();
        const target =
          sessionAdmission?.runtimeTarget ?? (await resolveSessionTranscriptRuntimeTarget(scope));
        return {
          target,
          assertCurrent: () => {
            paramsBase.abortSignal?.throwIfAborted();
            assertActive?.();
            reader.assertCurrent();
          },
        };
      }
    : undefined;
  if (!prepareTarget) {
    sessionAdmission = await assertAgentHarnessRunAdmission(paramsBase);
    assertWorkerSelection();
  }
  const runSessionTarget = await resolveAgentRunSessionTarget(
    { ...paramsBase, missingSessionKey: "create" },
    prepareTarget,
  );
  const params: RunEmbeddedAgentParamsWithSessionFile = {
    ...paramsBase,
    agentId: runSessionTarget.agentId,
    sessionId: runSessionTarget.sessionId,
    sessionKey: runSessionTarget.sessionKey,
    sessionTarget: runSessionTarget,
    sessionFile: runSessionTarget.sessionKey,
  };
  return {
    params,
    runSessionTarget,
    sessionAdmission,
    contextEngineAgentId,
    queuedLifecycleGeneration,
  };
}

/** Reserves only a missing row's first writer; no row or claim exists until lazy persistence. */
export async function prepareInitialSessionWriter(params: {
  runParams: RunEmbeddedAgentParams;
  target: ContextEngineSessionTarget | undefined;
  onInterrupt: (reason: Error) => void;
}): Promise<
  | {
      writer: InitialSessionTranscriptWriter;
      run: <T>(run: () => Promise<T>) => Promise<T>;
      close: () => Promise<void>;
    }
  | undefined
> {
  const { runParams, target } = params;
  if (
    runParams.sessionPersistence === "detached" ||
    (runParams.sessionManager && !runParams.sessionManager.getSessionTarget()) ||
    runParams.sessionTarget?.expectedWriterRunId ||
    !target?.agentId ||
    !target.sessionId ||
    !target.sessionKey ||
    !target.storePath
  ) {
    return undefined;
  }
  const signal = runParams.abortSignal;
  const assertion =
    runParams.admittedRunContext &&
    resolveAdmittedRunActiveAssertion(runParams.admittedRunContext, signal);
  if (!assertion) {
    return undefined;
  }
  const ownerTarget = {
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
  };
  const presence = prepareSessionEntryPresenceRead(ownerTarget);
  let interrupted: Error | undefined;
  const assertActive = () => {
    signal?.throwIfAborted();
    if (interrupted) {
      throw interrupted;
    }
    assertion();
  };
  const assertAbsent = async () => {
    assertActive();
    const present = await presence.read();
    assertActive();
    if (present) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
  };
  // Existing-row callers can be inside their creation lifecycle; reject before
  // attempting to acquire an admission that their enclosing mutation excludes.
  await assertAbsent();
  const admission = await beginSessionWorkAdmission({
    scope: presence.storePath,
    identities: [ownerTarget.sessionKey, presence.sessionKey, ownerTarget.sessionId],
    signal,
    assertAllowed: assertAbsent,
    onInterrupt: (reason) => {
      interrupted ??= reason ?? new Error("Initial session writer interrupted by lifecycle change");
      params.onInterrupt(interrupted);
    },
  });
  const writerRunId = runParams.runId;
  const writes = new AsyncWorkScope();
  let committedFence: SessionTranscriptWriterFence | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const writer: InitialSessionTranscriptWriter = Object.freeze({
    writerRunId,
    get committedFence() {
      return committedFence;
    },
    assertActive: () => {
      assertActive();
      if (!committedFence && (closed || !admission.isActive())) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
    },
    recordCommitted: (fence: SessionTranscriptWriterFence) => {
      committedFence = Object.freeze({ ...fence });
      admission.release();
    },
    withTranscriptWrite: <T>(write: () => Promise<T> | T) =>
      admission.run(() => writes.track(write)),
  });
  return {
    writer,
    run: admission.run,
    close: () =>
      (closing ??= (async () => {
        try {
          await AsyncWorkScope.runWhenAllIdle(
            () => [writes],
            () => writes.drain(),
          );
        } finally {
          closed = true;
          admission.release();
        }
      })()),
  };
}

type AgentSessionWriterAdmissionSnapshot = {
  runtimeTarget?: SessionTranscriptRuntimeTarget;
  agentId?: string;
  entry: InternalSessionEntry;
  sessionKey: string;
  storePath: string;
};

export async function assertAgentHarnessRunAdmission(
  params: RunEmbeddedAgentParams,
  runtimeScope?: SessionTranscriptRuntimeScope,
): Promise<AgentSessionWriterAdmissionSnapshot | undefined> {
  if (params.sessionPersistence === "detached") {
    return undefined;
  }
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return undefined;
  }
  const targetStorePath = normalizeOptionalString(params.sessionTarget?.storePath);
  const admissionAgentId = resolveSessionTargetAgentId(params, sessionKey);
  const storePath =
    targetStorePath ??
    resolveSessionStorePathCore(params.config?.session?.store, { agentId: admissionAgentId });
  const assertActive = params.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(params.admittedRunContext, params.abortSignal)
    : undefined;
  assertActive?.();
  const scope = {
    agentId: admissionAgentId,
    sessionKey,
    storePath,
    readConsistency: "latest" as const,
  };
  const assertCurrent = () => {
    assertActive?.();
    params.abortSignal?.throwIfAborted();
  };
  const consume = (
    entry: InternalSessionEntry | undefined,
    runtimeTarget?: SessionTranscriptRuntimeTarget,
  ) => {
    assertCurrent();
    const admissionError = resolveAgentHarnessRunAdmissionError({
      agentHarnessId: params.agentHarnessId,
      entry,
      modelSelectionLocked: params.modelSelectionLocked,
      sessionId: params.sessionId,
      sessionKey,
    });
    if (admissionError) {
      throw new Error(admissionError);
    }
    return entry
      ? {
          ...scope,
          entry,
          ...(runtimeTarget && runtimeScope
            ? {
                runtimeTarget: { ...runtimeTarget, storePath: runtimeScope.storePath ?? storePath },
              }
            : {}),
        }
      : undefined;
  };
  const reader = getReplyOperationSessionReader(params.replyOperation);
  if (reader) {
    const key = assertSessionEntryCohortScope(reader, scope);
    const runtimeTarget =
      runtimeScope?.agentId === admissionAgentId &&
      runtimeScope.sessionKey.trim() === sessionKey &&
      runtimeScope.storePath &&
      path.resolve(runtimeScope.storePath) === path.resolve(storePath)
        ? { agentId: admissionAgentId, sessionId: runtimeScope.sessionId, sessionKey: key }
        : undefined;
    return reader.withRead(
      { sessionKeys: [key], ...(runtimeTarget ? { runtimeTarget } : {}) },
      assertCurrent,
      (read) =>
        consume(read.entries.find((row) => row.sessionKey === key)?.entry, read.runtimeTarget),
    );
  }
  return consume(await readSessionEntryInWorker(scope, assertCurrent));
}

export async function claimAgentSessionWriter(params: RunEmbeddedAgentParams): Promise<
  | {
      expectedLifecycleRevision: string | undefined;
      expectedWriterRunId: string;
    }
  | undefined
> {
  const snapshot = await assertAgentHarnessRunAdmission(params);
  if (!snapshot) {
    return undefined;
  }
  const expectedSessionId = params.sessionId;
  const expectedLifecycleRevision = snapshot.entry.lifecycleRevision;
  if (snapshot.entry.sessionId !== expectedSessionId) {
    throw new Error(`Session changed before writer admission: ${snapshot.sessionKey}`);
  }

  const previousWriterRunId = normalizeOptionalString(snapshot.entry.activeWriterRunId);
  const claimed = await applySessionEntryOperation(
    {
      ...(snapshot.agentId ? { agentId: snapshot.agentId } : {}),
      sessionKey: snapshot.sessionKey,
      storePath: snapshot.storePath,
    },
    {
      kind: "fields",
      expected: { sessionId: expectedSessionId, lifecycleRevision: expectedLifecycleRevision },
      patch: { activeWriterRunId: params.runId },
    },
    { skipMaintenance: true },
  );
  if (
    claimed &&
    (claimed.sessionId !== expectedSessionId ||
      claimed.lifecycleRevision !== expectedLifecycleRevision)
  ) {
    throw new Error(`Session changed before writer claim commit: ${snapshot.sessionKey}`);
  }
  if (!claimed || (claimed as InternalSessionEntry).activeWriterRunId !== params.runId) {
    throw new Error(`Session writer claim was not persisted: ${snapshot.sessionKey}`);
  }
  if (previousWriterRunId && previousWriterRunId !== params.runId) {
    // The replacement must own the durable row before the incumbent is made
    // terminal. A failed claim leaves the still-authoritative run untouched.
    const superseded = supersedeEmbeddedAgentRunByRunId(previousWriterRunId, () => {
      const previousLifecycleGeneration =
        getAgentRunContext(previousWriterRunId)?.lifecycleGeneration;
      const recorded = emitAgentEventIfCurrent({
        runId: previousWriterRunId,
        ...(previousLifecycleGeneration
          ? { lifecycleGeneration: previousLifecycleGeneration }
          : {}),
        stream: "lifecycle",
        sessionKey: snapshot.sessionKey,
        sessionId: expectedSessionId,
        ...(snapshot.agentId ? { agentId: snapshot.agentId } : {}),
        data: {
          phase: "end",
          aborted: true,
          status: AGENT_RUN_SUPERSEDED_STOP_REASON,
          stopReason: AGENT_RUN_SUPERSEDED_STOP_REASON,
          error: AGENT_RUN_SUPERSEDED_ERROR,
          endedAt: Date.now(),
        },
      });
      if (!recorded) {
        throw new Error(`Could not record superseded writer outcome: ${previousWriterRunId}`);
      }
    });
    if (superseded) {
      log.warn(
        `[session-writer] replacing claim session=${sanitizeForLog(snapshot.sessionKey)} ` +
          `previousRunId=${redactRunIdentifier(sanitizeForLog(previousWriterRunId))} ` +
          `nextRunId=${redactRunIdentifier(sanitizeForLog(params.runId))} live=true`,
      );
    }
  }
  return {
    expectedLifecycleRevision,
    expectedWriterRunId: params.runId,
  };
}
