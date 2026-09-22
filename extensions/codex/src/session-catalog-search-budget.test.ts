import { describe, expect, it } from "vitest";
import {
  createCodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./app-server/managed-thread-store.js";
import { nativeCatalogFixture } from "./session-catalog-resident.test-support.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";
import {
  commandRpcMocks,
  config,
  createCodexSessionCatalogControl,
  createCodexSessionCatalogControlFactory,
  createCodexTestBindingStore,
  createGatewayApi,
  createRuntime,
  pinnedConnectionMocks,
  registerCodexSessionCatalog,
} from "./session-catalog.test-helpers.js";

async function fixture(count: number, matching: Set<number>, hasRuntimeConfig = true) {
  const native = nativeCatalogFixture(count);
  for (const [index, row] of native.rows.entries()) {
    row.name = matching.has(index + 1) ? "Wanted" : "Other";
  }
  const stored = new Map<string, StoredCodexManagedThread>();
  const managedThreads = createCodexManagedThreadStore({
    entries: async () => [...stored].map(([key, value]) => ({ key, value, createdAt: 0 })),
    registerIfAbsent: async (key, value) => {
      if (stored.has(key)) {
        return false;
      }
      stored.set(key, value);
      return true;
    },
  });
  const control = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({ supervision: { enabled: true } }),
    getRuntimeConfig: () => (hasRuntimeConfig ? config : undefined),
    managedThreads,
    now: () => 1_000,
  });
  const home = (await control.homesForAgent("main"))[0]!;
  const { runtime } = createRuntime();
  const { api, getProvider } = createGatewayApi(runtime, config);
  registerCodexSessionCatalog({
    api,
    bindingStore: Object.assign(createCodexTestBindingStore(), { managedThreads }),
    control: { ...control, homesForAgent: async () => [home] },
    getRuntimeConfig: () => config,
  });
  const provider = getProvider()!;
  await control.forRequest("main", home).initialize();
  commandRpcMocks.codexControlRequest.mockClear();
  return {
    rows: native.rows,
    async hide(positions: Iterable<number>) {
      for (const position of positions) {
        await managedThreads.mark({
          sourceHomeId: home.sourceHomeId,
          threadId: native.rows[position - 1]!.id,
        });
      }
    },
    list: (cursor?: string) =>
      provider.list({
        agentId: "main",
        hostIds: [home.hostId],
        search: "Wanted",
        limitPerHost: 1,
        ...(cursor ? { cursors: { [home.hostId]: cursor } } : {}),
      }),
  };
}

describe("resident Codex catalog search and exclusion bounds", () => {
  it.each(["cached", "uncached", "pinned"] as const)(
    "captures each query before asynchronous %s setup without rediscovering native rows",
    async (mode) => {
      const native = nativeCatalogFixture(6);
      for (const [index, row] of native.rows.entries()) {
        row.name = index % 2 === 0 ? "Wanted" : "Other";
      }
      const control = createCodexSessionCatalogControl({
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        getRuntimeConfig: () => (mode === "uncached" ? undefined : config),
      });
      const verify = async (active: CodexSessionCatalogControl) => {
        const query = { limit: 1, searchTerm: "Wanted" };
        const firstReading = active.listPage(query);
        query.limit = 2;
        query.searchTerm = "Other";

        const first = await firstReading;
        expect(first.sessions.map((session) => session.threadId)).toEqual([native.rows[0]!.id]);
        expect(first.nextCursor).toBeTypeOf("string");
        await active.initialize();
        expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
        expect(native.fetched).toEqual([native.rows.map((row) => row.id)]);
        commandRpcMocks.codexControlRequest.mockClear();

        const secondReading = active.listPage(query);
        query.limit = 3;
        query.searchTerm = "Wanted";
        const second = await secondReading;
        expect(second.sessions.map((session) => session.threadId)).toEqual([
          native.rows[1]!.id,
          native.rows[3]!.id,
        ]);
        expect(second.nextCursor).toBeTypeOf("string");

        const third = await active.listPage(query);
        expect(third.sessions.map((session) => session.threadId)).toEqual([
          native.rows[0]!.id,
          native.rows[2]!.id,
          native.rows[4]!.id,
        ]);
        expect(third.nextCursor).toBeUndefined();
        expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
        expect(pinnedConnectionMocks.request).not.toHaveBeenCalled();
      };
      if (mode === "pinned") {
        await control.withPinnedConnection(verify);
      } else {
        await verify(control);
      }
    },
  );

  it.each([true, false])(
    "finds sparse title matches beyond owned rows without native reads (runtime config %s)",
    async (hasRuntimeConfig) => {
      const hidden = [4, 9, 14];
      const f = await fixture(256, new Set([...hidden, 151]), hasRuntimeConfig);
      await f.hide(hidden);

      const result = await f.list();

      expect(result[0]?.sessions.map((session) => session.threadId)).toEqual([f.rows[150]!.id]);
      expect(result[0]?.nextCursor).toBeUndefined();
      expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
    },
  );

  it("bounds resident exclusion filling and continues without skipping the later visible match", async () => {
    const matching = Array.from({ length: 21 }, (_, index) => index * 64 + 1);
    const f = await fixture(21 * 64, new Set(matching));
    await f.hide(matching.slice(0, 20));

    const first = await f.list();

    expect(first[0]?.sessions).toEqual([]);
    const cursor = first[0]?.nextCursor;
    expect(cursor).toBeTypeOf("string");
    if (!cursor) {
      throw new Error("Expected continuation after the bounded exclusion fill");
    }
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();

    const second = await f.list(cursor);

    expect(second[0]?.sessions.map((session) => session.threadId)).toEqual([f.rows[1280]!.id]);
    expect(second[0]?.nextCursor).toBeUndefined();
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
  });
});
