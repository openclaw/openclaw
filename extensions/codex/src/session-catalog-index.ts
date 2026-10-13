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
import { reconcileCodexCatalogFiles } from "./session-catalog-index-files.js";
import { applyCodexCatalogName } from "./session-catalog-index-names.js";
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
  projectCodexCatalogPage,
  CodexCatalogProjections,
  CodexCatalogProjectionCapacityError,
} from "./session-catalog-projection.js";
import { CodexCatalogRolloutScanner } from "./session-catalog-rollout-scanner.js";
import {
  codexCatalogRolloutLogicalPath,
  resolveCodexCatalogRolloutFingerprint,
} from "./session-catalog-rollouts.js";
import { CodexCatalogSettingsIndex } from "./session-catalog-settings.js";
import { setCodexCatalogSource } from "./session-catalog-source.js";
import { CodexCatalogStatusIndex } from "./session-catalog-status.js";
import type {
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

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
  private closed = false;
  private readonly currency: CodexCatalogCurrency;
  private readonly projections = new CodexCatalogProjections();
  private readonly unsubscribe: () => void;
  private reconciling: Promise<void> | undefined;
  private reconcilingNative: Promise<void> | undefined;
  private observedFiles = new Map<string, CodexCatalogRolloutFingerprint>();
  private readonly persistence: CodexCatalogPersistence;
  private readonly obsoleteStoredKeys = new Set<string>();
  private readonly ordering = new CodexCatalogOrdering();
  private readonly events: CodexCatalogIndexEvents;
  private readonly rolloutScanner: CodexCatalogRolloutScanner | undefined;

  constructor(private readonly options: CodexCatalogIndexOptions) {
    this.rolloutScanner = options.localSessionsRoot
      ? new CodexCatalogRolloutScanner(options.localSessionsRoot)
      : undefined;
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
      requestNativeRefresh: () => this.currency.requestNativeRefresh(),
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
    if (!this.closed && !this.currency.stopForTerminalFailure(error)) {
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
    if (oldest?.threadId === row.threadId) {
      return;
    }
    if (oldest) {
      this.evict(oldest.threadId, oldest);
    }
    this.ordering.put(row, previous);
    this.persistence.put(row);
  }

  private evict(threadId: string, row = this.rows.get(threadId)): void {
    // Retention does not withdraw observations supported by an open native connection.
    this.rows.delete(threadId);
    if (row) {
      this.ordering.remove(row);
    }
    this.persistence.remove(threadId);
  }

  private remove(threadId: string): void {
    this.evict(threadId);
    this.liveStatus.delete(threadId);
    this.liveSettings.delete(threadId);
    this.names.delete(threadId);
  }

  async initialize(): Promise<void> {
    this.assertCurrent();
    this.currency.assertRunnable();
    this.currency.cancelHydration();
    if (this.initialized && !this.needsNativeRefresh) {
      return;
    }
    if (!this.initializing) {
      this.availability.begin();
      this.initializing = (async () => {
        await this.restore();
        await this.persistence.pruneObsolete(this.obsoleteStoredKeys, this.rows.values());
        this.obsoleteStoredKeys.clear();
        await this.reconcilingNative?.catch((error: unknown) => this.report(error));
        if (!this.initialized) {
          await this.hydrate(this.availability.complete);
        } else if (this.needsNativeRefresh) {
          await this.reconcile();
          await this.reconcileNative();
        }
        // A complete replacement walk also satisfies a pending snapshot refresh.
        this.needsNativeRefresh = false;
        this.initialized = true;
        this.currency.start();
      })()
        .catch((error: unknown) => {
          this.availability.fail(error);
          this.currency.stopForTerminalFailure(error);
          throw error;
        })
        .finally(() => {
          this.initializing = undefined;
        });
    }
    return this.initializing;
  }

  private async restore(): Promise<void> {
    if (this.restored) {
      return;
    }
    this.restoring ??= (async () => {
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
        let restoredRows = 0;
        for (const row of snapshot.rows) {
          if (++restoredRows % 128 === 0) {
            await nextTurn();
            this.assertCurrent();
          }
          const restored = row.rolloutPath
            ? { ...row, rolloutPath: codexCatalogRolloutLogicalPath(row.rolloutPath) }
            : row;
          const patched = this.withName(restored);
          if (patched !== restored) {
            this.persistence.put(patched);
          }
          const previous = this.rows.get(patched.threadId);
          const evicted = retainCodexCatalogRow(this.rows, patched);
          if (evicted) {
            this.evict(evicted.threadId, evicted);
          }
          if (evicted !== patched) {
            this.ordering.put(patched, previous);
          }
          this.ordering.restore(row);
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
    })();
    await this.restoring;
  }

  private scheduleHydration(): void {
    if ((this.initialized && !this.needsNativeRefresh) || this.initializing || this.closed) {
      return;
    }
    this.currency.scheduleHydration(() => this.initialize());
  }

  private observeFields(row: CodexCatalogIndexRow): void {
    // Display observations are last-completion-wins; periodic reconciliation repairs races.
    const session = row.page.sessions[0];
    if (!session) {
      return;
    }
    this.liveStatus.observe(row);
    if (session.name !== undefined) {
      this.names.update(row.threadId, session.name);
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

  private hydrate(useStateDbOnly = false, incremental = false): Promise<void> {
    const run = () => this.hydratePages(useStateDbOnly, incremental);
    return this.options.runNativeWalk?.(run) ?? run();
  }

  private async hydratePages(useStateDbOnly: boolean, incremental: boolean): Promise<void> {
    this.assertCurrent();
    const files =
      this.rolloutScanner && !useStateDbOnly
        ? (await this.rolloutScanner.scan(new Set())).files
        : new Map<string, CodexCatalogRolloutFingerprint>();
    this.assertCurrent();
    let frontier: CodexCatalogOrderKey | undefined;
    const batchOrder = this.ordering.captureBatch(this.availability.complete);
    const remaining = incremental ? undefined : new Map(this.rows);
    const pages = readCodexCatalogHydrationPages(async (params, remainingRows) => {
      this.assertCurrent();
      return await this.options.readNative(params, remainingRows);
    }, useStateDbOnly);
    for await (const page of pages) {
      this.assertCurrent();
      let sourceOrder = page.offset;
      let changed = false;
      for (const id of page.excludedThreadIds ?? []) {
        changed ||= this.rows.has(id);
        this.remove(id);
      }
      for (const row of page.rows) {
        const position = sourceOrder++;
        if (position >= CODEX_CATALOG_MAX_ROWS) {
          continue;
        }
        remaining?.delete(row.threadId);
        const previous = this.rows.get(row.threadId);
        this.observeFields(row);
        const fingerprint = resolveCodexCatalogRolloutFingerprint(
          row.rolloutPath,
          useStateDbOnly ? previous : undefined,
          files,
        );
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
        await nextTurn();
        this.assertCurrent();
      }
    }
    // DB-only listing can omit local files when indexing is incomplete or the
    // database is unavailable. Verified file absence and events own their removal.
    if (remaining && (!useStateDbOnly || !this.options.localSessionsRoot)) {
      for (const [id, row] of remaining) {
        if (this.rows.get(id) === row) {
          this.remove(id);
        }
      }
    }
    this.availability.publish(frontier, true);
    await this.persistence.finishHydration(this.overflow);
  }

  reconcile(): Promise<void> {
    if (!this.reconciling) {
      this.reconciling = this.reconcileFiles().finally(() => {
        this.reconciling = undefined;
      });
    }
    return this.reconciling;
  }

  private async reconcileFiles(): Promise<void> {
    const root = this.options.localSessionsRoot;
    if (!root || !this.rolloutScanner || !this.initialized || this.closed) {
      return;
    }
    this.assertCurrent();
    this.observedFiles = await reconcileCodexCatalogFiles(root, {
      rows: this.rows,
      observedFiles: this.observedFiles,
      scanner: this.rolloutScanner,
      assertCurrent: () => this.assertCurrent(),
      requestNativeRefresh: () => this.currency.requestNativeRefresh(),
      report: (error) => this.report(error),
      put: (row) => this.put(row),
      remove: (id) => this.remove(id),
    });
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
      const prepared = projectCodexCatalogNativeThread(thread, sanitizeTerminalText);
      return this.projections
        .run(() => this.projectThread(prepared))
        .catch((error: unknown) => {
          if (!(error instanceof CodexCatalogProjectionCapacityError)) {
            throw error;
          }
          this.report(error);
        });
    } catch (error) {
      return Promise.reject(toErrorObject(error, "Codex catalog projection failed"));
    }
  }

  private refreshThread(
    id: string,
    readThread: (id: string) => Promise<CodexThread>,
    sourceOrder: number | undefined,
  ): Promise<void> {
    this.assertCurrent();
    return this.projections.run(() =>
      readThread(id).then((thread) => {
        const prepared = projectCodexCatalogNativeThread(thread, sanitizeTerminalText);
        if (prepared.id !== id) {
          throw new Error("Codex catalog refresh returned a different thread");
        }
        return this.closed ? undefined : this.projectThread(prepared, sourceOrder);
      }),
    );
  }

  private async projectThread(
    thread: ReturnType<typeof projectCodexCatalogNativeThread>,
    sourceOrder?: number,
  ): Promise<void> {
    const projected = await projectCodexCatalogPage(
      { data: [thread] },
      { localSessionsRoot: this.options.localSessionsRoot, sanitize: sanitizeTerminalText },
    );
    if (this.closed) {
      return;
    }
    const row = projected.rows[0];
    if (row) {
      this.observeFields(row);
    }
    if (projected.excludedThreadIds?.includes(thread.id)) {
      this.remove(thread.id);
    }
    if (row) {
      const previous = this.rows.get(thread.id);
      const fingerprint = resolveCodexCatalogRolloutFingerprint(row.rolloutPath, previous);
      this.put({
        ...row,
        // Preserve notification order when tied turns' metadata reads finish out of order.
        ...(sourceOrder !== undefined ? { sourceOrder } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      });
    }
  }

  archive(threadId: string): void {
    // A native acknowledgement is a fact about the captured home even if its
    // serving configuration changed while the pinned action was running.
    if (this.closed) {
      return;
    }
    this.currency.requestNativeRefresh();
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
      this.reconciling ||
      this.reconcilingNative ||
      this.projections.hasActiveWork() ||
      this.currency.hasActiveWork() ||
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
        const ordered = this.ordering.read();
        const page = query?.(ordered, this.liveStatus, this.liveSettings, this.availability);
        if (
          cursor.kind === "native" ||
          (this.overflow && (params.cwd || params.searchTerm || (page && !page.nextCursor)))
        ) {
          return await this.nativePages.list(params, cursor, this.options, request);
        }
        if (page) {
          void this.currency.refreshNativeIfDue();
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
    this.rolloutScanner?.close();
    // close() joins the running scan after retirement has fenced its publications.
    void this.currency.close();
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
    this.ordering.clear();
  }
}
