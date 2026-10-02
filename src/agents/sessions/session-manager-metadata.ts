import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { isSessionTranscriptSideAppendEntry } from "../../config/sessions/transcript-tree.js";
import {
  captureSessionMetadataPublication,
  SessionTranscriptWriterClaimReboundError,
  type SessionMetadataChange,
  type SessionMetadataCommit,
} from "../../config/sessions/transcript-write-context.js";
import type { ImageContent, TextContent } from "../../llm/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import { SessionManagerEntries } from "./session-manager-entries.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import { SessionMetadataCommittedError } from "./session-manager-metadata-error.js";
import { canonicalizeSessionEntry } from "./session-manager-persistence.js";
import type { CustomEntry, CustomMessageEntry } from "./session-manager-types.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";

export class SessionManagerMetadata extends SessionManagerEntries {
  private async appendMetadataEntry(change: SessionMetadataChange): Promise<string> {
    const publication = captureSessionMetadataPublication(this, change);
    return await withSessionManagerWrite(this, async (admission) => {
      this.assertTranscriptViewAvailable();
      const entry = {
        ...change,
        id: generateSessionEntryId(),
        parentId: this.appendParentId,
        timestamp: new Date().toISOString(),
      };
      if (!admission || isIncognitoSessionKey(this.persistenceTarget?.sessionKey)) {
        // Volatile storage keeps its one native owner until its complete actor cutover.
        const appended = this.appendEntry(entry);
        return this.publishMetadataCommit(
          { entry: appended.entry, version: this.transcriptVersion, target: publication.target },
          publication.publish,
        );
      }
      const canonical = canonicalizeSessionEntry(entry);
      const appendIntent =
        !this.pendingDeliberateAppend && this.appendMode !== "side" ? "active-branch" : undefined;
      const admittedUserId = this.persistenceTarget
        ? resolveSessionTranscriptReadFence(this.persistenceTarget)?.entryId
        : undefined;
      const committedTarget = publication.target;
      const committed = await this.persistWorkerRecord(canonical, appendIntent, admission);
      const { result, committedVersion, viewFailure } = committed;
      const commit: SessionMetadataCommit = {
        entry: {
          ...canonical,
          parentId:
            result?.effectiveParentId !== undefined ? result.effectiveParentId : canonical.parentId,
        },
        version: committedVersion,
        target: committedTarget,
      };
      let failure: { cause: unknown } | undefined;
      try {
        const currentTarget = this.getSessionTarget();
        if (
          !committedTarget ||
          this.getSessionId() !== publication.sessionId ||
          !sameSessionTranscriptTargetBinding(committedTarget, currentTarget)
        ) {
          const rebound = new SessionTranscriptWriterClaimReboundError();
          throw viewFailure
            ? new AggregateError(
                [rebound, viewFailure],
                "Committed metadata lost its view and binding",
                { cause: rebound },
              )
            : rebound;
        }
        this.adoptWorkerCommittedEntry(canonical, committed, admittedUserId);
      } catch (cause) {
        failure = { cause };
      }
      return this.publishMetadataCommit(commit, publication.publish, failure);
    });
  }

  private publishMetadataCommit(
    commit: SessionMetadataCommit,
    publish: (commit: SessionMetadataCommit) => undefined,
    failure?: { cause: unknown },
  ): string {
    const committedError = (cause: unknown) =>
      new SessionMetadataCommittedError(commit.entry, commit.version, cause, commit.target);
    let error = failure ? committedError(failure.cause) : undefined;
    if (error) {
      this.invalidateTranscriptView(error);
    }
    try {
      publish(commit);
    } catch (cause) {
      error = committedError(
        error
          ? new AggregateError([error, cause], "Metadata view and state publication failed", {
              cause: error,
            })
          : cause,
      );
      this.invalidateTranscriptView(error);
    }
    if (error) {
      throw error;
    }
    return commit.entry.id;
  }

  appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
    return this.appendMetadataEntry({
      type: "thinking_level_change",
      thinkingLevel,
    });
  }

  appendModelChange(provider: string, modelId: string): Promise<string> {
    return this.appendMetadataEntry({
      type: "model_change",
      provider,
      modelId,
    });
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entry: CustomEntry = {
      type: "custom",
      customType,
      data,
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
    };
    this.appendEntry(entry, { invalidateSerializedPrefixCache: true });
    return entry.id;
  }

  private async appendCustomRecordAsync(
    change:
      | Pick<CustomEntry, "type" | "customType" | "data">
      | Pick<CustomMessageEntry, "type" | "customType" | "content" | "display" | "details">,
  ): Promise<string> {
    return await withSessionManagerWrite(this, async (admission) => {
      this.assertTranscriptWriteActive();
      const entry = canonicalizeSessionEntry({
        ...change,
        id: generateSessionEntryId(),
        parentId: this.appendParentId,
        timestamp: new Date().toISOString(),
      });
      if (!admission || isIncognitoSessionKey(this.persistenceTarget?.sessionKey)) {
        return this.appendEntry(entry, { invalidateSerializedPrefixCache: true }).entry.id;
      }
      const target = this.getSessionTarget();
      const sessionId = this.getSessionId();
      const admittedUserId = target
        ? resolveSessionTranscriptReadFence(target)?.entryId
        : undefined;
      const committed = await this.persistWorkerRecord(
        entry,
        !this.pendingDeliberateAppend &&
          this.appendMode !== "side" &&
          !isSessionTranscriptSideAppendEntry(entry)
          ? "active-branch"
          : undefined,
        admission,
      );
      try {
        this.assertTranscriptWriteActive();
        if (
          this.getSessionId() !== sessionId ||
          !sameSessionTranscriptTargetBinding(target, this.getSessionTarget())
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        return this.adoptWorkerCommittedEntry(entry, committed, admittedUserId).entry.id;
      } catch (cause) {
        const error = new Error(
          "Session custom entry committed, but its view could not be adopted; do not replay the append",
          { cause },
        );
        error.name = "SessionMessageCommittedError";
        recordModelFallbackStop(error);
        this.invalidateTranscriptView(error);
        throw error;
      }
    });
  }

  appendCustomEntryAsync(customType: string, data?: unknown): Promise<string> {
    return this.appendCustomRecordAsync({ type: "custom", customType, data });
  }

  appendCustomMessageEntry(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: unknown,
  ): string {
    const entry: CustomMessageEntry = {
      type: "custom_message",
      customType,
      content,
      display,
      details,
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
    };
    this.appendEntry(entry, { invalidateSerializedPrefixCache: true });
    return entry.id;
  }

  appendCustomMessageEntryAsync(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: unknown,
  ): Promise<string> {
    return this.appendCustomRecordAsync({
      type: "custom_message",
      customType,
      content,
      display,
      details,
    });
  }
}
