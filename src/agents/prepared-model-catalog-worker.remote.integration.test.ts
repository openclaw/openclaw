import { expect, it, vi } from "vitest";
import {
  publishRemoteModelCatalogSnapshot,
  withRemoteModelCatalogSnapshot,
  type ActiveRemoteModelCatalog,
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";
import { catalogAgentFacts } from "./prepared-model-catalog-worker.shared.test-support.js";
import {
  catalogInput,
  createCatalogFixture,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import type { PreparedModelCatalogWorkerTask } from "./prepared-model-catalog-worker.types.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, observeWorkers, retireAfterTest } = usePreparedCatalogWorkerFixtures();

it("sends only current published catalog bytes and preserves scoped prices on a reused worker", async () => {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  const remote: ActiveRemoteModelCatalog = {
    sourceUrl: "https://catalog.invalid/snapshot.json",
    revision: "first",
    generatedAt: 1,
    providers: {
      [PROVIDER_ID]: {
        models: [
          { id: "published-model", cost: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0 } },
        ],
      },
    },
    recommendations: {},
    pricing: {},
    upstreamPricing: {},
  };
  const config = {
    ...fixture.config,
    models: {
      catalogRefresh: { url: remote.sourceUrl },
      providers: {
        [PROVIDER_ID]: {
          api: "openai-completions" as const,
          baseUrl: "https://catalog.invalid/v1",
          apiKey: "synthetic-key",
          models: [],
        },
      },
    },
  };
  const retirement = new AbortController();
  retireAfterTest(() => retirement.abort());
  const transfers: unknown[] = [];
  const threads = new Set<number>();
  const observer = observeWorkers((thread) => {
    threads.add(thread.threadId);
    const post = thread.postMessage.bind(thread);
    vi.spyOn(thread, "postMessage").mockImplementation((message, ...rest) => {
      const task = (message as { input?: PreparedModelCatalogWorkerTask }).input;
      if (task?.value) {
        transfers.push("remoteCatalog" in task.value ? task.value.remoteCatalog : undefined);
      }
      post(message, ...rest);
    });
  });
  setRemoteModelCatalogOverlaySourcesForTest();
  observer.subscribe();
  try {
    expect(publishRemoteModelCatalogSnapshot(remote, null)).toBe(true);
    const metadata = loadPluginMetadataSnapshot({
      config,
      env: fixture.env,
      workspaceDir: fixture.workspaceDir,
    });
    const input = {
      ...catalogInput(fixture, { config }),
      allowGatewaySubagentBinding: true,
      env: undefined,
    };
    const createWorker = () =>
      createPreparedModelCatalogWorker({
        agentFacts: catalogAgentFacts(input, fixture.env, { providerIds: [PROVIDER_ID] }),
        pluginMetadataSnapshot: metadata,
        isCurrent: () => !retirement.signal.aborted,
        retirementSignal: retirement.signal,
      });
    const first = createWorker();
    const loadPrice = async (worker: typeof first) =>
      (await worker.loadCatalog()).runtimeModels
        .get(PROVIDER_ID)
        ?.find((model) => model.id === "published-model")?.cost.input;
    expect(await loadPrice(first)).toBe(3);
    await first.loadAuth({ providerIds: [PROVIDER_ID] });
    const next = {
      ...remote,
      revision: "second",
      providers: {
        [PROVIDER_ID]: {
          models: [
            { id: "published-model", cost: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0 } },
          ],
        },
      },
    };
    expect(publishRemoteModelCatalogSnapshot(next, remote)).toBe(true);
    // The same worker inherited the first revision. It must decode the second from the task.
    expect(await loadPrice(createWorker())).toBe(7);
    // The old owner no longer has published bytes. Its direct snapshot still wins over the new pair.
    expect(await loadPrice(first)).toBe(3);
    expect(await loadPrice(withRemoteModelCatalogSnapshot(null, createWorker))).toBeUndefined();
    expect(threads.size).toBe(1);
    const shared = (revision: string) => ({
      sourceUrl: remote.sourceUrl,
      revision,
      sharedBytes: expect.any(SharedArrayBuffer),
    });
    expect(transfers).toEqual([shared("first"), undefined, shared("second"), remote, null]);
  } finally {
    observer.close();
    setRemoteModelCatalogOverlaySourcesForTest();
  }
}, 60_000);
