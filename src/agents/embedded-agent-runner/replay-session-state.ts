import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type {
  ProviderReplaySessionEntry,
  ProviderReplaySessionStateV2,
} from "../../plugins/provider-replay.types.js";
import { rethrowIncognitoSessionError } from "../../state/incognito-session-error.js";
import { withSessionManagerWriteAssertion } from "../sessions/session-manager-write-admission.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { warnSessionPersistenceDeprecation } from "../sessions/session-persistence-deprecation.js";

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
        const id = await withSessionManagerWriteAssertion(sessionManager, assertCurrent, () =>
          target ? withSessionTranscriptWriteAssertion(target, assertCurrent, append) : append(),
        );
        assertCurrent();
        return id;
      },
    },
  };
}

export const MODEL_SNAPSHOT_CUSTOM_TYPE = "model-snapshot";
export type ModelSnapshotEntry = {
  timestamp: number;
  provider?: string;
  modelApi?: string | null;
  modelId?: string;
};
type ModelSnapshotState = {
  lastSnapshot: ModelSnapshotEntry | null;
  latestSwitchTimestamp: number | null;
};

export function readModelSnapshotState(sessionManager: SessionManager): ModelSnapshotState {
  let lastSnapshot: ModelSnapshotEntry | null = null;
  let latestSwitchTimestamp: number | null = null;
  try {
    for (const entry of sessionManager.getBranch()) {
      if (entry?.type !== "custom" || entry?.customType !== MODEL_SNAPSHOT_CUSTOM_TYPE) {
        continue;
      }
      // SAFETY: replay history writes model-snapshot custom entries with this payload contract.
      const data = entry?.data as ModelSnapshotEntry | undefined;
      if (data && typeof data === "object") {
        if (
          lastSnapshot &&
          !isSameModelSnapshot(lastSnapshot, data) &&
          Number.isFinite(data.timestamp)
        ) {
          latestSwitchTimestamp = data.timestamp;
        }
        lastSnapshot = data;
      }
    }
  } catch (error) {
    rethrowIncognitoSessionError(error);
    return { lastSnapshot: null, latestSwitchTimestamp: null };
  }
  return { lastSnapshot, latestSwitchTimestamp };
}

export function isSameModelSnapshot(a: ModelSnapshotEntry, b: ModelSnapshotEntry): boolean {
  return (["provider", "modelApi", "modelId"] as const).every(
    (field) => (a[field] ?? "") === (b[field] ?? ""),
  );
}
