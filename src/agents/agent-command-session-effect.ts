import { createSessionWorkStartChangedError } from "../config/sessions/lifecycle.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../config/sessions/session-actor-storage-binding.js";
import { resolveSessionWorkStartBlock } from "../config/sessions/session-work-start.js";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import { isSubagentCoordinationInputProvenance } from "../sessions/input-provenance.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
import { repairPendingAssistantTranscriptTurns } from "./command/assistant-transcript-repair.js";
import type { prepareAgentCommandExecution } from "./command/prepare.js";
import { loadSessionStoreRuntime } from "./command/runtime-loaders.js";
import type { AgentCommandOpts } from "./command/types.js";

type Prepared = Awaited<ReturnType<typeof prepareAgentCommandExecution>>;

/** Physical effect admission rechecks the captured session after the writer barrier. */
export async function beginAgentCommandSessionEffect(params: {
  prepared: Prepared;
  opts: AgentCommandOpts;
  sessionEntry: Prepared["sessionEntry"];
  preparedSessionId: string | undefined;
  operatorSession:
    | ReturnType<
        typeof import("../gateway/operator-session-run.js").prepareGatewayOperatorSessionRun
      >
    | undefined;
  onInterrupt: (reason?: Error) => void;
  onValidated: (entry: Prepared["sessionEntry"]) => void;
}) {
  const { prepared, opts, preparedSessionId, operatorSession } = params;
  const { storePath, sessionKey, sessionId, sessionAgentId, isNewSession, sessionStore, runId } =
    prepared;
  let sessionEntry = params.sessionEntry;
  const sessionSource = sessionKey
    ? captureSessionActorStorageOwner(
        { agentId: sessionAgentId, storePath, sessionKey },
        { assertCurrent: () => opts.assertSourceCurrent?.(), authorize() {} },
      )
    : undefined;
  const sessionStoreRuntime = storePath && sessionKey ? await loadSessionStoreRuntime() : undefined;
  // Reset marks its mutation before interrupting work. An aborted run must not
  // queue behind that mutation or reset would wait on the run holding the queue.
  return await beginSessionEffect({
    agentId: sessionAgentId,
    scope: storePath ?? `agent:${sessionAgentId}`,
    isSettling: opts.isTerminalOutcomeObserved,
    identities: [sessionKey, sessionId],
    run: {
      runId,
      sessionKey,
      sessionId,
      agentId: sessionAgentId,
      controlUiVisible:
        opts.sessionEffects !== "internal" &&
        !isSubagentCoordinationInputProvenance(opts.inputProvenance),
    },
    signal: opts.abortSignal,
    onInterrupt: (reason) => {
      if (opts.abortSignal?.aborted) {
        return undefined;
      }
      params.onInterrupt(reason);
      return { runId };
    },
    assertAllowed: async () => {
      const currentEntry =
        sessionStoreRuntime && storePath && sessionKey
          ? sessionSource
            ? readCapturedSessionActorEntry(sessionSource, normalizeStoreSessionKey(sessionKey))
            : await sessionStoreRuntime.readSessionEntryInWorker({
                agentId: sessionAgentId,
                storePath,
                sessionKey,
                readConsistency: "latest",
              })
          : sessionEntry;
      if (!currentEntry && preparedSessionId) {
        throw createSessionWorkStartChangedError(sessionKey ?? sessionId);
      }
      const matchesIntentionalRollover =
        isNewSession && currentEntry?.sessionId === preparedSessionId;
      if (currentEntry && currentEntry.sessionId !== sessionId && !matchesIntentionalRollover) {
        throw createSessionWorkStartChangedError(sessionKey ?? sessionId);
      }
      const archivedSessionError = resolveSessionWorkStartBlock(
        sessionKey ?? sessionId,
        currentEntry,
      );
      if (archivedSessionError) {
        throw archivedSessionError;
      }
      operatorSession?.assertAuthorized(currentEntry);
      sessionEntry = currentEntry;
      params.onValidated(currentEntry);
      if (sessionStore && sessionKey) {
        if (currentEntry) {
          sessionStore[sessionKey] = currentEntry;
        } else {
          delete sessionStore[sessionKey];
        }
      }
    },
  });
}

export async function repairAgentCommandSessionTranscript(params: {
  prepared: Prepared;
  sessionEntry: Prepared["sessionEntry"];
  suppressVisibleSessionEffects: boolean;
  diagnosticError: (error: unknown) => string;
  warn: (message: string) => void;
}): Promise<Prepared["sessionEntry"]> {
  const { prepared, suppressVisibleSessionEffects, diagnosticError, warn } = params;
  const { sessionStore, sessionKey, storePath, sessionAgentId, cfg, isNewSession } = prepared;
  let sessionEntry = params.sessionEntry;
  if (sessionStore && sessionKey && !suppressVisibleSessionEffects) {
    try {
      await repairPendingAssistantTranscriptTurns({
        context: {
          sessionKey,
          sessionEntry,
          sessionStore,
          storePath,
          sessionAgentId,
          config: cfg,
        },
      });
      sessionEntry = sessionStore[sessionKey] ?? sessionEntry;
    } catch (error) {
      if (!isNewSession) {
        throw error;
      }
      // A reset starts a fresh transcript; unavailable predecessor repair must not block it.
      warn(
        `Could not repair predecessor transcript before session reset for ${sessionKey}: ${diagnosticError(error)}`,
      );
    }
  }
  return sessionEntry;
}
