import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { modelDefinition } from "./model-auth.fixtures.test-support.js";
import { resolveImplicitProviders } from "./models-config.providers.implicit.js";

const fixture = vi.hoisted(() => ({ providers: new Array<ProviderPlugin>() }));
vi.mock("../plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => fixture.providers,
}));

const catalog = (name: string, id = "shared") => ({
  baseUrl: "https://catalog.example.invalid/v1",
  models: [modelDefinition(id, { name, reasoning: false, contextWindow: 32768, maxTokens: 4096 })],
});
type Catalog = NonNullable<ProviderPlugin["catalog"]>;
const plugin = (
  id: string,
  order: Catalog["order"],
  run: Catalog["run"],
  fields: Partial<ProviderPlugin> = {},
): ProviderPlugin => ({ id, label: id, auth: [], ...fields, catalog: { order, run } });
const discovery = () => ({ config: {}, authStore: { version: 1 as const, profiles: {} } });

it("keeps canonical outcome authority when only its alias is selected", async () => {
  await withOpenClawTestState({ label: "implicit-catalog-outcomes" }, async (state) => {
    const failure: ProviderCatalogOutcome = { provider: "canonical", status: "unavailable" };
    fixture.providers = [
      plugin(
        "canonical",
        "profile",
        async (ctx) => {
          expect(ctx.providerIds).toEqual(["alias"]);
          return {
            provider: { ...catalog("learned", "learned"), api: "openai-completions" },
            outcomes: [failure, { provider: "sibling", status: "auth-rejected" }],
          };
        },
        { pluginId: "catalog-owner", aliases: ["alias"], hookAliases: ["sibling"] },
      ),
    ];
    const outcomes: ProviderCatalogOutcome[] = [];
    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      env: state.env,
      ...discovery(),
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "catalog-owner",
            providers: ["canonical", "alias", "sibling"],
            modelCatalog: { aliases: { alias: { provider: "canonical" } } },
          },
        ],
      }),
      providerDiscoveryProviderIds: ["alias"],
      onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(Object.keys(providers ?? {})).toEqual(["alias"]);
    expect(outcomes).toEqual([failure]);
  });
});

it("preserves merge order across bounded concurrent catalogs", async ({ signal }) => {
  await withOpenClawTestState({ label: "concurrent-catalogs" }, async (state) => {
    vi.useFakeTimers();
    const entered = createDeferred();
    const delays = [60, 50, 40, 10, 10, 10];
    const discoveryDurationMs = delays.reduce((total, delay) => total + delay, 0);
    const finished: number[] = [];
    const outcomes: ProviderCatalogOutcome[] = [];
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    fixture.providers = delays.map((delay, index) =>
      plugin(`provider-${index}`, "simple", async () => {
        started.push(index);
        peak = Math.max(peak, ++active);
        entered.resolve();
        await new Promise((resolve) => {
          setTimeout(resolve, delay);
        });
        active--;
        finished.push(index);
        return {
          providers: {
            within: catalog(`provider-${index}`),
            between: catalog(`provider-${index}`),
          },
          outcomes: [{ provider: "within", profileId: String(index), status: "ready" }],
        };
      }),
    );
    fixture.providers.push(
      plugin("late", "late", async () => {
        expect(active).toBe(0);
        return { providers: { between: catalog("late") } };
      }),
    );
    const operation = resolveImplicitProviders({
      agentDir: state.agentDir(),
      env: state.env,
      ...discovery(),
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
      onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, operation, "Catalogs must start"),
        signal,
      );
      await vi.advanceTimersByTimeAsync(discoveryDurationMs);
      const providers = await operation;
      expect(peak).toBe(4);
      expect(started).toEqual([0, 1, 2, 3, 4, 5]);
      expect(finished).toEqual([3, 4, 5, 2, 1, 0]);
      expect(outcomes.map(({ profileId }) => profileId)).toEqual(["0", "1", "2", "3", "4", "5"]);
      expect(providers).toMatchObject({
        within: { models: [{ name: "provider-0" }] },
        between: { models: [{ name: "late" }] },
      });
    } finally {
      await vi.advanceTimersByTimeAsync(discoveryDurationMs);
      vi.useRealTimers();
      await operation;
    }
  });
});
