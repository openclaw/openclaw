// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { publishPreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";

const fixture = usePreparedModelRuntimeHarness({ label: "cli-native-renewal" }, () => {
  vi.restoreAllMocks();
});
const { mocks } = fixture;

const first = {
  provider: "custom",
  id: "first",
  name: "First",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 4096,
};
const discovered = { provider: "custom", id: "discovered", name: "Discovered" };

function installCatalogBackend(
  prepare: NonNullable<
    import("../plugins/cli-backend.types.js").CliBackendPlugin["prepareModelCatalog"]
  >,
  nativeCatalog: () => Promise<import("./harness/types.js").AgentHarnessModelCatalogResult>,
) {
  mocks.configuredAgentIds = ["pro"];
  mocks.modelRegistry.getAll.mockReturnValue([first]);
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
    const registry = createEmptyPluginRegistry();
    registry.cliBackends.push({
      pluginId: "custom",
      source: "fixture",
      backend: {
        id: "fixture-cli",
        modelProvider: "custom",
        config: { command: "/service/fixture" },
        prepareModelCatalog: prepare,
      },
    });
    registry.agentHarnesses.push({
      pluginId: "custom",
      source: "fixture",
      harness: {
        id: "fixture-cli",
        label: "Fixture CLI",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        loadModelCatalog: nativeCatalog,
      },
    });
    return registry;
  });
  return fixture.agentInput("pro", {
    agents: { entries: { pro: { model: "custom/first" } } },
    models: {
      providers: {
        custom: {
          baseUrl: "https://fixture.invalid",
          api: "openai-completions",
          models: [first],
          agentRuntime: { id: "fixture-cli" },
        },
      },
    },
  });
}

it.for([
  { expiry: "compatibility", changesRuntime: true },
  { expiry: "provider", changesRuntime: true },
  { expiry: "provider", changesRuntime: false },
] as const)(
  "renews the native model menu for $expiry expiry, runtime change=$changesRuntime",
  async ({ expiry, changesRuntime }, { signal }) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const renewed = createDeferred();
    let installed = false;
    let repairRequested = false;
    let repairs = 0;
    const nativeCatalog = vi.fn(async () =>
      (installed ? [first, discovered] : [first]).map((model) =>
        Object.assign({}, model, { nativeRuntime: "fixture-cli" }),
      ),
    );
    const input = installCatalogBackend(async (context) => {
      if (repairRequested && changesRuntime && !installed) {
        await context.withMaintenance!(async () => {
          context.assertCurrent();
          repairs += 1;
          installed = true;
        });
      }
      return {
        models: Object.fromEntries(context.modelIds.map((id) => [id, { available: true }])),
        nextCheckAt: Date.now() + 86_400_000,
      };
    }, nativeCatalog);
    // Provider discovery has no copy of the native CLI menu.
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({ entries: [], routeVariants: [] });
    let removeListener: (() => void) | undefined;
    let requested = false;
    try {
      const owner = await publishPreparedModelRuntimeSnapshot(input, { catalogMode: "static" });
      const original = await owner.loadFullModelCatalog!({ refresh: true, wait: true });
      expect(original.entries.map(({ id }) => id)).toEqual(["first"]);
      expect(nativeCatalog).toHaveBeenCalledOnce();
      removeListener = registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "catalog-published" || event.phase === "catalog-failed") {
          renewed.resolve();
        }
      });
      repairRequested = true;
      if (expiry === "compatibility") {
        clock.mockReturnValue(now + 86_400_001);
      } else {
        const inventory = resolvePreparedModelRuntimeOwnerBySnapshot(owner)!.catalogInventory!;
        inventory.providers.get("custom")!.expiresAt = 0;
      }
      requested = true;
      owner.refreshExpiredModelCatalog!();
      await withinTest(renewed.promise, signal);
      // Both fixture discovery owners settle in promise reactions. Drain publication
      // continuations after the first event without issuing a repairing manual refresh.
      await nextEventLoopTurn();
      expect(repairs).toBe(changesRuntime ? 1 : 0);
      expect(
        owner.readFullModelCatalog!()
          ?.entries.map(({ id }) => id)
          .toSorted(),
      ).toEqual(changesRuntime ? ["discovered", "first"] : ["first"]);
      expect(nativeCatalog).toHaveBeenCalledTimes(changesRuntime ? 2 : 1);
    } finally {
      if (requested) {
        await withinTest(renewed.promise, signal);
        await nextEventLoopTurn();
      }
      removeListener?.();
      clock.mockRestore();
    }
  },
);
