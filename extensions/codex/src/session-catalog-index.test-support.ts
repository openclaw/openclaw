import { EventEmitter } from "node:events";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import type { CodexCatalogState, StoredCodexCatalogEntry } from "./session-catalog-index-state.js";
import type { CodexSessionCatalogSession } from "./session-catalog-types.js";

export function catalogRow(
  threadId: string,
  recencyAt = 100,
  session: Partial<CodexSessionCatalogSession> = {},
  fields: Partial<CodexCatalogIndexRow> = {},
): CodexCatalogIndexRow {
  return {
    threadId,
    updatedAt: recencyAt,
    recencyAt,
    archived: false,
    nativeMetadata: true,
    page: { sessions: [{ threadId, status: "notLoaded", archived: false, ...session }] },
    ...fields,
  };
}

export function completeCatalogState(rows: CodexCatalogIndexRow[]): CodexCatalogState {
  const values: StoredCodexCatalogEntry[] = [
    { version: 1, kind: "complete" },
    ...rows.map((row) => ({ version: 1 as const, kind: "row" as const, row })),
  ];
  return {
    entries: vi.fn(async () =>
      values.map((value) => ({
        key: value.kind === "complete" ? "complete" : value.row.threadId,
        createdAt: 0,
        value,
      })),
    ),
    register: vi.fn(async () => {}),
    delete: vi.fn(async () => false),
  };
}

export function memoryCatalogState({ clone = false } = {}) {
  const values = new Map<string, StoredCodexCatalogEntry>();
  const state: CodexCatalogState = {
    entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
    register: async (key, value) => {
      values.set(key, clone ? structuredClone(value) : value);
    },
    delete: async (key) => values.delete(key),
  };
  return { values, state };
}

export function catalogWebSocketOptions(url: string): CodexAppServerStartOptions {
  return { transport: "websocket", command: "codex", args: ["app-server"], url, headers: {} };
}

class ControlledWatcher extends EventEmitter {
  close = vi.fn();
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
export function watchWithControlledEvents(platform: NodeJS.Platform) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  const watchers: ControlledWatcher[] = [];
  const watch = vi.spyOn(nodeFs, "watch").mockImplementation(() => {
    const watcher = new ControlledWatcher();
    watchers.push(watcher);
    return watcher;
  });
  return {
    watchers,
    watch,
    notifyRename: (file: string) => {
      const index = watch.mock.calls.findLastIndex(
        ([directory]) => directory === path.dirname(file),
      );
      watchers[index]!.emit("change", "rename", path.basename(file));
    },
  };
}
export function freezeCatalogDirectoryClocks() {
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const stat = await lstat(...args);
    // Delivered events must invalidate healthy caches even on coarse directory clocks.
    if (stat.isDirectory()) {
      stat.ctimeMs = 0;
      stat.mtimeMs = 0;
    }
    return stat;
  });
}
