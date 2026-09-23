import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  CodexServerNotification,
  CodexThread,
  CodexThreadStatus,
} from "./app-server/protocol.js";
import type { CodexCatalogStatus } from "./session-catalog-index-field.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-limits.js";
import {
  boundedCatalogString,
  MAX_SESSION_ID_LENGTH,
  codexCatalogThreadName,
  codexCatalogThreadStatus,
} from "./session-catalog-parsing.js";
import type { CodexCatalogSettings } from "./session-catalog-settings.js";
import { setCodexCatalogSource, type CodexCatalogSource } from "./session-catalog-source.js";

type ReadThread = (id: string) => Promise<CodexThread>;
type CodexCatalogIndexEventOwner = {
  get(id: string): CodexCatalogIndexRow | undefined;
  rename(id: string, name: string | null): void;
  updateStatus(id: string, status: CodexCatalogStatus, source: CodexCatalogSource): void;
  updateSettings(id: string, settings: CodexCatalogSettings, source: CodexCatalogSource): void;
  upsert(thread: CodexThread): Promise<void>;
  reserveTurnStartOrder(): number;
  requestNativeRefresh(): void;
  refresh(id: string, readThread: ReadThread, sourceOrder: number | undefined): Promise<boolean>;
  archive(id: string): void;
  remove(id: string): void;
  report(error: unknown): void;
};

type PendingRefresh = {
  readThread: ReadThread;
  source: CodexCatalogSource;
  dirty: boolean;
  sourceOrder: number | undefined;
  promise: Promise<void>;
};

/** Event scheduling only; the index owns row publication and stale-read fencing. */
export class CodexCatalogIndexEvents {
  private closed = false;
  private readonly pending = new Map<string, PendingRefresh>();
  private readonly upserting = new Set<Promise<void>>();

  constructor(private readonly owner: CodexCatalogIndexEventOwner) {}

  hasActiveWork(): boolean {
    return this.pending.size > 0 || this.upserting.size > 0;
  }

  handle(event: CodexServerNotification, readThread: ReadThread, source: CodexCatalogSource): void {
    if (this.closed || !isRecord(event.params)) {
      return;
    }
    const params = event.params;
    if (event.method === "thread/started") {
      if (!isRecord(params.thread) || typeof params.thread.id !== "string") {
        return;
      }
      // SAFETY: native v2 ThreadStartedNotification carries Thread, as thread/list does.
      const thread = params.thread as CodexThread;
      if (!thread.ephemeral && !thread.preview?.trim() && thread.recencyAt == null) {
        return;
      }
      if (!this.hasCapacity()) {
        return;
      }
      const operation = this.owner
        .upsert(setCodexCatalogSource(thread, source))
        .catch((error: unknown) => this.owner.report(error))
        .finally(() => this.upserting.delete(operation));
      this.upserting.add(operation);
      return;
    }
    const id = boundedCatalogString(params.threadId, MAX_SESSION_ID_LENGTH);
    if (!id) {
      return;
    }
    if (event.method === "thread/archived" || event.method === "thread/deleted") {
      const pending = this.pending.get(id);
      if (pending) {
        pending.dirty = false;
        pending.sourceOrder = undefined;
      }
      if (event.method === "thread/deleted") {
        this.owner.remove(id);
      } else {
        this.owner.archive(id);
      }
      return;
    }
    if (event.method === "thread/name/updated") {
      this.owner.rename(id, codexCatalogThreadName(params.threadName ?? null) ?? null);
      return;
    }
    if (event.method === "thread/status/changed") {
      if (!isRecord(params.status)) {
        return;
      }
      this.owner.updateStatus(
        id,
        // SAFETY: native v2 ThreadStatusChangedNotification carries the protocol status union.
        codexCatalogThreadStatus(params.status as CodexThreadStatus),
        source,
      );
      return;
    }
    if (event.method === "thread/settings/updated") {
      const settings = params.threadSettings;
      if (isRecord(settings)) {
        this.owner.updateSettings(
          id,
          {
            ...(typeof settings.cwd === "string" ? { cwd: settings.cwd } : {}),
            ...(typeof settings.modelProvider === "string"
              ? { modelProvider: settings.modelProvider }
              : {}),
          },
          source,
        );
      }
      return;
    }
    if (
      event.method === "turn/started" ||
      event.method === "turn/completed" ||
      event.method === "thread/unarchived" ||
      event.method === "thread/reverted"
    ) {
      if (event.method !== "thread/unarchived" && this.owner.get(id)?.archived) {
        return;
      }
      this.enqueueRefresh(
        id,
        readThread,
        source,
        event.method === "turn/started" ? this.owner.reserveTurnStartOrder() : undefined,
      );
    }
  }

  private hasCapacity(): boolean {
    if (this.pending.size + this.upserting.size < CODEX_CATALOG_MAX_ROWS) {
      return true;
    }
    this.owner.report(new Error("Codex catalog event queue reached its resident row limit"));
    return false;
  }

  private enqueueRefresh(
    id: string,
    readThread: ReadThread,
    source: CodexCatalogSource,
    sourceOrder: number | undefined,
  ): void {
    this.owner.requestNativeRefresh();
    const existing = this.pending.get(id);
    if (existing) {
      existing.readThread = readThread;
      existing.source = source;
      existing.dirty = true;
      existing.sourceOrder = sourceOrder ?? existing.sourceOrder;
      return;
    }
    if (!this.hasCapacity()) {
      return;
    }
    const pending: PendingRefresh = {
      readThread,
      source,
      dirty: true,
      sourceOrder,
      promise: Promise.resolve(),
    };
    this.pending.set(id, pending);
    pending.promise = Promise.resolve().then(async () => {
      try {
        while (!this.closed && pending.dirty) {
          pending.dirty = false;
          const observedSourceOrder = pending.sourceOrder;
          const observedSource = pending.source;
          try {
            if (observedSource.closed) {
              throw new Error("Codex catalog observation source closed before its metadata read");
            }
            const published = await this.owner.refresh(id, pending.readThread, observedSourceOrder);
            if (published && pending.sourceOrder === observedSourceOrder) {
              pending.sourceOrder = undefined;
            } else if (!published && pending.sourceOrder !== undefined) {
              pending.dirty = true;
            }
          } catch (error) {
            if (observedSource.closed) {
              // A replacement notification may already own the coalesced follow-up.
              if (pending.source === observedSource) {
                pending.dirty = false;
              }
              this.owner.report(
                new Error(
                  "Codex catalog observation interrupted by client closure; metadata refresh deferred to the current catalog owner",
                  { cause: error },
                ),
              );
            } else {
              this.owner.report(error);
            }
          }
        }
      } finally {
        this.pending.delete(id);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([
      ...this.upserting,
      ...[...this.pending.values()].map((entry) => entry.promise),
    ]);
  }
}
