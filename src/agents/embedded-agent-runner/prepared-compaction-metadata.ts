import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { rethrowIncognitoSessionError } from "../../state/incognito-session-error.js";
import { appendSessionMetadataInWorker } from "../sessions/session-compaction-persistence.js";
import type { PreparedCompactionAppend } from "../sessions/session-compaction-persistence.types.js";
import { prepareSessionInitialMetadata } from "../sessions/session-initial-metadata.js";
import { generateSessionEntryId } from "../sessions/session-manager-id.js";
import type {
  ModelChangeEntry,
  ThinkingLevelChangeEntry,
  SessionHeader,
} from "../sessions/session-manager-types.js";
import type { PreparedCompactionMetadataFacts } from "./prepared-compaction-metadata.types.js";
import { isSameModelSnapshot, MODEL_SNAPSHOT_CUSTOM_TYPE } from "./replay-model-snapshot.js";
import type { ModelSnapshotEntry } from "./replay-session-state.types.js";

/** Initialize before planning; true means the captured source must be refreshed. */
export async function initializePreparedCompactionMetadata(
  scope: PreparedCompactionAppend["scope"],
  facts: PreparedCompactionMetadataFacts,
  model: { provider: string; modelId: string; modelApi?: string | null; thinkingLevel: string },
  assertCurrent: () => void,
  header?: SessionHeader,
): Promise<boolean> {
  assertCurrent();
  let parentId = facts.leafEntryId;
  const metadata = prepareSessionInitialMetadata(facts, model);
  if (metadata) {
    const initialModel: ModelChangeEntry | undefined = metadata.initialModelChange
      ? {
          ...metadata.initialModelChange,
          id: generateSessionEntryId(),
          parentId,
          timestamp: new Date().toISOString(),
        }
      : undefined;
    const event: ThinkingLevelChangeEntry = {
      ...metadata.change,
      id: generateSessionEntryId(),
      parentId: initialModel?.id ?? parentId,
      timestamp: new Date().toISOString(),
    };
    await withSessionTranscriptWriteAssertion(scope, assertCurrent, () =>
      appendSessionMetadataInWorker(
        { scope, event, initialModel, header, appendIntent: "active-branch" },
        assertCurrent,
      ),
    );
    parentId = event.id;
    assertCurrent();
  }

  const snapshot: ModelSnapshotEntry = {
    timestamp: Date.now(),
    provider: model.provider,
    modelApi: model.modelApi,
    modelId: model.modelId,
  };
  if (facts.lastModelSnapshot && isSameModelSnapshot(facts.lastModelSnapshot, snapshot)) {
    return metadata !== undefined;
  }
  assertCurrent();
  try {
    await withSessionTranscriptWriteAssertion(scope, assertCurrent, () =>
      appendSessionMetadataInWorker(
        {
          scope,
          appendIntent: "active-branch",
          event: {
            type: "custom",
            id: generateSessionEntryId(),
            parentId,
            timestamp: new Date().toISOString(),
            customType: MODEL_SNAPSHOT_CUSTOM_TYPE,
            data: snapshot,
          },
        },
        assertCurrent,
      ),
    );
  } catch (error) {
    rethrowIncognitoSessionError(error);
    // Replay snapshots retain sanitizeSessionHistory's best-effort persistence policy.
  }
  assertCurrent();
  // A swallowed snapshot failure can follow a commit, so invalidate the source either way.
  return true;
}
