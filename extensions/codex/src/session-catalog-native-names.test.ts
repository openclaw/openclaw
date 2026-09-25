import * as terminalText from "openclaw/plugin-sdk/text-chunking";
import { expect, it, vi } from "vitest";
import type { CodexThreadListResponse } from "./app-server/protocol.js";
import type { CodexCatalogState } from "./session-catalog-index-state.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
  idleThread,
} from "./session-catalog.test-helpers.js";

it("reconciles saved and externally changed names through background DB-only pages without preview projection", async () => {
  const original = ["renamed", "cleared"].map((id) =>
    idleThread({
      id,
      name: `Previous ${id}`,
      preview: `First user request ${id}`,
      source: "cli",
      originator: "codex_cli_rs",
    }),
  );
  const saved = await projectCodexCatalogPage(
    { data: original },
    { sanitize: terminalText.sanitizeTerminalText },
  );
  const state: CodexCatalogState = {
    entries: vi.fn(async () => [
      { key: "complete", createdAt: 0, value: { version: 1 as const, kind: "complete" as const } },
      ...saved.rows.map((row) => ({
        key: row.threadId,
        createdAt: 0,
        value: { version: 1 as const, kind: "row" as const, row },
      })),
    ]),
    register: vi.fn(async () => {}),
    delete: vi.fn(async () => false),
  };
  const renamed = "Offline title ".repeat(60).trim();
  const native = original.map((thread, index) => ({
    ...thread,
    name: index === 0 ? renamed : null,
  }));
  commandRpcMocks.codexControlRequest.mockImplementation(
    async (_plugin, method, params, options) => {
      expect(method).toBe("thread/list");
      expect(params.useStateDbOnly).toBe(true);
      expect(options).toHaveProperty("catalogPreview", true);
      const thread = native[params.cursor ? 1 : 0]!;
      expect(
        options.catalogPreviewCache?.({
          id: thread.id,
          path: thread.path,
          updatedAt: thread.updatedAt,
          recencyAt: thread.recencyAt,
        }),
      ).toBe(original[params.cursor ? 1 : 0]!.preview);
      return {
        data: [native[params.cursor ? 1 : 0]!],
        nextCursor: params.cursor ? null : "native-names-tail",
      } satisfies CodexThreadListResponse;
    },
  );
  const factory = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({ supervision: { enabled: true } }),
    getRuntimeConfig: () => undefined,
    openResidentState: () => state,
  });
  const source = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", source);
  const sanitize = vi.spyOn(terminalText, "sanitizeTerminalText");
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  try {
    expect((await control.listPage({})).sessions.map((row) => row.name)).toEqual(
      expect.arrayContaining(["Previous renamed", "Previous cleared"]),
    );
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      const sessions = (await control.listPage({})).sessions;
      expect(sessions.find((row) => row.threadId === "renamed")?.name).toBe(renamed.slice(0, 500));
      expect(sessions.find((row) => row.threadId === "cleared")?.name).toBeNull();
    });
    await control.initialize();
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
    expect(sanitize).not.toHaveBeenCalled();

    native[0]!.name = "Changed again in the native CLI";
    native[1]!.name = "New external title";
    expect(
      (await control.listPage({})).sessions.find((row) => row.threadId === "renamed")?.name,
    ).toBe(renamed.slice(0, 500));
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () => {
      const sessions = (await control.listPage({})).sessions;
      expect(sessions.find((row) => row.threadId === "renamed")?.name).toBe(native[0]!.name);
      expect(sessions.find((row) => row.threadId === "cleared")?.name).toBe(native[1]!.name);
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(4);
    expect(sanitize).not.toHaveBeenCalled();
  } finally {
    try {
      await factory.stop();
    } finally {
      vi.useRealTimers();
      sanitize.mockRestore();
    }
  }
});
