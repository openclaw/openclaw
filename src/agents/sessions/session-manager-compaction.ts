import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import { SessionManagerEntries } from "./session-manager-entries.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import { canonicalizeSessionEntry } from "./session-manager-persistence.js";
import type { CompactionEntry } from "./session-manager-types.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";

export class SessionManagerCompaction extends SessionManagerEntries {
  private createCompactionEntry(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
    metadata?: CompactionEntry["__openclaw"],
    tokensAfter?: number,
  ): CompactionEntry {
    return {
      type: "compaction",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      details,
      fromHook,
      ...(metadata?.runId || metadata?.itemId ? { __openclaw: metadata } : {}),
    };
  }

  appendCompaction(...args: Parameters<SessionManagerCompaction["createCompactionEntry"]>): string {
    const entry = this.createCompactionEntry(...args);
    this.appendEntry(entry, {
      invalidateSerializedPrefixCache: entry.fromHook === true || entry.details !== undefined,
    });
    return entry.id;
  }

  async appendCompactionAsync(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
    metadata?: CompactionEntry["__openclaw"],
    tokensAfter?: number,
    publication?: { assertActive?: () => void; onCommitted?: () => void },
  ): Promise<string> {
    return await withSessionManagerWrite(this, async (admission) => {
      this.assertTranscriptWriteActive();
      publication?.assertActive?.();
      const entry = this.createCompactionEntry(
        summary,
        firstKeptEntryId,
        tokensBefore,
        details,
        fromHook,
        metadata,
        tokensAfter,
      );
      if (!admission || isIncognitoSessionKey(this.persistenceTarget?.sessionKey)) {
        const appended = this.appendEntry(entry, {
          invalidateSerializedPrefixCache: fromHook === true || details !== undefined,
        });
        try {
          publication?.onCommitted?.();
        } catch (cause) {
          return this.failCommittedCompaction(cause);
        }
        return appended.entry.id;
      }
      const canonical = canonicalizeSessionEntry(entry);
      const target = this.getSessionTarget();
      const sessionId = this.getSessionId();
      const admittedUserId = target
        ? resolveSessionTranscriptReadFence(target)?.entryId
        : undefined;
      const committed = await this.persistWorkerRecord(
        canonical,
        !this.pendingDeliberateAppend && this.appendMode !== "side" ? "active-branch" : undefined,
        admission,
        undefined,
        publication,
      );
      try {
        if (
          this.getSessionId() !== sessionId ||
          !sameSessionTranscriptTargetBinding(target, this.getSessionTarget())
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        if (committed.publicationFailure) {
          throw committed.publicationFailure;
        }
        return this.adoptWorkerCommittedEntry(canonical, committed, admittedUserId).entry.id;
      } catch (cause) {
        return this.failCommittedCompaction(cause);
      }
    });
  }

  private failCommittedCompaction(cause: unknown): never {
    const error = new Error(
      "Session compaction committed, but its view could not be adopted; do not replay the append",
      { cause },
    );
    error.name = "SessionCompactionCommittedError";
    recordModelFallbackStop(error);
    this.invalidateTranscriptView(error);
    throw error;
  }
}
