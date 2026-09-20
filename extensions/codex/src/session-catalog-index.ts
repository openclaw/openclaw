import { setImmediate as nextTurn } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import type { CodexThread } from "./app-server/protocol.js";
import { CodexCatalogAvailability } from "./session-catalog-availability.js";
import { CodexCatalogCurrency } from "./session-catalog-currency.js";
import { subscribeCodexCatalogEvents } from "./session-catalog-events.js";
import type { CodexCatalogIndexOptions } from "./session-catalog-index-contract.js";
import { readCodexCatalogCursor } from "./session-catalog-index-cursor.js";
import { CodexCatalogIndexEvents } from "./session-catalog-index-events.js";
import { CodexCatalogField } from "./session-catalog-index-field.js";
import { applyCodexCatalogName } from "./session-catalog-index-names.js";
import { CodexCatalogObservations } from "./session-catalog-index-observations.js";
import {
  CodexCatalogOrdering,
  retainCodexCatalogRow,
  type CodexCatalogOrderKey,
} from "./session-catalog-index-order.js";
import { prepareCodexCatalogQuery } from "./session-catalog-index-query.js";
import type {
  CodexCatalogIndexRow,
  CodexCatalogRolloutFingerprint,
} from "./session-catalog-index-row.js";
import {
  codexCatalogMetadataPage,
  CodexCatalogPersistence,
} from "./session-catalog-index-state.js";
import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-limits.js";
import { withCodexCatalogListRequest } from "./session-catalog-list-request.js";
import {
  CodexCatalogNativePages,
  readCodexCatalogHydrationPages,
} from "./session-catalog-native-page.js";
import { projectCodexCatalogNativeThread } from "./session-catalog-native-projection.js";
import {
  projectCodexCatalogThread,
  mergeCodexCatalogRolloutRow,
  CodexCatalogProjections,
  CodexCatalogProjectionCapacityError,
} from "./session-catalog-projection.js";
import {
  scanCodexCatalogRollouts,
  codexCatalogRolloutLogicalPath,
  indexCodexCatalogRowsByRollout,
  isCodexCatalogRolloutPathCovered,
  readCodexCatalogRollout,
  resolveCodexCatalogRolloutFingerprint,
} from "./session-catalog-rollouts.js";
import { CodexCatalogSettingsIndex } from "./session-catalog-settings.js";
import { setCodexCatalogSource } from "./session-catalog-source.js";
import { CodexCatalogStatusIndex } from "./session-catalog-status.js";
import type {
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

type FieldRevision = { status: number; name: number };

/** One home owns resident queries and authoritative overflow discovery. */
export class CodexCatalogIndex {
  private readonly rows = new Map<string, CodexCatalogIndexRow>();
  private readonly availability = new CodexCatalogAvailability();
  private readonly liveStatus = new CodexCatalogStatusIndex();
  private readonly liveSettings = new CodexCatalogSettingsIndex();
  private readonly nativePages = new CodexCatalogNativePages(this.liveSettings, this.liveStatus);
  private readonly names = new CodexCatalogField<string | null>();
  private initializing: Promise<void> | undefined;
  private initialized = false;
  private overflow = false;
  private needsNativeRefresh = false;
  private restored = false;
  private restoring: Promise<void> | undefined;
  private background: NodeJS.Immediate | undefined;
  private failure: { error: unknown } | undefined;
  private closed = false;
  private readonly currency: CodexCatalogCurrency;
  private readonly projections = new CodexCatalogProjections();
  private readonly unsubscribe: () => void;
  private reconciling: Promise<void> | undefined;
  private reconcilingNative: Promise<void> | undefined;
  private observedFiles = new Map<string, CodexCatalogRolloutFingerprint>();
  private readonly persistence: CodexCatalogPersistence;
  private readonly obsoleteStoredKeys = new Set<string>();
  private sourceRevision = 0;
  private readonly ordering = new CodexCatalogOrdering();
  private readonly observations = new CodexCatalogObservations();
  private readonly events: CodexCatalogIndexEvents;

  constructor(private readonly options: CodexCatalogIndexOptions) {
    this.currency = new CodexCatalogCurrency({
      local: Boolean(options.localSessionsRoot),
      reconcileFiles: () => this.reconcile(),
      reconcileNative: (full) => this.reconcileNative(full),
      runBackground: options.runBackground,
      report: (error) => this.report(error),
    });
    this.persistence = new CodexCatalogPersistence(options.state, (error) => this.report(error));
    this.events = new CodexCatalogIndexEvents({
      get: (id) => this.rows.get(id),
      updateStatus: (id, status, source) => {
        this.liveStatus.update(id, status, source);
        if (status.status === "notLoaded") {
          this.liveSettings.withdraw(id, source);
        }
      },
      updateSettings: (id, settings, source) => this.liveSettings.update(id, settings, source),
      rename: (id, name) => {
        this.currency.requestNativeRefresh();
        this.names.update(id, name);
        const row = this.rows.get(id);
        if (row && !this.closed) {
          this.put(row);
        }
      },
      upsert: (thread) => this.upsertThread(thread),
      reserveTurnStartOrder: () => this.ordering.reserveEvent(),
      refresh: (id, readThread, sourceOrder) => this.refreshThread(id, readThread, sourceOrder),
      archive: (id) => this.archive(id),
      remove: (id) => {
        this.currency.requestNativeRefresh();
        this.remove(id);
      },
      report: (error) => this.report(error),
    });
    this.unsubscribe = subscribeCodexCatalogEvents(
      options.homeId,
      (event, readThread, source) => this.events.handle(event, readThread, source),
      {
        onEphemeralThread: (id) => this.remove(id),
        onClose: (source) => {
          this.liveStatus.invalidate(source);
          this.liveSettings.invalidate(source);
        },
        onResume: (response, source) => {
          this.liveSettings.update(response.thread.id, response, source);
          return this.upsertThread(setCodexCatalogSource(response.thread, source));
        },
        onRemoteReady: () => {
          if (this.closed || options.localSessionsRoot) {
            return;
          }
          this.sourceRevision++;
          if (!this.initializing) {
            this.initialized = false;
            this.scheduleHydration();
          }
        },
      },
    );
  }

  private assertCurrent(): void {
    if (this.closed) {
      throw new Error("Codex resident catalog is closed");
    }
    try {
      this.options.assertCurrent();
    } catch (error) {
      void this.close();
      throw error;
    }
  }

  private report(error: unknown): void {
    if (!this.closed) {
      embeddedAgentLog.warn("Codex resident catalog background update failed", { error });
    }
  }

  private withName(row: CodexCatalogIndexRow): CodexCatalogIndexRow {
    const known = this.names.get(row.threadId);
    const name = known !== undefined ? known : this.rows.get(row.threadId)?.page.sessions[0]?.name;
    return applyCodexCatalogName(row, name);
  }

  private put(candidate: CodexCatalogIndexRow): void {
    if (this.closed) {
      return;
    }
    const previous = this.rows.get(candidate.threadId);
    const preview = candidate.preview ?? previous?.preview;
    const patched = this.withName({ ...candidate, ...(preview !== undefined ? { preview } : {}) });
    const row = {
      ...patched,
      page: codexCatalogMetadataPage(patched.page),
      ...(patched.rolloutPath
        ? { rolloutPath: codexCatalogRolloutLogicalPath(patched.rolloutPath) }
        : {}),
      sourceOrder: this.ordering.position(patched, previous),
    };
    if (isDeepStrictEqual(previous, row)) {
      return;
    }
    const oldest = retainCodexCatalogRow(this.rows, row);
    this.overflow ||= this.rows.size >= CODEX_CATALOG_MAX_ROWS;
    this.ordering.invalidate();
    if (oldest?.threadId === row.threadId) {
      return;
    }
    if (oldest) {
      this.evict(oldest.threadId);
    }
    this.persistence.put(row);
  }

  private evict(threadId: string): void {
    // Retention does not withdraw observations supported by an open native connection.
    this.rows.delete(threadId);
    this.ordering.invalidate();
    this.persistence.remove(threadId);
  }

  private remove(threadId: string): void {
    this.observations.mark(threadId);
    this.evict(threadId);
    this.liveStatus.delete(threadId);
    this.liveSettings.delete(threadId);
    this.names.delete(threadId);
  }

  async initialize(): Promise<void> {
    this.assertCurrent();
    clearImmediate(this.background);
    this.background = undefined;
    if (this.initialized && !this.needsNativeRefresh) {
      return;
    }
    if (!this.initializing) {
      this.availability.begin();
      const sourceRevision = this.sourceRevision;
      this.initializing = (async () => {
        await this.restore();
        await this.persistence.pruneObsolete(this.obsoleteStoredKeys, this.rows.values());
        this.obsoleteStoredKeys.clear();
        await this.reconcilingNative?.catch((error: unknown) => this.report(error));
        if (!this.initialized) {
          let observedRevision: number;
          do {
            observedRevision = await this.hydrate(this.availability.complete);
          } while (observedRevision !== this.sourceRevision);
          // A complete replacement walk also satisfies a pending snapshot refresh.
          this.needsNativeRefresh = false;
        }
        if (this.needsNativeRefresh) {
          await this.reconcile();
          await this.reconcileNative();
          this.needsNativeRefresh = false;
        }
        this.initialized = true;
        this.failure = undefined;
        this.currency.start();
      })()
        .catch((error: unknown) => {
          this.failure = { error };
          this.availability.fail(error);
          throw error;
        })
        .finally(() => {
          this.initializing = undefined;
          if (this.failure && sourceRevision !== this.sourceRevision) {
            this.scheduleHydration();
          }
        });
    }
    return this.initializing;
  }

  private async restore(): Promise<void> {
    if (this.restored) {
      return;
    }
    this.restoring ??= this.observations.observe(async (isCurrent) => {
      try {
        const snapshot = await this.persistence.readSnapshot();
        this.assertCurrent();
        if (snapshot.cleanupIncomplete) {
          this.persistence.invalidate(
            new Error("Codex catalog obsolete snapshot exceeds its cleanup limit"),
          );
        }
        for (const key of snapshot.obsolete) {
          this.obsoleteStoredKeys.add(key);
        }
        for (const row of snapshot.rows) {
          if (isCurrent(row.threadId)) {
            const restored = row.rolloutPath
              ? { ...row, rolloutPath: codexCatalogRolloutLogicalPath(row.rolloutPath) }
              : row;
            const patched = this.withName(restored);
            if (patched !== restored) {
              this.persistence.put(patched);
            }
            const evicted = retainCodexCatalogRow(this.rows, patched);
            if (evicted) {
              this.evict(evicted.threadId);
            }
            this.ordering.restore(row);
          }
        }
        this.overflow ||= snapshot.overflow || this.rows.size >= CODEX_CATALOG_MAX_ROWS;
        if (snapshot.complete) {
          this.availability.publish(undefined, true);
          this.initialized = true;
          this.needsNativeRefresh = true;
          this.currency.start();
        }
      } catch (error) {
        // Unknown stored keys cannot be certified by a replacement hydration.
        this.persistence.invalidate(error);
      }
      this.restored = true;
    });
    await this.restoring;
  }

  private scheduleHydration(): void {
    if (
      (this.initialized && !this.needsNativeRefresh) ||
      this.initializing ||
      this.background ||
      this.closed
    ) {
      return;
    }
    this.background = setImmediate(() => {
      this.background = undefined;
      const run = () => this.initialize();
      void (this.options.runBackground ? this.options.runBackground(run) : run()).catch(
        (error: unknown) => this.report(error),
      );
    });
    this.background.unref();
  }

  private captureFields(): FieldRevision {
    return { status: this.liveStatus.capture(), name: this.names.capture() };
  }

  private observeFields(row: CodexCatalogIndexRow, revision: FieldRevision): void {
    const session = row.page.sessions[0];
    if (!session) {
      return;
    }
    this.liveStatus.observe(row, revision.status);
    if (
      session.name !== undefined &&
      this.names.observe(row.threadId, session.name, revision.name)
    ) {
      const current = this.rows.get(row.threadId);
      if (current && current.page.sessions[0]?.name !== session.name) {
        this.put(current);
      }
    }
  }

  private reconcileNative(full = true): Promise<void> {
    if (!this.options.localSessionsRoot && this.initializing && !this.initialized) {
      return this.initializing;
    }
    if (!this.reconcilingNative) {
      this.reconcilingNative = this.hydrate(true, !full)
        .then(() => undefined)
        .finally(() => {
          this.reconcilingNative = undefined;
        });
    }
    return this.reconcilingNative;
  }

  private hydrate(useStateDbOnly = false, incremental = false): Promise<number> {
    const run = () =>
      this.observations.observe((isCurrent) =>
        this.hydratePages(isCurrent, useStateDbOnly, incremental),
      );
    return this.options.runNativeWalk?.(run) ?? run();
  }

  private async hydratePages(
    isCurrent: (id: string) => boolean,
    useStateDbOnly: boolean,
    incremental: boolean,
  ): Promise<number> {
    this.assertCurrent();
    const files =
      this.options.localSessionsRoot && !useStateDbOnly
        ? (await scanCodexCatalogRollouts(this.options.localSessionsRoot, new Set())).files
        : new Map<string, CodexCatalogRolloutFingerprint>();
    let observedRevision: number | undefined;
    let frontier: CodexCatalogOrderKey | undefined;
    const batchOrder = this.ordering.captureBatch(this.availability.complete);
    const remaining = incremental ? undefined : new Map(this.rows);
    const pages = readCodexCatalogHydrationPages(async (params, remainingRows) => {
      this.assertCurrent();
      const fieldRevision = this.captureFields();
      const page = await this.options.readNative(params, remainingRows);
      return { ...page, fieldRevision, sourceRevision: this.sourceRevision };
    }, useStateDbOnly);
    for await (const page of pages) {
      this.assertCurrent();
      // The first page includes readiness of the client opened by this walk.
      observedRevision ??= page.sourceRevision;
      let sourceOrder = page.offset;
      let changed = false;
      for (const id of page.excludedThreadIds ?? []) {
        if (isCurrent(id)) {
          changed ||= this.rows.has(id);
          this.remove(id);
        }
      }
      for (const row of page.rows) {
        const position = sourceOrder++;
        if (position >= CODEX_CATALOG_MAX_ROWS) {
          continue;
        }
        remaining?.delete(row.threadId);
        const previous = this.rows.get(row.threadId);
        this.observeFields(row, page.fieldRevision);
        if (!isCurrent(row.threadId)) {
          changed = true;
          continue;
        }
        const fingerprint = resolveCodexCatalogRolloutFingerprint(
          row.rolloutPath,
          useStateDbOnly ? previous : undefined,
          files,
        );
        this.observations.mark(row.threadId);
        this.put({
          ...row,
          sourceOrder: batchOrder(row, previous, position),
          ...(fingerprint ? { fingerprint } : {}),
        });
        changed ||= this.rows.get(row.threadId) !== previous;
        frontier = this.rows.get(row.threadId) ?? frontier;
      }
      // Recency-descending pages have a known prefix once a whole page is unchanged.
      // Silent older metadata/membership changes belong to the full safety walk.
      if (
        incremental &&
        ((!changed && page.rows.length > 0) || sourceOrder >= CODEX_CATALOG_MAX_ROWS)
      ) {
        break;
      }
      if (page.nextCursor) {
        this.availability.publish(frontier);
      }
    }
    // DB-only listing can omit local files when indexing is incomplete or the
    // database is unavailable. Verified file absence and events own their removal.
    if (remaining && (!useStateDbOnly || !this.options.localSessionsRoot)) {
      for (const [id, row] of remaining) {
        if (isCurrent(id) && this.rows.get(id) === row) {
          this.remove(id);
        }
      }
    }
    this.availability.publish(frontier, true);
    await this.persistence.finishHydration(this.overflow);
    return observedRevision ?? this.sourceRevision;
  }

  reconcile(): Promise<void> {
    if (!this.reconciling) {
      this.reconciling = this.observations
        .observe((isCurrent) => this.reconcileFiles(isCurrent))
        .finally(() => {
          this.reconciling = undefined;
        });
    }
    return this.reconciling;
  }

  private async reconcileFiles(isCurrent: (id: string) => boolean): Promise<void> {
    const root = this.options.localSessionsRoot;
    if (!root || !this.initialized || this.closed) {
      return;
    }
    this.assertCurrent();
    const byPath = indexCodexCatalogRowsByRollout(this.rows.values());
    const { files, present } = await scanCodexCatalogRollouts(root, new Set(byPath.keys()));
    this.assertCurrent();
    const observed = new Map(files);
    for (const [file, fingerprint] of files) {
      const previous = byPath.get(codexCatalogRolloutLogicalPath(file));
      const known = this.observedFiles.get(file) ?? previous?.fingerprint;
      if (known?.mtimeMs === fingerprint.mtimeMs && known.size === fingerprint.size) {
        continue;
      }
      this.currency.requestNativeRefresh();
      // Publish a new fingerprint only after its projection survives concurrent native updates.
      observed.delete(file);
      if (known) {
        observed.set(file, known);
      }
      let thread: CodexThread | undefined;
      try {
        thread = await readCodexCatalogRollout(root, file);
      } catch (error) {
        this.assertCurrent();
        this.report(error);
        continue;
      }
      this.assertCurrent();
      if (!thread) {
        observed.set(file, fingerprint);
        continue;
      }
      if (!isCurrent(thread.id)) {
        continue;
      }
      const existing = this.rows.get(thread.id);
      if (
        existing?.rolloutPath &&
        codexCatalogRolloutLogicalPath(existing.rolloutPath) !==
          codexCatalogRolloutLogicalPath(file)
      ) {
        // Reverts retain older immutable files with the same thread id. Only
        // native metadata may change which rollout the catalog considers current.
        observed.set(file, fingerprint);
        continue;
      }
      if (!existing && !thread.preview) {
        observed.set(file, fingerprint);
        continue;
      }
      thread.preview ||= existing?.preview;
      const projected = await projectCodexCatalogThread(thread, root);
      this.assertCurrent();
      if (!isCurrent(thread.id)) {
        continue;
      }
      observed.set(file, fingerprint);
      const row = projected.rows[0];
      if (!row) {
        continue;
      }
      this.observations.mark(row.threadId);
      this.put(mergeCodexCatalogRolloutRow(row, existing, fingerprint));
      await nextTurn();
    }
    for (const row of byPath.values()) {
      if (
        row.rolloutPath &&
        isCodexCatalogRolloutPathCovered(root, row.rolloutPath) &&
        !present.has(codexCatalogRolloutLogicalPath(row.rolloutPath)) &&
        this.rows.get(row.threadId) === row
      ) {
        this.currency.requestNativeRefresh();
        this.remove(row.threadId);
      }
    }
    this.observedFiles = observed;
  }

  upsertThread(thread: CodexThread): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    try {
      this.assertCurrent();
    } catch {
      // Retiring a view must not turn an acknowledged native mutation into failure.
      return Promise.resolve();
    }
    try {
      this.currency.requestNativeRefresh();
      return this.upsertPreparedThread(
        projectCodexCatalogNativeThread(thread, sanitizeTerminalText),
      );
    } catch (error) {
      return Promise.reject(toErrorObject(error, "Codex catalog projection failed"));
    }
  }

  private upsertPreparedThread(prepared: CodexThread): Promise<void> {
    return this.projections
      .run(() => {
        this.observations.mark(prepared.id);
        const fields = this.captureFields();
        return this.observations.observe((isCurrent) =>
          this.projectThread(prepared, isCurrent, fields),
        );
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!(error instanceof CodexCatalogProjectionCapacityError)) {
          throw error;
        }
        this.report(error);
      });
  }

  private refreshThread(
    id: string,
    readThread: (id: string) => Promise<CodexThread>,
    sourceOrder: number | undefined,
  ): Promise<boolean> {
    this.assertCurrent();
    this.currency.requestNativeRefresh();
    this.observations.mark(id);
    const fields = this.captureFields();
    return this.projections.run(() =>
      this.observations.observe((isCurrent) =>
        readThread(id).then((thread) => {
          const prepared = projectCodexCatalogNativeThread(thread, sanitizeTerminalText);
          if (prepared.id !== id) {
            throw new Error("Codex catalog refresh returned a different thread");
          }
          return this.closed ? true : this.projectThread(prepared, isCurrent, fields, sourceOrder);
        }),
      ),
    );
  }

  private async projectThread(
    thread: CodexThread,
    isCurrent: (id: string) => boolean,
    fieldRevision: FieldRevision,
    sourceOrder?: number,
  ): Promise<boolean> {
    const projected = await projectCodexCatalogThread(thread, this.options.localSessionsRoot);
    if (this.closed) {
      return true;
    }
    const row = projected.rows[0];
    if (row) {
      this.observeFields(row, fieldRevision);
    }
    if (!isCurrent(thread.id)) {
      return false;
    }
    if (projected.excludedThreadIds?.includes(thread.id)) {
      this.remove(thread.id);
    }
    if (row) {
      const previous = this.rows.get(thread.id);
      const fingerprint = resolveCodexCatalogRolloutFingerprint(row.rolloutPath, previous);
      this.observations.mark(thread.id);
      this.put({
        ...row,
        // Preserve notification order when tied turns' metadata reads finish out of order.
        ...(sourceOrder !== undefined ? { sourceOrder } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      });
    }
    return true;
  }

  archive(threadId: string): void {
    // A native acknowledgement is a fact about the captured home even if its
    // serving configuration changed while the pinned action was running.
    if (this.closed) {
      return;
    }
    this.currency.requestNativeRefresh();
    this.observations.mark(threadId);
    this.liveStatus.delete(threadId);
    this.liveSettings.delete(threadId);
    this.names.delete(threadId);
    const row = this.rows.get(threadId);
    if (row) {
      this.put({ ...row, archived: true });
    } else {
      this.persistence.remove(threadId);
    }
  }

  get(threadId: string): CodexCatalogIndexRow | undefined {
    return this.rows.get(threadId);
  }

  hasActiveWork(): boolean {
    return Boolean(
      this.initializing ||
      (!this.restored && this.restoring) ||
      this.background ||
      this.reconciling ||
      this.reconcilingNative ||
      this.currency.hasActiveWork() ||
      this.observations.hasActiveWork() ||
      this.events.hasActiveWork() ||
      this.persistence.hasActiveWork(),
    );
  }

  async list(
    params: CodexSessionCatalogPageParams,
    deadline = performance.now() + (this.options.requestTimeoutMs ?? 60_000),
  ): Promise<CodexSessionCatalogPage> {
    return await withCodexCatalogListRequest(async (request) => {
      const expiresAt = request.constrainDeadline(deadline);
      const cursor = readCodexCatalogCursor(this.options.homeId, params);
      const query =
        cursor.kind === "resident" ? prepareCodexCatalogQuery(params, cursor) : undefined;
      await this.availability.until(this.restore(), expiresAt);
      this.assertCurrent();
      this.scheduleHydration();
      for (;;) {
        this.assertCurrent();
        const ordered = this.ordering.read(this.rows);
        const page = query?.(ordered, this.liveStatus, this.liveSettings, this.availability);
        if (
          cursor.kind === "native" ||
          (this.overflow && (params.cwd || params.searchTerm || (page && !page.nextCursor)))
        ) {
          return await this.nativePages.list(params, cursor, this.options, request);
        }
        if (page) {
          return page;
        }
        await this.availability.next(expiresAt);
      }
    });
  }

  /** Fence future publications before a replacement opens the same persisted home. */
  retire(): Promise<void> {
    this.closed = true;
    this.availability.fail(new Error("Codex resident catalog is closed"));
    this.liveStatus.invalidate();
    this.liveSettings.invalidate();
    this.unsubscribe();
    // close() joins the running scan after retirement has fenced its publications.
    void this.currency.close();
    clearImmediate(this.background);
    this.background = undefined;
    return this.persistence.retire();
  }

  async close(): Promise<void> {
    const writes = this.retire();
    await Promise.allSettled([
      this.initializing,
      this.restoring,
      this.reconciling,
      this.reconcilingNative,
      this.currency.close(),
      writes,
      this.events.close(),
    ]);
    this.rows.clear();
    this.observedFiles.clear();
    this.ordering.invalidate();
  }
}
