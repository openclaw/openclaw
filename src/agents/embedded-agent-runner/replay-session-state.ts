import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type {
  ProviderReplaySessionEntry,
  ProviderReplaySessionStateV2,
} from "../../plugins/provider-replay.types.js";
import { rethrowIncognitoSessionError } from "../../state/incognito-session-error.js";
import { sessionManagerReadTranscriptBranch } from "../sessions/session-manager-view-types.js";
import { withSessionManagerWriteAssertion } from "../sessions/session-manager-write-admission.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { warnSessionPersistenceDeprecation } from "../sessions/session-persistence-deprecation.js";
import {
  readModelSnapshotStateFromEntries,
  type ModelSnapshotState,
} from "./replay-model-snapshot.js";

export {
  isSameModelSnapshot,
  MODEL_SNAPSHOT_CUSTOM_TYPE,
  type ModelSnapshotEntry,
} from "./replay-model-snapshot.js";

export function createProviderReplaySessionState(sessionManager: SessionManager): {
  state: ProviderReplaySessionStateV2;
  close(): void;
} {
  const target = sessionManager.getSessionTarget();
  let active = true;
  const assertCurrent = () => {
    if (!active || !sameSessionTranscriptTargetBinding(target, sessionManager.getSessionTarget())) {
      throw new Error("Provider replay session state is no longer active");
    }
  };
  return {
    close() {
      active = false;
    },
    state: {
      getCustomEntries() {
        assertCurrent();
        try {
          return sessionManager.getEntries().flatMap((entry): ProviderReplaySessionEntry[] => {
            if (entry?.type !== "custom" || typeof entry.customType !== "string") {
              return [];
            }
            const customType = entry.customType.trim();
            return customType ? [{ customType, data: entry.data }] : [];
          });
        } catch (error) {
          rethrowIncognitoSessionError(error);
          return [];
        }
      },
      // Retained third-party adapter preserves the legacy synchronous error behavior.
      appendCustomEntry(customType: string, data: unknown) {
        assertCurrent();
        warnSessionPersistenceDeprecation(
          "ProviderReplaySessionState.appendCustomEntry",
          "appendCustomEntryAsync",
        );
        try {
          sessionManager.appendCustomEntry(customType, data);
        } catch (error) {
          rethrowIncognitoSessionError(error);
          // Legacy providers ignored persistence failures; V2 propagates them.
        }
      },
      async appendCustomEntryAsync(customType: string, data: unknown) {
        assertCurrent();
        const append = () => sessionManager.appendCustomEntryAsync(customType, data);
        return await withSessionManagerWriteAssertion(sessionManager, assertCurrent, () =>
          target ? withSessionTranscriptWriteAssertion(target, assertCurrent, append) : append(),
        );
      },
    },
  };
}

export function readModelSnapshotState(sessionManager: SessionManager): ModelSnapshotState {
  try {
    return readModelSnapshotStateFromEntries(sessionManager[sessionManagerReadTranscriptBranch]());
  } catch (error) {
    rethrowIncognitoSessionError(error);
    return { lastSnapshot: null, latestSwitchTimestamp: null };
  }
}
