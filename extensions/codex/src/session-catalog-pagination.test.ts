import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexThread } from "./app-server/protocol.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";

describe("resident catalog cursor stability", () => {
  it("can navigate forward again after returning from the last page", async () => {
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage(
        {
          data: ["alpha", "bravo"].map((id, position) => ({
            id,
            projectId: null,
            name: id,
            preview: `Please review the ${id} workspace change.`,
            source: "cli",
            originator: "codex_cli_rs",
            recencyAt: 200 - position,
          })),
        },
        { sanitize: sanitizeTerminalText },
      ),
    );
    const index = new CodexCatalogIndex({
      homeId: "cursor-round-trip",
      readNative,
      assertCurrent: () => {},
    });
    try {
      await index.initialize();
      const first = await index.list({ limit: 1 });
      const last = await index.list({ limit: 1, cursor: first.nextCursor });
      expect(last.sessions.map((row) => row.threadId)).toEqual(["bravo"]);
      expect(last.nextCursor).toBeUndefined();
      const previous = await index.list({ limit: 1, cursor: last.backwardsCursor });
      expect(previous.sessions.map((row) => row.threadId)).toEqual(["alpha"]);
      expect(previous.nextCursor).toEqual(expect.any(String));
      const again = await index.list({ limit: 1, cursor: previous.nextCursor });
      expect(again.sessions.map((row) => row.threadId)).toEqual(["bravo"]);
      expect(readNative).toHaveBeenCalledOnce();
    } finally {
      await index.close();
    }
  });

  it.each([
    { change: "newer recency", recencyAt: 300 },
    { change: "a turn within the same timestamp", recencyAt: 200 },
  ])("keeps the backward boundary when its anchor moves after $change", async ({ recencyAt }) => {
    const threads: CodexThread[] = ["alpha", "bravo", "charlie"].map((id, position) => ({
      id,
      projectId: null,
      name: id,
      preview: `Please review the ${id} workspace change.`,
      source: "cli",
      originator: "codex_cli_rs",
      recencyAt: position < 2 ? 200 : 100,
    }));
    const startOptions: CodexAppServerStartOptions = {
      transport: "websocket",
      command: "codex",
      args: ["app-server"],
      url: `wss://cursor-${recencyAt}.example.test/codex`,
      headers: {},
    };
    const harness = createClientHarness({
      onWrite(line, send) {
        const request = JSON.parse(line);
        expect(request).toMatchObject({ method: "thread/read", params: { threadId: "bravo" } });
        send({ id: request.id, result: { thread: { ...threads[1], recencyAt } } });
      },
    });
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage({ data: threads }, { sanitize: sanitizeTerminalText }),
    );
    const nativeReads = vi.spyOn(harness.client, "request");
    const index = new CodexCatalogIndex({
      homeId: await codexCatalogResidentHomeKey({ startOptions }),
      readNative,
      assertCurrent: () => {},
    });
    try {
      await observeCodexCatalogClient(harness.client, { startOptions });
      await index.initialize();
      const first = await index.list({ limit: 1 });
      const second = await index.list({ limit: 1, cursor: first.nextCursor });
      expect(first.sessions.map((row) => row.threadId)).toEqual(["alpha"]);
      expect(second.sessions.map((row) => row.threadId)).toEqual(["bravo"]);
      expect(second.backwardsCursor).toEqual(expect.any(String));
      expect(second.nextCursor).toEqual(expect.any(String));

      harness.send({
        method: "turn/started",
        params: { threadId: "bravo", turn: { id: "new-turn", startedAt: recencyAt, items: [] } },
      });
      await harness.waitForWrite(0);
      await nativeReads.mock.results[0]!.value;
      await vi.waitFor(async () => {
        expect((await index.list({ limit: 1 })).sessions[0]?.threadId).toBe("bravo");
      });

      const previous = await index.list({ limit: 1, cursor: second.backwardsCursor });
      expect(previous.sessions.map((row) => row.threadId)).toEqual(["alpha"]);
      const expandedPrevious = await index.list({ limit: 64, cursor: second.backwardsCursor });
      expect(expandedPrevious.sessions.map((row) => row.threadId)).toEqual(["alpha"]);
      const following = await index.list({ limit: 1, cursor: second.nextCursor });
      expect(following.sessions.map((row) => row.threadId)).toEqual(["charlie"]);
      expect(readNative).toHaveBeenCalledOnce();
      expect(harness.writes).toHaveLength(1);
    } finally {
      harness.client.close();
      await Promise.all([index.close(), harness.client.closeAndWait()]);
    }
  });
});
