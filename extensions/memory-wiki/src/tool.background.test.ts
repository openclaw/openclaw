import { AsyncWorkScope, runInDetachedAsyncContext } from "openclaw/plugin-sdk/concurrency-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, expect, it, vi } from "vitest";
import type * as BridgeModule from "./bridge.js";
import { compileMemoryWikiVault } from "./compile.js";
import { closeMemoryWikiQueryReader } from "./query-reader.js";
import {
  createMemoryWikiSourceRefresh,
  waitForMemoryWikiImportedSourceSyncs,
} from "./source-sync.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiSearchTool } from "./tool.js";

const bridge = vi.hoisted(() => vi.fn());
vi.mock("./bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof BridgeModule>()),
  syncMemoryWikiBridgeSources: bridge,
}));

const { createVault } = createMemoryWikiTestHarness();
afterEach(async () => {
  await closeMemoryWikiQueryReader();
  vi.clearAllMocks();
});

it.each([false, true])(
  "searches available pages during maintenance (published snapshot: %s)",
  async (published) => {
    const { config, page } = await createVault({
      initialize: published,
      config: {
        vaultMode: "bridge",
        search: { backend: "local", corpus: "wiki" },
      },
    });
    const writePage = (version: string) =>
      page(
        "sources/cobalt.md",
        { pageType: "source", id: "source.cobalt", title: "Cobalt ledger" },
        `# Cobalt ledger ${version}\n\nEvidence.\n`,
      );
    await writePage("original");
    if (published) {
      await compileMemoryWikiVault(config);
    }

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const service = createTestPluginServiceScheduler();
    // Match the host's service scheduler: callbacks inherit the service, not demand.
    const scheduler = {
      ...service,
      schedule: (params: Parameters<typeof service.schedule>[0]) =>
        runInDetachedAsyncContext(() => service.schedule(params)),
    };
    const caller = new AsyncWorkScope();
    const onError = vi.fn();
    const refreshOptions = { scheduler, signal: service.signal, onError };
    const refresh = createMemoryWikiSourceRefresh(refreshOptions);
    bridge.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      await writePage("refreshed");
      return {
        importedCount: 0,
        updatedCount: 1,
        skippedCount: 0,
        removedCount: 0,
        artifactCount: 1,
        workspaces: 1,
        pagePaths: ["sources/cobalt.md"],
      };
    });
    const tool = createWikiSearchTool(config, undefined, {
      signal: service.signal,
      refreshSources: () => refresh(config),
    });
    const search = () => tool.execute("search", { query: "cobalt", maxResults: 1 });
    try {
      const first = caller.run(search);
      await entered.promise;
      // The importer holds the real vault mutation lease until explicitly released.
      // Both the published path and first-use fallback must answer independently.
      const [one, two] = await Promise.all([first, search()]);
      for (const result of [one, two]) {
        expect(result.details).toMatchObject({
          results: [
            expect.objectContaining({
              path: "sources/cobalt.md",
              snippet: expect.stringContaining("original"),
            }),
          ],
        });
      }
      expect(bridge).toHaveBeenCalledTimes(1);
      caller.beginClose();
      release.resolve();
      await caller.drain();
      await waitForMemoryWikiImportedSourceSyncs();
      expect((await search()).details).toMatchObject({
        results: [
          expect.objectContaining({
            path: "sources/cobalt.md",
            snippet: expect.stringContaining("refreshed"),
          }),
        ],
      });
      expect(bridge).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await waitForMemoryWikiImportedSourceSyncs();
      await service.stop();
    }
  },
);
