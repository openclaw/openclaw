import { buildSessionContext as buildCoreSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import type { ImageContent, TextContent } from "../../llm/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import type { SessionTreeEntry as CoreSessionTreeEntry } from "../runtime/index.js";
import { SessionManagerAppend } from "./session-manager-append.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import { prepareSessionManagerSync } from "./session-manager-incognito-scope.js";
import { SessionManagerActorCommittedError } from "./session-manager-persistence-error.js";
import type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  LabelEntry,
  ResetEntry,
  ResetReason,
  SessionContext,
  SessionEntry,
  SessionInfoEntry,
  SessionLeafControl,
} from "./session-manager-types.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";

export class SessionManagerEntries extends SessionManagerAppend {
  private createEntry<T extends { type: SessionEntry["type"] }>(data: T) {
    return {
      ...data,
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
    };
  }

  async appendCompactionAsync(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
    metadata?: CompactionEntry["__openclaw"],
    tokensAfter?: number,
  ): Promise<string> {
    const entry: CompactionEntry = this.createEntry({
      type: "compaction",
      summary,
      firstKeptEntryId,
      tokensBefore,
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      details,
      fromHook,
      ...(metadata?.runId || metadata?.itemId ? { __openclaw: metadata } : {}),
    });
    await this.appendEntryAsync(entry, {
      invalidateSerializedPrefixCache: fromHook === true || details !== undefined,
    });
    return entry.id;
  }

  /** @deprecated Await appendCompactionAsync. Removal: next Plugin SDK major. */
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
    metadata?: CompactionEntry["__openclaw"],
    tokensAfter?: number,
  ): string {
    prepareSessionManagerSync("appendCompaction", this.persistenceTarget, this);
    const entry: CompactionEntry = this.createEntry({
      type: "compaction",
      summary,
      firstKeptEntryId,
      tokensBefore,
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      details,
      fromHook,
      ...(metadata?.runId || metadata?.itemId ? { __openclaw: metadata } : {}),
    });
    this.appendEntry(entry, {
      invalidateSerializedPrefixCache: fromHook === true || details !== undefined,
    });
    return entry.id;
  }

  async appendResetBoundaryAsync(reason: ResetReason, firstKeptEntryId?: string): Promise<string> {
    const entry: ResetEntry = this.createEntry({
      type: "reset",
      reason,
      ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
    });
    await this.appendEntryAsync(entry);
    return entry.id;
  }

  /** @deprecated Await appendResetBoundaryAsync. Removal: next Plugin SDK major. */
  appendResetBoundary(reason: ResetReason, firstKeptEntryId?: string): string {
    prepareSessionManagerSync("appendResetBoundary", this.persistenceTarget, this);
    const entry: ResetEntry = this.createEntry({
      type: "reset",
      reason,
      ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
    });
    this.appendEntry(entry);
    return entry.id;
  }

  async appendCustomEntryAsync(customType: string, data?: unknown): Promise<string> {
    const entry: CustomEntry = this.createEntry({
      type: "custom",
      customType,
      data,
      timestamp: new Date().toISOString(),
    });
    await this.appendEntryAsync(entry, { invalidateSerializedPrefixCache: true });
    return entry.id;
  }

  /** @deprecated Await appendCustomEntryAsync. Removal: next Plugin SDK major. */
  appendCustomEntry(customType: string, data?: unknown): string {
    prepareSessionManagerSync("appendCustomEntry", this.persistenceTarget, this);
    const entry: CustomEntry = this.createEntry({
      type: "custom",
      customType,
      data,
      timestamp: new Date().toISOString(),
    });
    this.appendEntry(entry, { invalidateSerializedPrefixCache: true });
    return entry.id;
  }

  async appendSessionInfoAsync(name: string): Promise<string> {
    const entry: SessionInfoEntry = this.createEntry({
      type: "session_info",
      name: name.replace(/[\r\n]+/g, " ").trim(),
    });
    await this.appendEntryAsync(entry);
    return entry.id;
  }

  /** @deprecated Await appendSessionInfoAsync. Removal: next Plugin SDK major. */
  appendSessionInfo(name: string): string {
    prepareSessionManagerSync("appendSessionInfo", this.persistenceTarget, this);
    const entry: SessionInfoEntry = this.createEntry({
      type: "session_info",
      name: name.replace(/[\r\n]+/g, " ").trim(),
    });
    this.appendEntry(entry);
    return entry.id;
  }

  async appendCustomMessageEntryAsync(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: unknown,
  ): Promise<string> {
    const entry: CustomMessageEntry = this.createEntry({
      type: "custom_message",
      customType,
      content,
      display,
      details,
      timestamp: new Date().toISOString(),
    });
    await this.appendEntryAsync(entry, { invalidateSerializedPrefixCache: true });
    return entry.id;
  }

  /** @deprecated Await appendCustomMessageEntryAsync. Removal: next Plugin SDK major. */
  appendCustomMessageEntry(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: unknown,
  ): string {
    prepareSessionManagerSync("appendCustomMessageEntry", this.persistenceTarget, this);
    const entry: CustomMessageEntry = this.createEntry({
      type: "custom_message",
      customType,
      content,
      display,
      details,
      timestamp: new Date().toISOString(),
    });
    this.appendEntry(entry, { invalidateSerializedPrefixCache: true });
    return entry.id;
  }

  async appendLeafControlAsync(params: {
    targetId: string | null;
    appendParentId: string | null;
    appendMode?: "side";
  }): Promise<SessionLeafControl> {
    const captured = { ...params };
    return await withSessionManagerWrite(this, async (admission) => {
      this.assertTranscriptWriteActive();
      this.validateLeafControl(captured);
      if (
        !admission ||
        (isIncognitoSessionKey(this.persistenceTarget?.sessionKey) && "db" in admission.database)
      ) {
        return this.appendLeafControlSync(captured);
      }
      const previousLeafId = this.leafId;
      this.leafId = captured.targetId;
      const entry = this.createLeafControl(
        this.appendParentId,
        captured.appendParentId,
        captured.appendMode,
      );
      this.leafId = previousLeafId;
      const target = this.getSessionTarget();
      const assertNavigation = this.captureTranscriptNavigationAssertion();
      // This control selects the loaded tree; retrying could hide a newer user turn.
      const committed = await this.persistWorkerRecord(
        entry,
        undefined,
        admission,
        undefined,
        undefined,
        this.transcriptMutationAt,
        false,
        assertNavigation,
      );
      try {
        if (!sameSessionTranscriptTargetBinding(target, this.getSessionTarget())) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        assertNavigation();
        if (committed.viewFailure instanceof SessionManagerActorCommittedError) {
          throw committed.viewFailure;
        }
        if (!this.hasNewerPublishedTranscriptView(committed.committedVersion)) {
          if (committed.viewFailure) {
            throw committed.viewFailure;
          }
          this.transcriptVersion = committed.committedVersion;
          this.transcriptMutationAt = committed.committedVersion.updatedAt;
          if (committed.reload) {
            this.adoptPreparedTranscriptReload(committed.reload);
          } else {
            this.rememberLeafControl(entry);
            this.leafId = captured.targetId;
            this.appendParentId = captured.appendParentId;
            this.appendMode = captured.appendMode;
            this.pendingDeliberateAppend = false;
          }
        }
        return entry;
      } catch (cause) {
        const error = new Error(
          "Session leaf committed, but its view could not be adopted; do not replay the write",
          { cause },
        );
        recordModelFallbackStop(error);
        this.invalidateTranscriptView(error);
        throw error;
      }
    });
  }

  /** @deprecated Await appendLeafControlAsync. Removal: next Plugin SDK major. */
  appendLeafControl(params: {
    targetId: string | null;
    appendParentId: string | null;
    appendMode?: "side";
  }): SessionLeafControl {
    prepareSessionManagerSync("appendLeafControl", this.persistenceTarget, this);
    return this.appendLeafControlSync(params);
  }

  private validateLeafControl(params: {
    targetId: string | null;
    appendParentId: string | null;
  }): void {
    this.assertTranscriptViewAvailable();
    if (params.targetId !== null && !this.byId.has(params.targetId)) {
      throw new Error(`Entry ${params.targetId} not found`);
    }
    if (
      params.appendParentId !== null &&
      !this.byId.has(params.appendParentId) &&
      !this.opaqueParentsById.has(params.appendParentId)
    ) {
      throw new Error(`Append parent ${params.appendParentId} not found`);
    }
  }

  protected appendLeafControlSync(params: {
    targetId: string | null;
    appendParentId: string | null;
    appendMode?: "side";
  }): SessionLeafControl {
    this.validateLeafControl(params);
    const previousLeafId = this.leafId;
    this.leafId = params.targetId;
    const entry = this.createLeafControl(
      this.appendParentId,
      params.appendParentId,
      params.appendMode,
    );
    this.leafId = previousLeafId;
    this.persistRecord(entry);
    this.rememberLeafControl(entry);
    this.leafId = params.targetId;
    this.appendParentId = params.appendParentId;
    this.appendMode = params.appendMode;
    this.pendingDeliberateAppend = false;
    return entry;
  }

  async appendLabelChangeAsync(targetId: string, label: string | undefined): Promise<string> {
    const entry: LabelEntry = this.createEntry({
      type: "label",
      targetId,
      label,
    });
    await this.appendEntryAsync(entry);
    return entry.id;
  }

  /** @deprecated Await appendLabelChangeAsync. Removal: next Plugin SDK major. */
  appendLabelChange(targetId: string, label: string | undefined): string {
    prepareSessionManagerSync("appendLabelChange", this.persistenceTarget, this);
    this.assertTranscriptViewAvailable();
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const entry: LabelEntry = this.createEntry({
      type: "label",
      targetId,
      label,
    });
    this.appendEntry(entry);
    return entry.id;
  }

  buildSessionContext(): SessionContext {
    return buildCoreSessionContext(this.getBranch() as CoreSessionTreeEntry[]) as SessionContext;
  }

  async branchAsync(branchFromId: string): Promise<void> {
    await withSessionManagerWrite(this, async () => {
      if (!this.byId.has(branchFromId)) {
        await this.ensureCompletePersistedHistoryAsync();
      }
      this.branchSync(branchFromId);
    });
  }

  /** @deprecated Await branchAsync. Removal: next Plugin SDK major. */
  branch(branchFromId: string): void {
    prepareSessionManagerSync("branch", this.persistenceTarget, this);
    this.branchSync(branchFromId);
  }

  protected branchSync(branchFromId: string): void {
    this.assertTranscriptViewAvailable();
    if (!this.byId.has(branchFromId)) {
      this.ensureCompletePersistedHistory();
    }
    const branchTargetId = this.resolveBranchTargetId(branchFromId);
    if (branchTargetId === undefined) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.recordTranscriptNavigationChange();
    this.leafId = branchTargetId;
    this.appendParentId = branchTargetId;
    this.appendMode = undefined;
    this.pendingDeliberateAppend = true;
  }

  resetLeaf(): void {
    this.assertTranscriptViewAvailable();
    this.recordTranscriptNavigationChange();
    this.leafId = null;
    this.appendParentId = null;
    this.appendMode = undefined;
    this.pendingDeliberateAppend = true;
  }

  async resetLeafAsync(): Promise<void> {
    await withSessionManagerWrite(this, () => this.resetLeaf());
  }

  async branchWithSummaryAsync(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): Promise<string> {
    return await withSessionManagerWrite(this, async () => {
      if (branchFromId !== null && !this.byId.has(branchFromId)) {
        await this.ensureCompletePersistedHistoryAsync();
      }
      const branchTargetId =
        branchFromId === null ? null : this.resolveBranchTargetId(branchFromId);
      if (branchTargetId === undefined) {
        throw new Error(`Entry ${branchFromId} not found`);
      }
      const entry: BranchSummaryEntry = {
        type: "branch_summary",
        id: generateSessionEntryId(),
        parentId: branchTargetId,
        timestamp: new Date().toISOString(),
        fromId: branchTargetId ?? "root",
        summary,
        details,
        fromHook,
      };
      await this.appendEntryAsync(
        entry,
        {
          invalidateSerializedPrefixCache: fromHook === true || details !== undefined,
        },
        true,
      );
      return entry.id;
    });
  }

  /** @deprecated Await branchWithSummaryAsync. Removal: next Plugin SDK major. */
  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    prepareSessionManagerSync("branchWithSummary", this.persistenceTarget, this);
    if (branchFromId !== null && !this.byId.has(branchFromId)) {
      this.ensureCompletePersistedHistory();
    }
    const branchTargetId = branchFromId === null ? null : this.resolveBranchTargetId(branchFromId);
    if (branchTargetId === undefined) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    const entry: BranchSummaryEntry = {
      type: "branch_summary",
      id: generateSessionEntryId(),
      parentId: branchTargetId,
      timestamp: new Date().toISOString(),
      fromId: branchTargetId ?? "root",
      summary,
      details,
      fromHook,
    };
    this.appendEntry(entry, {
      invalidateSerializedPrefixCache: fromHook === true || details !== undefined,
    });
    return entry.id;
  }
}
