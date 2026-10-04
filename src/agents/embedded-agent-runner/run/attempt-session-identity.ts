import path from "node:path";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../../config/sessions/legacy-sqlite-marker.js";
import { resolveSqliteSessionKey } from "../../../config/sessions/session-accessor.sqlite-scope-helpers.js";
import {
  readSessionEntrySummariesInWorker,
  withSessionEntryReadOnlyInWorker,
} from "../../../config/sessions/session-entry-read-runtime.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../../../sessions/session-id-resolution.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

type SessionPromptState = Awaited<ReturnType<typeof createEmbeddedRunSessionPromptState>>;

export async function applyEmbeddedAttemptSessionIdentity(params: {
  sessionPromptState: Pick<
    SessionPromptState,
    "adoptSessionId" | "sessionFile" | "sessionId" | "sessionTarget"
  >;
  sessionFileUsed?: string;
  sessionIdUsed: string;
  assertCurrent: () => void;
}): Promise<void> {
  const { sessionPromptState, sessionFileUsed, sessionIdUsed } = params;
  const previousSessionId = sessionPromptState.sessionId;
  const previousSessionFile = sessionPromptState.sessionFile;
  const previousTarget = sessionPromptState.sessionTarget
    ? { ...sessionPromptState.sessionTarget }
    : undefined;
  const assertCurrent = () => {
    params.assertCurrent();
    if (
      sessionPromptState.sessionId !== previousSessionId ||
      sessionPromptState.sessionFile !== previousSessionFile ||
      sessionPromptState.sessionTarget?.agentId !== previousTarget?.agentId ||
      sessionPromptState.sessionTarget?.sessionId !== previousTarget?.sessionId ||
      sessionPromptState.sessionTarget?.sessionKey !== previousTarget?.sessionKey ||
      sessionPromptState.sessionTarget?.storePath !== previousTarget?.storePath
    ) {
      throw new Error("Legacy context-engine successor target changed the active session binding");
    }
  };
  assertCurrent();
  let adoptedSessionId = sessionIdUsed;
  const sessionFileChanged = Boolean(
    sessionFileUsed && sessionFileUsed !== sessionPromptState.sessionFile,
  );
  let nextSessionTarget = sessionPromptState.sessionTarget;
  if (sessionFileUsed && sessionFileChanged) {
    const marker = parseSqliteSessionFileMarker(sessionFileUsed);
    if (marker) {
      const retainedSessionKey = sessionPromptState.sessionTarget?.sessionKey;
      const entries = await readSessionEntrySummariesInWorker({
        agentId: marker.agentId,
        storePath: marker.storePath,
      });
      assertCurrent();
      const retainedLookupKey = retainedSessionKey
        ? resolveSqliteSessionKey(retainedSessionKey, marker.agentId)
        : undefined;
      const retainedEntry = entries.find(
        ({ sessionKey }) => sessionKey === retainedLookupKey,
      )?.entry;
      const markerMatches = entries.filter(({ entry }) => entry.sessionId === marker.sessionId);
      const preferredMarkerSessionKey = resolvePreferredSessionKeyForSessionIdMatches(
        markerMatches.map(({ sessionKey, entry }) => [sessionKey, entry]),
        marker.sessionId,
      );
      const markerMappedToRetainedKey = markerMatches.some(
        ({ sessionKey }) => sessionKey === retainedSessionKey,
      );
      const successorSessionKey =
        retainedEntry?.sessionId === marker.sessionId ||
        (retainedEntry?.sessionId === previousSessionId &&
          (markerMatches.length === 0 || markerMappedToRetainedKey))
          ? retainedSessionKey
          : (preferredMarkerSessionKey ??
            (markerMatches.length === 0 && !retainedEntry ? retainedSessionKey : undefined));
      if (
        (marker.sessionId !== sessionIdUsed && sessionIdUsed !== previousSessionId) ||
        !successorSessionKey ||
        marker.agentId !== sessionPromptState.sessionTarget?.agentId
      ) {
        throw new Error("Legacy context-engine successor identity is inconsistent");
      }
      adoptedSessionId = marker.sessionId;
      nextSessionTarget = {
        ...marker,
        sessionKey: successorSessionKey,
      };
    } else if (
      sessionFileUsed.startsWith("agent:") &&
      sessionPromptState.sessionTarget &&
      resolveAgentIdFromSessionKey(sessionFileUsed) === sessionPromptState.sessionTarget.agentId
    ) {
      const keyedEntry = await withSessionEntryReadOnlyInWorker(
        {
          agentId: sessionPromptState.sessionTarget.agentId,
          sessionKey: sessionFileUsed,
          storePath: sessionPromptState.sessionTarget.storePath,
        },
        assertCurrent,
        async (read) => {
          if (!read.ok) {
            throw read.error;
          }
          return read.value;
        },
      );
      assertCurrent();
      if (!keyedEntry?.sessionId || keyedEntry.sessionId !== sessionIdUsed) {
        throw new Error("Legacy context-engine successor identity is inconsistent");
      }
      nextSessionTarget = {
        ...sessionPromptState.sessionTarget,
        sessionId: sessionIdUsed,
        sessionKey: sessionFileUsed,
      };
    } else {
      throw new Error(
        "Legacy context-engine successor files are unsupported; return a structured sessionTarget",
      );
    }
  } else if (sessionIdUsed && sessionIdUsed !== previousSessionId) {
    nextSessionTarget = sessionPromptState.sessionTarget
      ? { ...sessionPromptState.sessionTarget, sessionId: sessionIdUsed }
      : undefined;
  }
  if (
    sessionFileChanged &&
    nextSessionTarget &&
    sessionPromptState.sessionTarget &&
    (!nextSessionTarget.agentId ||
      !nextSessionTarget.sessionKey ||
      !nextSessionTarget.storePath ||
      !sessionPromptState.sessionTarget.agentId ||
      !sessionPromptState.sessionTarget.sessionKey ||
      !sessionPromptState.sessionTarget.storePath ||
      nextSessionTarget.agentId !== sessionPromptState.sessionTarget.agentId ||
      nextSessionTarget.sessionKey !== sessionPromptState.sessionTarget.sessionKey ||
      path.resolve(nextSessionTarget.storePath) !==
        path.resolve(sessionPromptState.sessionTarget.storePath))
  ) {
    throw new Error("Legacy context-engine successor target changed the active session binding");
  }
  assertCurrent();
  sessionPromptState.adoptSessionId(adoptedSessionId);
  if (sessionFileUsed && sessionFileChanged) {
    sessionPromptState.sessionFile = sessionFileUsed;
  } else if (adoptedSessionId !== previousSessionId && nextSessionTarget) {
    const marker = parseSqliteSessionFileMarker(sessionPromptState.sessionFile);
    if (marker) {
      sessionPromptState.sessionFile = formatSqliteSessionFileMarker({
        agentId: nextSessionTarget.agentId ?? marker.agentId,
        sessionId: nextSessionTarget.sessionId ?? marker.sessionId,
        storePath: nextSessionTarget.storePath ?? marker.storePath,
      });
    }
  }
  sessionPromptState.sessionTarget = nextSessionTarget;
}
