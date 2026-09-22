import { expect, it, vi } from "vitest";
import type { CodexCatalogState, StoredCodexCatalogEntry } from "./session-catalog-index-state.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
  idleThread,
} from "./session-catalog.test-helpers.js";

it("keeps paging and searching older native rows beyond the retained window after restart", async () => {
  const total = 20_003;
  const native = Array.from({ length: total }, (_, index) =>
    idleThread({
      id: `thread-${index}`,
      name: `${index >= 20_000 ? "Older" : "Recent"} investigation ${index}${index === 0 || index === total - 1 ? " sparse" : ""}`,
      cwd: index >= 20_000 ? "/workspace/older" : "/workspace/recent",
      source: "cli",
      originator: "codex_cli_rs",
      preview: `Please investigate task ${index} and verify the result.`,
      recencyAt: total - index,
      updatedAt: total - index,
    }),
  );
  const values = new Map<string, StoredCodexCatalogEntry>();
  const state: CodexCatalogState = {
    entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
    register: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key) => values.delete(key),
  };
  const calls: Array<{ cursor?: string; useStateDbOnly?: boolean }> = [];
  commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, method, params) => {
    expect(method).toBe("thread/list");
    calls.push(params);
    const backwards = params.sortDirection === "asc";
    const anchor = params.cursor === undefined ? undefined : Number(params.cursor);
    const matching = native.filter(
      (thread, index) =>
        (!params.cwd || thread.cwd === params.cwd) &&
        (!params.searchTerm ||
          thread.name?.toLowerCase().includes(params.searchTerm.toLowerCase())) &&
        (anchor === undefined || (backwards ? index < anchor : index > anchor)),
    );
    if (backwards) {
      matching.reverse();
    }
    const data = matching.slice(0, params.limit);
    const position = (id: string) => id.slice("thread-".length);
    return {
      data,
      nextCursor: data.length < matching.length ? position(data.at(-1)!.id) : null,
      backwardsCursor: data[0] ? position(data[0].id) : null,
    };
  });
  const make = async () => {
    const factory = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({
        appServer: {
          transport: "websocket",
          url: "wss://overflow.example.test/codex",
          authToken: "synthetic-overflow-token",
        },
      }),
      getRuntimeConfig: () => undefined,
      openResidentState: () => state,
    });
    const home = (await factory.homesForAgent("main"))[0]!;
    return { factory, control: factory.forRequest("main", home) };
  };
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const initial = await make();
    await initial.control.initialize();
    expect([...values.values()].filter((entry) => entry.kind === "row")).toHaveLength(20_000);
    await initial.factory.stop();
    const { control } = await make();
    const before = calls.length;
    let page = await control.listPage({ limit: 40 });
    expect(calls).toHaveLength(before);
    expect(page.sessions.map((row) => row.threadId)).toEqual(
      native.slice(0, 40).map((row) => row.id),
    );
    const ids = page.sessions.map((row) => row.threadId);
    while (page.nextCursor) {
      page = await control.listPage({ limit: 40, cursor: page.nextCursor });
      ids.push(...page.sessions.map((row) => row.threadId));
    }
    expect(ids).toEqual(native.map((thread) => thread.id));
    expect(page.backwardsCursor).toEqual(expect.any(String));
    const previous = await control.listPage({ limit: 40, cursor: page.backwardsCursor });
    const again = await control.listPage({ limit: 40, cursor: previous.nextCursor });
    expect(again.sessions).toEqual(page.sessions);
    const expected = native.slice(20_000).map((thread) => thread.id);
    let searched = await control.listPage({ searchTerm: "older investigation", limit: 40 });
    expect(searched.nextCursor).toEqual(expect.any(String));
    while (!searched.sessions.length && searched.nextCursor) {
      searched = await control.listPage({
        searchTerm: "older investigation",
        limit: 40,
        cursor: searched.nextCursor,
      });
    }
    const scoped = await control.listPage({ cwd: "/workspace/older", limit: 40 });
    expect(searched.sessions.map((row) => row.threadId)).toEqual(expected);
    expect(scoped.sessions.map((row) => row.threadId)).toEqual(expected);
    let sparse = await control.listPage({ searchTerm: "sparse", limit: 40 });
    expect(sparse.sessions.map((row) => row.threadId)).toEqual([native[0]!.id]);
    while (sparse.nextCursor) {
      sparse = await control.listPage({
        searchTerm: "sparse",
        limit: 40,
        cursor: sparse.nextCursor,
      });
    }
    expect(sparse.sessions.map((row) => row.threadId)).toEqual([native.at(-1)!.id]);
    let newer = await control.listPage({
      searchTerm: "sparse",
      limit: 40,
      cursor: sparse.backwardsCursor,
    });
    expect(newer.sessions).toEqual([]);
    expect(newer.backwardsCursor).toEqual(expect.any(String));
    expect(newer.nextCursor).toBeUndefined();
    while (!newer.sessions.length && newer.backwardsCursor) {
      newer = await control.listPage({
        searchTerm: "sparse",
        limit: 40,
        cursor: newer.backwardsCursor,
      });
    }
    expect(newer.sessions.map((row) => row.threadId)).toEqual([native[0]!.id]);
    expect(calls.slice(before).every((request) => request.useStateDbOnly === true)).toBe(true);
    expect([...values.values()].filter((entry) => entry.kind === "row")).toHaveLength(20_000);
    await expect(
      control.listPage({ searchTerm: "different", cursor: previous.nextCursor }),
    ).rejects.toThrow(/cursor/);
  } finally {
    vi.useRealTimers();
  }
});
