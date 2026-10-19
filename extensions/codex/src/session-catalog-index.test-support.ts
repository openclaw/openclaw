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
