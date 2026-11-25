import { createSessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionResetBoundaryWrite } from "../../config/sessions/session-accessor.lifecycle-types.js";
import { resetSessionEntryLifecycle } from "../../config/sessions/session-accessor.lifecycle.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import { mergeSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import {
  sessionEntryCommitGuardOptions,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
type PersistSessionEntryParams = {
  agentId: string;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  initialEntry: SessionEntry;
  entry: SessionEntry;
  resetBoundary?: SessionResetBoundaryWrite;
  creation?: Parameters<typeof buildSessionCreationStamp>[0];
  assertCommitAllowed?: SessionSourceAssertion;
  shouldPersist?: (entry: SessionEntry | undefined) => boolean;
};

/** Persists one session entry while keeping the caller's in-memory store aligned. */
export async function persistAgentSession(
  params: PersistSessionEntryParams,
): Promise<SessionEntry | undefined> {
  let rejectedMissingEntry = false;
  let published = false;
  const buildEntry = (current: SessionEntry | undefined) => {
    const shouldPersistCurrent = params.shouldPersist?.(current);
    if ((!current && shouldPersistCurrent !== true) || shouldPersistCurrent === false) {
      rejectedMissingEntry = !current;
      return null;
    }
    if (!current) {
      return {
        ...params.entry,
        ...(params.creation ? buildSessionCreationStamp(params.creation) : {}),
      };
    }
    if (current.sessionId !== params.initialEntry.sessionId) {
      return null;
    }
    // Agent turns persist broad snapshots. Project only this turn's changes
    // so a stale snapshot cannot restore fields changed or cleared meanwhile.
    return mergeSessionSnapshotChanges({
      initial: params.initialEntry,
      next: params.entry,
      current,
    });
  };
  const publish = (entry: SessionEntry) => {
    published = true;
    params.sessionStore[params.sessionKey] = entry;
  };
  const persisted = params.resetBoundary
    ? (
        await resetSessionEntryLifecycle({
          agentId: params.agentId,
          storePath: params.storePath,
          target: {
            canonicalKey: normalizeStoreSessionKey(params.sessionKey),
            storeKeys: [params.sessionKey],
          },
          resetBoundary: params.resetBoundary,
          commitGuard: params.assertCommitAllowed,
          buildNextEntry: ({ currentEntry }) => {
            const entry = buildEntry(currentEntry);
            if (!entry) {
              throw createSessionWorkStartChangedError(params.sessionKey);
            }
            return entry;
          },
          afterEntryMutation: ({ nextEntry }) => publish(nextEntry),
        })
      ).nextEntry
    : await patchSessionEntryCore(
        { agentId: params.agentId, sessionKey: params.sessionKey, storePath: params.storePath },
        (_entry, context) => buildEntry(context.existingEntry),
        {
          fallbackEntry: params.sessionStore[params.sessionKey] ?? params.entry,
          replaceEntry: true,
          ...sessionEntryCommitGuardOptions(params.assertCommitAllowed),
          requireWriteSuccess: params.creation !== undefined,
          onCommitted: publish,
        },
      );
  if (rejectedMissingEntry || !persisted) {
    delete params.sessionStore[params.sessionKey];
    return undefined;
  }
  if (!published) {
    params.sessionStore[params.sessionKey] = persisted;
  }
  return persisted;
}
