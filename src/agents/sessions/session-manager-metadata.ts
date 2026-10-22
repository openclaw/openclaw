import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureSessionMetadataPublication,
  SessionTranscriptWriterClaimReboundError,
  type SessionMetadataChange,
  type SessionMetadataCommit,
} from "../../config/sessions/transcript-write-context.js";
import { withSessionManagerAppend } from "./session-manager-append-admission.js";
import { SessionManagerEntries } from "./session-manager-entries.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import { SessionMetadataCommittedError } from "./session-manager-metadata-error.js";
import { canonicalizeSessionEntry } from "./session-manager-persistence-entry.js";

/** @internal Session factory initialization is not part of the public SessionManager API. */
export const sessionManagerAppendInitialMetadata = Symbol("sessionManagerAppendInitialMetadata");

export class SessionManagerMetadata extends SessionManagerEntries {
  private async appendMetadataEntry(
    change: SessionMetadataChange,
    initialModelChange?: Extract<SessionMetadataChange, { type: "model_change" }>,
  ): Promise<string> {
    const publication = captureSessionMetadataPublication(this, change);
    return await withSessionManagerAppend(this, async (admission) => {
      this.assertTranscriptViewAvailable();
      const initialModel = initialModelChange
        ? canonicalizeSessionEntry({
            ...initialModelChange,
            id: generateSessionEntryId(),
            parentId: this.appendParentId,
            timestamp: new Date().toISOString(),
          })
        : undefined;
      const canonical = canonicalizeSessionEntry({
        ...change,
        id: generateSessionEntryId(),
        parentId: initialModel?.id ?? this.appendParentId,
        timestamp: new Date().toISOString(),
      });
      if (!admission) {
        if (initialModel) {
          this.appendEntry(initialModel);
        }
        const appended = this.appendEntry(canonical);
        return this.publishMetadataCommit(
          { entry: appended.entry, version: this.transcriptVersion, target: publication.target },
          publication.publish,
        );
      }
      const assertNavigation = this.captureTranscriptNavigationAssertion();
      const appendIntent =
        !this.pendingDeliberateAppend && this.appendMode !== "side" ? "active-branch" : undefined;
      const admittedUserId = this.persistenceTarget
        ? resolveSessionTranscriptReadFence(this.persistenceTarget)?.entryId
        : undefined;
      const committedTarget = publication.target;
      const committed = await this.persistWorkerRecord(
        canonical,
        appendIntent,
        admission,
        undefined,
        undefined,
        undefined,
        true,
        assertNavigation,
        initialModel,
      );
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
        assertNavigation();
        await this.adoptWorkerCommittedEntry(canonical, committed, admittedUserId, initialModel);
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

  [sessionManagerAppendInitialMetadata](
    provider: string,
    modelId: string,
    thinkingLevel: string,
  ): Promise<string> {
    return this.appendMetadataEntry(
      { type: "thinking_level_change", thinkingLevel },
      { type: "model_change", provider, modelId },
    );
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
