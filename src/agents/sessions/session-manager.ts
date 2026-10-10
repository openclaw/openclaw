/**
 * Session tree manager backed by an explicit SQLite transcript identity.
 *
 * The public facade lives here; codec, storage, persistence, and branching
 * behavior are split into focused internal modules.
 */
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import { prepareTranscriptRewriteSync } from "../../config/sessions/session-accessor.sqlite-branch-rewrite.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  readSessionTranscriptContextMessages,
  readSessionTranscriptModelContext,
  type SessionModelContextLimits,
} from "../../config/sessions/session-accessor.sqlite-model-context.js";
import { loadTranscriptReadSnapshotSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { redactTranscriptMessageForStorage } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { appendTranscriptMessageSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  assertCurrentSessionTranscriptHeader,
  findSessionTranscriptHeader,
} from "../../config/sessions/session-entry-codec.js";
import type { PreparedSessionTranscriptModelContext } from "../../config/sessions/session-transcript-context-read.js";
import { withSessionContextAdmission } from "../../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { targetDiscoveryLane } from "../../config/sessions/session-transcript-worker-resources.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import {
  sameSessionTranscriptTargetBinding,
  captureSessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import {
  withOwnedSessionTranscriptWriterFence,
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptReader,
} from "../../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import type { Message } from "../../llm/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { SessionManagerBranching } from "./session-manager-branching.js";
import { cloneSessionModelContextEntries } from "./session-manager-codec.js";
import { sessionManagerOpenTranscriptCohort } from "./session-manager-core.js";
import {
  sessionManagerReadInitialContext,
  sessionManagerReadTranscriptStart,
} from "./session-manager-current-turn.js";
import { prepareSessionManagerSync } from "./session-manager-incognito-scope.js";
import {
  prepareSessionManagerHydration,
  readSessionManagerContextAsync,
  readSessionManagerModelContextAsync,
} from "./session-manager-incognito.js";
import { receiveSessionManagerCommit } from "./session-manager-persistence-error.js";
import { openSessionManagerBoundedView } from "./session-manager-reload.js";
import type {
  SessionLeafControl,
  AppendPersistenceOptions,
  FileEntry,
  SessionEntry,
} from "./session-manager-types.js";
import type {
  SessionManagerBoundedContext,
  SessionManagerBoundedContextLimits,
  SessionManagerPersistenceTarget,
  SessionManagerTranscriptCohort,
} from "./session-manager-view-types.js";
import {
  appendSessionTranscriptNote,
  withSessionManagerWrite,
} from "./session-manager-write-admission.js";
import {
  runSessionPersistenceAsync,
  runSessionPersistenceSync,
  sessionPersistenceStep,
  type SessionPersistenceStep,
} from "./session-persistence-operation.js";

export { CURRENT_SESSION_VERSION };
export {
  buildSessionContext,
  getLatestCompactionEntry,
  migrateSessionEntries,
  parseSessionEntries,
} from "./session-manager-codec.js";
export type {
  BranchSummaryEntry,
  CompactionEntry,
  FileEntry,
  SessionEntry,
  SessionHeader,
  SessionLeafControl,
  SessionMessageEntry,
} from "./session-manager-types.js";

export class SessionManager extends SessionManagerBranching {
  private preparedInitialContext:
    | (PreparedSessionTranscriptModelContext & { view: object })
    | undefined;

  private constructor(
    cwd: string,
    persistenceTarget?: SessionManagerPersistenceTarget,
    loadedEntries?: readonly unknown[],
    boundedContext?: SessionManagerBoundedContext,
    version?: SessionTranscriptContextVersion,
  ) {
    super(cwd, persistenceTarget, loadedEntries, boundedContext, version);
    this.retainTranscriptWriter();
  }

  [sessionManagerReadTranscriptStart]() {
    this.assertTranscriptWriteActive();
    const target = this.persistenceTarget;
    const version = this.transcriptVersion;
    return target && version
      ? {
          agentId: target.agentId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          storePath: target.storePath,
          generation: version.generation,
          maxSeq: version.rawSeq,
        }
      : null;
  }

  async [sessionManagerReadInitialContext]() {
    const prepared = this.preparedInitialContext;
    this.preparedInitialContext = undefined;
    if (!this.persistenceTarget || !this.boundedContextLimits || this.pendingDeliberateAppend) {
      return this.buildSessionContext();
    }
    // A deliberate local branch owns its view; a concurrent selection must not
    // install the database's different active path into the same writer.
    const initial = this.captureTranscriptView();
    const target = this.persistenceTarget;
    const cwd = this.cwd;
    const context = await readSessionManagerModelContextAsync(
      target,
      {
        limits: this.boundedContextLimits,
        ...(prepared &&
        Object.keys(prepared.view).every(
          (key) => Reflect.get(prepared.view, key) === Reflect.get(initial, key),
        )
          ? { prepared }
          : {}),
      },
      (snapshot) => SessionManager.fromSelectedEntries(snapshot.events, cwd),
      this,
    );
    const current = this.captureTranscriptView();
    if (
      Object.keys(initial).some((key) => Reflect.get(initial, key) !== Reflect.get(current, key))
    ) {
      throw new Error("Session manager changed during initial context read");
    }
    for (const entry of context.fileEntries) {
      if (entry.type !== "message") {
        continue;
      }
      const stored = this.byId.get(entry.id);
      if (stored?.type !== "message") {
        continue;
      }
      // The worker projects private fields away; equal payloads can share immutable custody.
      if (isDeepStrictEqual(entry.message, stored.message)) {
        entry.message = freezeJsonSnapshot(stored.message);
      } else {
        for (const key of Object.keys(entry.message)) {
          const value: unknown = Reflect.get(stored.message, key);
          if (isDeepStrictEqual(Reflect.get(entry.message, key), value)) {
            Reflect.set(entry.message, key, freezeJsonSnapshot(value));
          }
        }
        freezeJsonSnapshot(entry.message);
      }
    }
    return context.buildSessionContext();
  }

  /** No buffered writes remain here; asynchronous metadata methods own their settlement. */
  flushPendingPersistence(): void {}

  // Worker rollback instrumentation wraps the method on this public prototype.
  /** @deprecated Await appendMessageAsync. Removal: next Plugin SDK major. */
  override appendMessage(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): string {
    return super.appendMessage(message, options);
  }

  /** @deprecated Await appendMessageWithTranscriptAnchorAsync. Removal: next Plugin SDK major. */
  override appendMessageWithTranscriptAnchor(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ) {
    return super.appendMessageWithTranscriptAnchor(message, options);
  }

  /** @deprecated Use prepareTranscriptRewriteAsync; removed at the next Plugin SDK major. */
  prepareTranscriptRewrite() {
    prepareSessionManagerSync("prepareTranscriptRewrite", this.persistenceTarget, this);
    this.assertTranscriptWriteActive();
    const publish = this.persistenceTarget
      ? prepareTranscriptRewriteSync(
          this.persistenceTarget,
          this.appendParentId,
          () => this.assertTranscriptWriteActive(),
          this.transcriptVersion,
        )
      : undefined;
    const rewrite = this.prepareTranscriptRewriteView(publish);
    return {
      sessionManager: rewrite.sessionManager,
      commit: (ids: ReadonlyMap<string, string>) => runSessionPersistenceSync(rewrite.commit(ids)),
    };
  }

  /** Preparation returns a detached branch; only its awaited commit publishes changes. */
  async prepareTranscriptRewriteAsync() {
    return withSessionManagerWrite(this, async (writeAdmission) => {
      this.assertTranscriptWriteActive();
      const assertNavigation = this.captureTranscriptNavigationAssertion();
      const target = this.persistenceTarget;
      if (
        !target ||
        (isIncognitoSessionKey(target.sessionKey) &&
          writeAdmission &&
          "db" in writeAdmission.database)
      ) {
        const detachedView = target ? undefined : structuredClone(this.captureTranscriptView());
        const assertPrepared = () => {
          assertNavigation();
          if (
            detachedView &&
            (this.persistenceTarget ||
              !isDeepStrictEqual(this.captureTranscriptView(), detachedView))
          ) {
            throw new Error("Session transcript changed before rewrite publication");
          }
        };
        // Incognito remains process-owned until its worker migration activates.
        const publish = target
          ? prepareTranscriptRewriteSync(
              target,
              this.appendParentId,
              () => {
                this.assertTranscriptWriteActive();
                assertNavigation();
              },
              this.transcriptVersion,
            )
          : undefined;
        const rewrite = this.prepareTranscriptRewriteView(publish, undefined, assertPrepared);
        return {
          sessionManager: rewrite.sessionManager,
          commit: async (ids: ReadonlyMap<string, string>) => {
            assertPrepared();
            return withSessionManagerWrite(this, () => {
              assertPrepared();
              return runSessionPersistenceAsync(rewrite.commit(ids));
            });
          },
        };
      }
      const identity = { ...target };
      const loadedVersion = this.transcriptVersion;
      const appendParentId = this.appendParentId;
      const assertOwned = captureOwnedTranscriptWriteAssertion(identity);
      const assertCurrent = () => {
        writeAdmission?.assertCurrent();
        this.assertTranscriptWriteActive();
        assertOwned();
        assertNavigation();
        if (
          !sameSessionTranscriptTargetBinding(identity, this.persistenceTarget) ||
          this.transcriptVersion !== loadedVersion
        ) {
          throw new Error("Session transcript changed before rewrite publication");
        }
      };
      const reader = prepareSessionManagerHydration(target, { lane: targetDiscoveryLane });
      const facts = await reader.readMaintenance({ operation: "version" });
      reader.assertCurrent();
      assertCurrent();
      const version = facts.version;
      if (
        !version ||
        !loadedVersion ||
        version.generation !== loadedVersion.generation ||
        version.rawSeq !== loadedVersion.rawSeq ||
        facts.appendParentId !== appendParentId
      ) {
        throw new Error("Session transcript changed before rewrite publication");
      }
      const rewrite = this.prepareTranscriptRewriteView(
        undefined,
        async (entries, sources, adopt) => {
          await withSessionManagerWrite(this, async (admission) => {
            assertCurrent();
            if (!admission) {
              throw new Error("Transcript rewrite lost its persistent owner");
            }
            const assertCommitCurrent = () => {
              admission.assertCurrent();
              assertCurrent();
            };
            for (const entry of entries) {
              if (entry.type === "message") {
                entry.message = redactTranscriptMessageForStorage(entry.message, {});
              }
            }
            const { withSessionMetadataWorker } =
              await import("./session-manager-metadata-runtime.js");
            assertCommitCurrent();
            const { env: _env, ...scope } = withOwnedSessionTranscriptWriterFence(target);
            const receipt = await receiveSessionManagerCommit("session.transcript.rewrite", () =>
              withSessionMetadataWorker(
                admission.options,
                admission.database,
                assertCommitCurrent,
                (worker) =>
                  worker.execute({
                    type: "session.transcript.rewrite",
                    input: {
                      scope: { ...scope, storePath: admission.database.path },
                      appendParentId,
                      version,
                      entries,
                      sources: [...sources],
                    },
                  }),
              ),
            );
            const committed = receipt.value;
            if (committed.projectionNeedsReconcile && !receipt.failure) {
              startSessionTranscriptIndexReconcile({
                ...admission.options,
                preferredSessionId: identity.sessionId,
              });
            }
            try {
              if (receipt.failure) {
                throw receipt.failure;
              }
              assertCommitCurrent();
              for (const [index, entry] of committed.entries.entries()) {
                Object.assign(entries[index]!, entry);
              }
              adopt(committed.version);
            } catch (cause) {
              const error = new Error(
                "Session transcript rewrite committed but view publication failed",
                { cause },
              );
              this.invalidateTranscriptView(error);
              throw error;
            }
          });
        },
      );
      return {
        sessionManager: rewrite.sessionManager,
        commit: (ids: ReadonlyMap<string, string>) =>
          withSessionManagerWrite(this, () => runSessionPersistenceAsync(rewrite.commit(ids))),
      };
    });
  }

  private prepareTranscriptRewriteView(
    publish?: (
      entries: Array<SessionEntry | SessionLeafControl>,
      sources: ReadonlyMap<string, SessionEntry>,
      adopt: (version: SessionTranscriptContextVersion) => void,
    ) => void,
    publishAsync?: (
      entries: Array<SessionEntry | SessionLeafControl>,
      sources: ReadonlyMap<string, SessionEntry>,
      adopt: (version: SessionTranscriptContextVersion) => void,
    ) => Promise<void>,
    assertBeforeCommit?: () => void,
  ) {
    const prepared = SessionManager.inMemory(this.cwd);
    Object.assign(prepared, structuredClone(this.captureTranscriptView()));
    const initialEntryCount = prepared.fileEntries.length;
    const persistedBoundaryCount = prepared.persistedBoundaryCount;
    prepared.persistedBoundaryCount = undefined;
    const loadedBoundaryCount = prepared.getBoundaryCount();
    return {
      sessionManager: prepared,
      commit: function* (
        this: SessionManager,
        rewrittenEntryIds: ReadonlyMap<string, string>,
      ): Generator<SessionPersistenceStep, void, void> {
        const publication = SessionManager.inMemory(prepared.cwd);
        Object.assign(publication, structuredClone(prepared.captureTranscriptView()));
        const entries = publication.fileEntries
          .slice(initialEntryCount)
          .filter((entry) => entry.type !== "session");
        const sources = new Map<string, SessionEntry>();
        for (const [sourceId, destination] of rewrittenEntryIds) {
          const source = this.byId.get(sourceId);
          if (!source) {
            throw new Error("Transcript rewrite source is not in the loaded view");
          }
          sources.set(destination, source);
          for (const prefix of publication.cacheTtlProjectionPrefixes ?? []) {
            if (prefix.anchorIds.includes(sourceId)) {
              prefix.anchorIds.push(destination);
            }
          }
        }
        const first = entries[0];
        const source = first && sources.get(first.id);
        const parentId = source ? this.boundedParentIds.get(source.id) : undefined;
        // The bounded reader owns logical ancestry, including parents outside its payload window.
        if (first?.parentId === null && parentId !== undefined) {
          first.parentId = parentId;
          publication.boundedParentIds.set(first.id, first.parentId);
        }
        // A maintenance branch may cross a reset. Side entries preserve its
        // explicit ancestry; ordinary appends would normalize onto the old leaf.
        for (const entry of entries) {
          entry.appendMode = "side";
        }
        // Reconstruct with the reader's canonical reset/leaf rules, then retain
        // the bounded reader's ancestry for payloads absent from the loaded view.
        publication.buildIndex();
        for (const [id, parent] of this.opaqueParentsById) {
          publication.opaqueParentsById.set(id, parent);
        }
        for (const [id, parent] of this.logicalParentsById) {
          publication.logicalParentsById.set(id, parent);
        }
        const last = entries.at(-1);
        const leaf = last
          ? yield* sessionPersistenceStep(
              () =>
                publication.appendLeafControlSync({ targetId: last.id, appendParentId: last.id }),
              () =>
                publication.appendLeafControlAsync({ targetId: last.id, appendParentId: last.id }),
            )
          : undefined;
        if (persistedBoundaryCount !== undefined) {
          publication.persistedBoundaryCount =
            persistedBoundaryCount + publication.getBoundaryCount() - loadedBoundaryCount;
        }
        const adopt = (version = publication.transcriptVersion) => {
          publication.transcriptVersion = version;
          publication.transcriptMutationAt = version?.updatedAt;
          Object.assign(this, publication.captureTranscriptView());
        };
        const events = leaf ? [...entries, leaf] : entries;
        assertBeforeCommit?.();
        yield* sessionPersistenceStep(
          () => (publish ? publish(events, sources, adopt) : adopt()),
          publishAsync ? () => publishAsync(events, sources, adopt) : undefined,
        );
      }.bind(this),
    };
  }

  /** Opens an existing store off-thread; empty transcripts keep lazy header initialization. */
  static async openAsync(
    target: SessionTranscriptRuntimeTarget,
    cwdOverride?: string,
    contextLimits?: SessionManagerBoundedContextLimits,
    signal?: AbortSignal,
  ): Promise<SessionManager> {
    if (contextLimits) {
      return await SessionManager.openBoundedAsync(target, {
        ...contextLimits,
        cwd: cwdOverride,
        signal,
      });
    }
    const hydration = prepareSessionManagerHydration(target, { signal });
    const cwd = cwdOverride ?? process.cwd();
    const assertOwned = captureOwnedTranscriptWriteAssertion(hydration.target);
    assertOwned();
    const prepared = await hydration.read().catch((error: unknown) => {
      assertOwned();
      throw error;
    });
    signal?.throwIfAborted();
    assertOwned();
    hydration.assertCurrent();
    if (prepared.kind !== "full") {
      throw new Error("Expected a full transcript snapshot");
    }
    const entries = prepared.snapshot.events;
    const header = findSessionTranscriptHeader(entries);
    return new SessionManager(
      cwdOverride ?? header?.cwd ?? cwd,
      hydration.target,
      entries,
      undefined,
      prepared.snapshot.version,
    );
  }

  /** @deprecated Runtime callers should await openAsync. */
  static open(
    target: SessionTranscriptRuntimeTarget,
    cwdOverride?: string,
    contextLimits?: SessionManagerBoundedContextLimits,
  ): SessionManager {
    prepareSessionManagerSync("open", target);
    if (contextLimits) {
      return SessionManager.openBounded(target, {
        ...contextLimits,
        ...(cwdOverride !== undefined ? { cwd: cwdOverride } : {}),
      });
    }
    const capturedTarget = captureSessionTranscriptTargetBinding(target);
    const snapshot = loadTranscriptReadSnapshotSync(capturedTarget);
    const entries = snapshot.events as FileEntry[];
    const header = entries.find(
      (entry) => typeof entry === "object" && entry !== null && entry.type === "session",
    );
    return new SessionManager(
      cwdOverride ?? header?.cwd ?? process.cwd(),
      capturedTarget,
      entries,
      undefined,
      snapshot.version,
    );
  }

  /** @deprecated Runtime callers should await openBoundedAsync. */
  static openBounded(
    target: SessionTranscriptRuntimeTarget,
    options: SessionManagerBoundedContextLimits & { cwd?: string; onTruncated?: () => void },
  ): SessionManager {
    prepareSessionManagerSync("openBounded", target);
    const { cwd, onTruncated, ...limits } = options;
    const capturedTarget = captureSessionTranscriptTargetBinding(target);
    const context = readSessionTranscriptBoundedActiveContextCore(capturedTarget, limits);
    if (context.truncated) {
      onTruncated?.();
    }
    // SAFETY: The accessor returns the same persisted transcript event union consumed by open().
    const entries = context.events as FileEntry[];
    const header = entries.find(
      (entry) => typeof entry === "object" && entry !== null && entry.type === "session",
    );
    return new SessionManager(cwd ?? header?.cwd ?? process.cwd(), capturedTarget, entries, {
      ...context,
      limits,
    });
  }

  /** Reads an existing store's bounded view under the history worker's database custody. */
  static async [sessionManagerOpenTranscriptCohort](
    target: SessionTranscriptRuntimeTarget,
    options: SessionManagerBoundedContextLimits & { cwd?: string; signal?: AbortSignal },
    selection: SessionManagerTranscriptCohort["selection"],
    consume: (
      manager: SessionManager,
      ...prepared: Parameters<SessionManagerTranscriptCohort["consume"]>
    ) => void,
  ): Promise<SessionManager> {
    return openSessionManagerBoundedView(
      target,
      options,
      (cwd, captured, context, limits) => {
        const manager = new SessionManager(cwd, captured, context.events, { ...context, limits });
        const branch = manager.getBranch();
        const reader = context.completeActivePath && getOwnedSessionTranscriptReader(captured);
        const writeToken = reader && readSqliteDatabaseWriteTokenForPath(reader.database.path);
        if (writeToken && !manager.migrated && branch.length === context.totalEvents) {
          const events = cloneSessionModelContextEntries(manager.getHeader(), branch);
          manager.preparedInitialContext = {
            context: { events, version: context.version },
            writeToken,
            view: manager.captureTranscriptView(),
          };
        }
        return manager;
      },
      { selection, consume, captureView: (manager) => manager.captureTranscriptView() },
    );
  }

  /** Reads an existing store's bounded view under the history worker's database custody. */
  static async openBoundedAsync(
    target: SessionTranscriptRuntimeTarget,
    options: SessionManagerBoundedContextLimits & {
      cwd?: string;
      onTruncated?: () => void;
      signal?: AbortSignal;
    },
  ): Promise<SessionManager> {
    return openSessionManagerBoundedView(
      target,
      options,
      (cwd, captured, context, limits) =>
        new SessionManager(cwd, captured, context.events, { ...context, limits }),
    );
  }

  private static detachBounded(source: SessionManager) {
    const detached = SessionManager.fromSelectedEntries(
      [source.getHeader(), ...source.getBranch()],
      source.getCwd(),
    );
    detached.cacheTtlProjectionPrefixes = source.cacheTtlProjectionPrefixes;
    return detached;
  }

  /** Detach the prepared bounded branch without retaining database custody. */
  static async openDetachedBoundedAsync(
    target: SessionTranscriptRuntimeTarget,
    options: Parameters<typeof SessionManager.openBoundedAsync>[1],
  ): Promise<SessionManager> {
    return SessionManager.detachBounded(await SessionManager.openBoundedAsync(target, options));
  }

  /** @deprecated Runtime callers should await openDetachedBoundedAsync. */
  static openDetachedBounded(
    target: SessionTranscriptRuntimeTarget,
    options: Parameters<typeof SessionManager.openBounded>[1],
  ): SessionManager {
    prepareSessionManagerSync("openDetachedBounded", target);
    return SessionManager.detachBounded(SessionManager.openBounded(target, options));
  }

  /** @deprecated Await openModelContextAsync. Removal: next Plugin SDK major. */
  static openModelContext(
    target: SessionTranscriptRuntimeTarget,
    options: {
      cwd?: string;
      admission?: UserTurnTranscriptAdmissionReceipt;
      through?: TranscriptEntryAnchor;
      limits?: SessionModelContextLimits;
    } = {},
  ): SessionManager {
    prepareSessionManagerSync("openModelContext", target);
    const context = withSessionContextAdmission(target, options.admission, () =>
      readSessionTranscriptModelContext(target, options.through, options.limits),
    );
    return SessionManager.fromSelectedEntries(context.events, options.cwd);
  }

  /** The same detached model view, with durable transcript scanning off the event loop. */
  static async openModelContextAsync(
    target: SessionTranscriptRuntimeTarget,
    options: {
      cwd?: string;
      admission?: UserTurnTranscriptAdmissionReceipt;
      signal?: AbortSignal;
      through?: TranscriptEntryAnchor;
      limits?: SessionModelContextLimits;
    } = {},
  ): Promise<SessionManager> {
    return readSessionManagerModelContextAsync(target, options, (context) =>
      SessionManager.fromSelectedEntries(context.events, options.cwd),
    );
  }

  private static fromSelectedEntries(contextEntries: unknown[], cwd?: string): SessionManager {
    // SAFETY: The transcript owner preserves the entry union; the constructor applies the normal codec.
    const entries = contextEntries as FileEntry[];
    const header = entries.find((entry) => entry.type === "session");
    if (entries.length > 0) {
      assertCurrentSessionTranscriptHeader(header);
    }
    const manager = new SessionManager(cwd ?? header?.cwd ?? process.cwd(), undefined, entries);
    manager.adoptSelectedTranscriptPath(
      manager.appendParentId,
      [...manager.byId].map(([id, entry]) => [id, entry.parentId]),
    );
    return manager;
  }

  /** @deprecated Await readSessionContextAsync. Removal: next Plugin SDK major. */
  static readSessionContext<T>(
    target: SessionTranscriptRuntimeTarget,
    read: (messages: Iterable<AgentMessage>, header: unknown) => T,
    options: { admission?: UserTurnTranscriptAdmissionReceipt } = {},
  ): T {
    prepareSessionManagerSync("readSessionContext", target);
    return withSessionContextAdmission(target, options.admission, () =>
      readSessionTranscriptContextMessages(target, read),
    );
  }

  /** Consume full-fidelity context outside SQL; validate its source after the consumer settles. */
  static async readSessionContextAsync<T>(
    target: SessionTranscriptRuntimeTarget,
    read: (messages: Iterable<AgentMessage>, header: unknown) => T | Promise<T>,
    options: { admission?: UserTurnTranscriptAdmissionReceipt; signal?: AbortSignal } = {},
  ): Promise<T> {
    return readSessionManagerContextAsync(target, read, options);
  }

  /**
   * @deprecated Await appendMessageToTranscriptAsync. Removal: next Plugin SDK major.
   */
  static appendMessageToTranscript(
    target: SessionTranscriptRuntimeTarget,
    message: Message | CustomMessage | BashExecutionMessage,
    options?: Pick<AppendPersistenceOptions, "config">,
  ): string {
    prepareSessionManagerSync("appendMessageToTranscript", target);
    const outcome = appendTranscriptMessageSync(target, {
      cwd: process.cwd(),
      message,
      ...(options?.config ? { config: options.config } : {}),
    });
    if (!outcome.ok) {
      throw new Error("Session transcript message was not persisted", { cause: outcome.error });
    }
    const result = outcome.value;
    if (!result) {
      throw new Error("Session transcript message was not persisted");
    }
    return result.messageId;
  }

  static async appendMessageToTranscriptAsync(
    target: SessionTranscriptRuntimeTarget,
    message: Message | CustomMessage | BashExecutionMessage,
    options?: Pick<AppendPersistenceOptions, "config">,
  ): Promise<string> {
    return (await appendSessionTranscriptNote(target, message, options)).messageId;
  }

  static inMemory(cwd: string = process.cwd()): SessionManager {
    return new SessionManager(cwd);
  }

  static fromEntries(entries: readonly unknown[], cwdOverride?: string): SessionManager {
    const fileEntries = structuredClone(entries) as FileEntry[];
    const header = fileEntries.find(
      (entry) => typeof entry === "object" && entry !== null && entry.type === "session",
    );
    return new SessionManager(cwdOverride ?? header?.cwd ?? process.cwd(), undefined, fileEntries);
  }
}

export type ReadonlySessionManager = Pick<
  SessionManager,
  | "getCwd"
  | "getSessionId"
  | "getSessionTarget"
  | "getLeafId"
  | "getAppendParentId"
  | "getAppendMode"
  | "getLeafEntry"
  | "getEntry"
  | "getLabel"
  | "getBranch"
  | "getHeader"
  | "getEntries"
  | "getTree"
  | "getSessionName"
>;
