import { describe, expect, it } from "vitest";
import {
  createCodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./app-server/managed-thread-store.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";
import {
  commandRpcMocks,
  config,
  createCodexSessionCatalogControl,
  createCodexSessionCatalogControlFactory,
  createCodexTestBindingStore,
  createGatewayApi,
  createRuntime,
  idleThread,
  pinnedConnectionMocks,
  registerCodexSessionCatalog,
  type CodexThread,
} from "./session-catalog.test-helpers.js";

async function fixture(
  threadAtPage: (page: number) => Partial<CodexThread>,
  hasRuntimeConfig = true,
) {
  const rows = new Map<string, StoredCodexManagedThread>();
  const managedThreads = createCodexManagedThreadStore({
    entries: async () => [...rows].map(([key, value]) => ({ key, value, createdAt: 0 })),
    lookup: async (key) => rows.get(key),
    registerIfAbsent: async (key, value) => {
      if (rows.has(key)) {
        return false;
      }
      rows.set(key, value);
      return true;
    },
  });
  const control = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({ supervision: { enabled: true } }),
    getRuntimeConfig: () => (hasRuntimeConfig ? config : undefined),
    managedThreads,
    now: () => 1_000,
  });
  const primary = (await control.homesForAgent("main"))[0]!;
  const home = { ...primary, localSessionsRoot: "/synthetic/catalog-budget/sessions" };
  commandRpcMocks.codexControlRequest.mockImplementation(
    async (_pluginConfig: unknown, _method: string, request: { cursor?: string }) => {
      const page = Number(request.cursor ?? 0) + 1;
      return {
        data: [
          idleThread({
            id: `thread-${page}`,
            source: "cli",
            name: "Other",
            originator: "codex_cli_rs",
            path: `${home.localSessionsRoot}/thread-${page}.jsonl`,
            ...threadAtPage(page),
          }),
        ],
        nextCursor: String(page),
      };
    },
  );
  const { runtime } = createRuntime();
  const { api, getProvider } = createGatewayApi(runtime, config);
  registerCodexSessionCatalog({
    api,
    bindingStore: Object.assign(createCodexTestBindingStore(), { managedThreads }),
    control: { ...control, homesForAgent: async () => [home] },
    getRuntimeConfig: () => config,
  });
  const provider = getProvider()!;
  return {
    home,
    managedThreads,
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

describe("Codex catalog combined search and exclusion budget", () => {
  it.each(["cached", "uncached", "pinned"] as const)(
    "keeps the starting scan budget when caller options change during %s setup",
    async (mode) => {
      const response = (request: { cursor?: string }) => ({
        data: [idleThread({ id: `other-${request.cursor}`, name: "Other", source: "cli" })],
        nextCursor: String(Number(request.cursor) + 1),
      });
      commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, _method, request) =>
        response(request),
      );
      pinnedConnectionMocks.request.mockImplementation(async ({ requestParams }) =>
        response(requestParams),
      );
      const control = createCodexSessionCatalogControl({
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        getRuntimeConfig: () => (mode === "uncached" ? undefined : config),
      });
      const verify = async (active: CodexSessionCatalogControl) => {
        const query = { cursor: "0", limit: 1, searchTerm: "Wanted" };
        const options = { maxScanPages: 1 };
        const reading = active.listPage(query, undefined, options);
        options.maxScanPages = 3;

        await expect(reading).resolves.toEqual({ sessions: [], nextCursor: "1" });
        const nativeRequest =
          mode === "pinned" ? pinnedConnectionMocks.request : commandRpcMocks.codexControlRequest;
        expect(nativeRequest).toHaveBeenCalledOnce();
        if (mode === "cached") {
          await expect(active.listPage(query, undefined, { maxScanPages: 1 })).resolves.toEqual({
            sessions: [],
            nextCursor: "1",
          });
          expect(nativeRequest).toHaveBeenCalledOnce();
        }
        await expect(active.listPage(query, undefined, options)).resolves.toEqual({
          sessions: [],
          scannedPages: 3,
          nextCursor: "3",
        });
      };
      if (mode === "pinned") {
        await control.withPinnedConnection(verify);
      } else {
        await verify(control);
      }
    },
  );

  it.each([true, false])(
    "bounds an entirely managed title search and preserves continuation (runtime config %s)",
    async (hasRuntimeConfig) => {
      const f = await fixture(() => ({ originator: "openclaw" }), hasRuntimeConfig);

      const first = await f.list();

      // Original code returns after 400 reads: 20 title-search pages inside 20 exclusion fills.
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(20);
      expect(first[0]).toMatchObject({ sessions: [], nextCursor: "20" });

      const second = await f.list(first[0]!.nextCursor);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(40);
      expect(second[0]).toMatchObject({ sessions: [], nextCursor: "40" });
    },
  );

  it("spends one budget on matching owned rows and finds a later visible match by continuation", async () => {
    const hidden = new Set([4, 9, 14]);
    const f = await fixture((page) => (hidden.has(page) || page === 21 ? { name: "Wanted" } : {}));
    for (const page of hidden) {
      await expect(
        f.managedThreads.mark({ sourceHomeId: f.home.sourceHomeId, threadId: `thread-${page}` }),
      ).resolves.toBe(true);
    }

    const first = await f.list();

    // Original code consumes 4 + 5 + 5 + 7 pages and includes the page-21 match too early.
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(20);
    expect(first[0]).toMatchObject({ sessions: [], nextCursor: "20" });

    const second = await f.list(first[0]!.nextCursor);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(21);
    expect(second[0]?.sessions.map((session) => session.threadId)).toEqual(["thread-21"]);
    expect(second[0]?.nextCursor).toBe("21");
  });
});
