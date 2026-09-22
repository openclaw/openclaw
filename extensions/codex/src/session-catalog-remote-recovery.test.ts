import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import type { CodexCatalogState } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";

function row(threadId: string): CodexCatalogIndexRow {
  return {
    threadId,
    updatedAt: 100,
    recencyAt: 100,
    archived: false,
    nativeMetadata: true,
    page: { sessions: [{ threadId, name: threadId, status: "notLoaded", archived: false }] },
  };
}

describe("remote resident snapshot recovery", () => {
  it("finishes reconnect hydration after an offline snapshot refresh and resumes periodic currency", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const startOptions: CodexAppServerStartOptions = {
      transport: "websocket",
      command: "codex",
      args: ["app-server"],
      url: "wss://catalog-recovery.example.test/codex",
      headers: {},
    };
    const original = createClientHarness();
    const replacement = createClientHarness();
    const state: CodexCatalogState = {
      entries: async () => [
        { key: "complete", createdAt: 0, value: { version: 1, kind: "complete" } },
        { key: "saved", createdAt: 0, value: { version: 1, kind: "row", row: row("saved") } },
      ],
      register: async () => {},
      delete: async () => false,
    };
    const offline = new Error("remote connection unavailable");
    const readNative = vi
      .fn()
      .mockRejectedValueOnce(offline)
      .mockResolvedValue({ rows: [row("reconnected")] });
    const index = new CodexCatalogIndex({
      homeId: await codexCatalogResidentHomeKey({ startOptions }),
      readNative,
      state,
      assertCurrent: () => {},
    });
    try {
      await observeCodexCatalogClient(original.client, { startOptions });
      await expect(index.initialize()).rejects.toBe(offline);
      original.client.close();
      await observeCodexCatalogClient(replacement.client, { startOptions });
      let settled = false;
      const recovering = index.initialize().then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(settled).toBe(true));
      await recovering;
      expect((await index.list({})).sessions.map((session) => session.threadId)).toEqual([
        "reconnected",
      ]);

      readNative.mockResolvedValue({ rows: [row("later")] });
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await vi.waitFor(async () => {
        expect((await index.list({})).sessions.map((session) => session.threadId)).toEqual([
          "later",
        ]);
      });
    } finally {
      await index.retire();
      original.client.close();
      replacement.client.close();
      vi.useRealTimers();
    }
  });
});
