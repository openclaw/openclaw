import { expect, it } from "vitest";
import {
  createCodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./app-server/managed-thread-store.js";
import {
  catalogFactory,
  catalogProvider,
  nativeCatalogFixture,
} from "./session-catalog-resident.test-support.js";
import {
  commandRpcMocks,
  config,
  createCodexSessionCatalogControl,
  createCodexTestBindingStore,
  pinnedConnectionMocks,
} from "./session-catalog.test-helpers.js";

async function fixture(count: number, matching: Set<number>) {
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
  const control = catalogFactory({
    getRuntimeConfig: () => config,
    managedThreads,
    now: () => 1_000,
  });
  const home = (await control.homesForAgent("main"))[0]!;
  const provider = catalogProvider(
    { ...control, homesForAgent: async () => [home] },
    undefined,
    Object.assign(createCodexTestBindingStore(), { managedThreads }),
  );
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

it("captures each query before asynchronous pinned setup without rediscovering native rows", async () => {
  const native = nativeCatalogFixture(6);
  for (const [index, row] of native.rows.entries()) {
    row.name = index % 2 === 0 ? "Wanted" : "Other";
  }
  const control = createCodexSessionCatalogControl({
    getPluginConfig: () => ({ supervision: { enabled: true } }),
    getRuntimeConfig: () => config,
  });
  await control.withPinnedConnection(async (active) => {
    const query = { limit: 1, searchTerm: "Wanted" };
    for (const [step, positions] of [[0], [1, 3], [0, 2, 4]].entries()) {
      const reading = active.listPage(query);
      Object.assign(query, { limit: step + 2, searchTerm: step === 0 ? "Other" : "Wanted" });
      const page = await reading;
      expect(page.sessions.map(({ threadId }) => threadId)).toEqual(
        positions.map((i) => native.rows[i]!.id),
      );
      if (step < 2) {
        expect(page.nextCursor).toBeTypeOf("string");
      } else {
        expect(page.nextCursor).toBeUndefined();
      }
      if (step === 0) {
        await active.initialize();
        expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
        expect(native.fetched).toEqual([native.rows.map(({ id }) => id)]);
        commandRpcMocks.codexControlRequest.mockClear();
      }
    }
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
    expect(pinnedConnectionMocks.request).not.toHaveBeenCalled();
  });
});

it("bounds resident exclusion filling and continues without skipping the later visible match", async () => {
  const matching = Array.from({ length: 21 }, (_, index) => index * 64 + 1);
  const f = await fixture(21 * 64, new Set(matching));
  await f.hide(matching.slice(0, 20));

  const first = await f.list();

  expect(first[0]?.sessions).toEqual([]);
  const cursor = first[0]?.nextCursor;
  expect(cursor).toBeTypeOf("string");
  expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();

  const second = await f.list(cursor);

  expect(second[0]?.sessions.map((session) => session.threadId)).toEqual([f.rows[1280]!.id]);
  expect(second[0]?.nextCursor).toBeUndefined();
  expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
});
