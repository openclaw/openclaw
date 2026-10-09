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
import { resolveImplicitProviders } from "./models-config.providers.implicit.js";

const fixture = vi.hoisted(() => ({ providers: new Array<ProviderPlugin>() }));
vi.mock("../plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => fixture.providers,
}));

it("keeps canonical outcome authority when only its alias is selected", async () => {
  await withOpenClawTestState({ label: "implicit-catalog-outcomes" }, async (state) => {
    const failure: ProviderCatalogOutcome = {
      provider: "canonical",
      profileId: "canonical:account",
      status: "unavailable",
    };
    fixture.providers = [
      {
        id: "canonical",
        pluginId: "catalog-owner",
        label: "canonical",
        auth: [],
        aliases: ["alias"],
        hookAliases: ["sibling"],
        catalog: {
          order: "profile",
          run: async (ctx) => {
            expect(ctx.providerIds).toEqual(["alias"]);
            return {
              provider: {
                baseUrl: "https://catalog.example.invalid/v1",
                api: "openai-completions",
                models: [
                  {
                    id: "learned",
                    name: "learned",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32768,
                    maxTokens: 4096,
                  },
                ],
              },
              outcomes: [
                failure,
                { provider: "sibling", profileId: "sibling:account", status: "auth-rejected" },
              ],
            };
          },
        },
      },
    ];
    const outcomes: ProviderCatalogOutcome[] = [];
    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      env: state.env,
      config: {},
      authStore: { version: 1, profiles: {} },
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

it("bounds concurrent discovery and preserves merge order when catalogs finish out of order", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "concurrent-catalogs" }, async (state) => {
    vi.useFakeTimers();
    const entered = createDeferred();
    const delays = [60, 50, 40, 10, 10, 10];
    const finished: number[] = [];
    const outcomes: ProviderCatalogOutcome[] = [];
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    let lateStarted = false;
    const catalog = (name: string) => ({
      baseUrl: "https://catalog.example.invalid/v1",
      models: [
        {
          id: "shared",
          name,
          reasoning: false,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 4096,
        },
      ],
    });
    fixture.providers = delays.map((delay, index) => ({
      id: `provider-${index}`,
      label: `provider-${index}`,
      auth: [],
      catalog: {
        order: "simple",
        run: async () => {
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
        },
      },
    }));
    fixture.providers.push({
      id: "late",
      label: "late",
      auth: [],
      catalog: {
        order: "late",
        run: async () => {
          lateStarted = true;
          expect(active).toBe(0);
          return { providers: { between: catalog("late") } };
        },
      },
    });
    const operation = resolveImplicitProviders({
      agentDir: state.agentDir(),
      env: state.env,
      config: {},
      authStore: { version: 1, profiles: {} },
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
      onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, operation, "Catalogs must start"),
        signal,
      );
      await vi.runAllTimersAsync();
      const providers = await operation;
      expect(peak).toBe(4);
      expect(started).toEqual([0, 1, 2, 3, 4, 5]);
      expect(finished).toEqual([3, 4, 5, 2, 1, 0]);
      expect(outcomes.map(({ profileId }) => profileId)).toEqual(["0", "1", "2", "3", "4", "5"]);
      expect(providers).toMatchObject({
        within: { models: [{ name: "provider-0" }] },
        between: { models: [{ name: "late" }] },
      });
      expect(lateStarted).toBe(true);
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await operation;
    }
  });
});
