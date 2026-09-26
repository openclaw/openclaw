import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureSessionMetadataPublication,
  SessionTranscriptWriterClaimReboundError,
  type SessionMetadataChange,
  type SessionMetadataCommit,
} from "../../config/sessions/transcript-write-context.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { isIndexedSessionEntry } from "./session-manager-codec.js";
import { SessionManagerCompaction } from "./session-manager-compaction.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import { SessionMetadataCommittedError } from "./session-manager-metadata-error.js";
import { canonicalizeSessionEntry } from "./session-manager-persistence.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";

export class SessionManagerMetadata extends SessionManagerCompaction {
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
      const canonical: unknown = canonicalizeSessionEntry(entry);
      if (
        !isIndexedSessionEntry(canonical) ||
        (canonical.type !== "model_change" && canonical.type !== "thinking_level_change")
      ) {
        throw new Error(`Invalid session transcript entry: ${entry.type}`);
      }
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
}
