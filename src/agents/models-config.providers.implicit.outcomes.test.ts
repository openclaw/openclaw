import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { UnresolvedSecretInputError } from "../config/types.secrets.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { modelDefinition } from "./model-auth.fixtures.test-support.js";
import {
  prepareImplicitProviderStaticCatalog,
  resolveImplicitProviders,
} from "./models-config.providers.implicit.js";
import {
  PreparedModelRuntimePluginGenerationRetiredError,
  PreparedModelRuntimePublicationSupersededError,
} from "./prepared-model-runtime-admission-errors.js";
import { prepareAgentCatalogSource } from "./prepared-model-runtime.scoped-catalog.js";

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

it.each([false, true])(
  "reports a failed static catalog as unavailable (prepared=%s)",
  async (prepared) => {
    await withOpenClawTestState({ label: "static-catalog-failure" }, async (state) => {
      const staticOnly = (
        id: string,
        run: () => Promise<{ provider: ReturnType<typeof catalog> }>,
      ) => ({ id, label: id, auth: [], pluginId: id, staticCatalog: { run } }) as ProviderPlugin;
      fixture.providers = [
        staticOnly("broken", async () => {
          throw new Error("static catalog bug");
        }),
        staticOnly("healthy", async () => ({
          provider: { ...catalog("Healthy"), api: "openai-completions" },
        })),
      ];
      const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          { id: "broken", providers: ["broken"] },
          { id: "healthy", providers: ["healthy"] },
        ],
      });
      const outcomes: ProviderCatalogOutcome[] = [];
      const providers = await resolveImplicitProviders({
        agentDir: state.agentDir(),
        env: state.env,
        ...discovery(),
        pluginMetadataSnapshot,
        ...(prepared
          ? {
              preparedStaticProviderCatalog: await prepareImplicitProviderStaticCatalog({
                config: {},
                env: state.env,
                pluginMetadataSnapshot,
              }),
            }
          : {}),
        onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
      });
      expect(Object.keys(providers ?? {})).toEqual(["healthy"]);
      expect(outcomes).toEqual([{ provider: "broken", status: "unavailable" }]);
    });
  },
);

it.each([false, true])(
  "reports a failed shared static hook for its selected identity (prepared=%s)",
  async (prepared) => {
    await withOpenClawTestState({ label: "static-family-failure" }, async (state) => {
      fixture.providers = [
        {
          id: "family",
          label: "family",
          auth: [],
          pluginId: "family-owner",
          hookAliases: ["family-plan"],
          staticCatalog: {
            run: async () => {
              throw new Error("static catalog bug");
            },
          },
        },
      ];
      const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "family-owner", providers: ["family", "family-plan"] }],
      });
      const outcomes: ProviderCatalogOutcome[] = [];
      await resolveImplicitProviders({
        agentDir: state.agentDir(),
        env: state.env,
        ...discovery(),
        pluginMetadataSnapshot,
        providerDiscoveryProviderIds: ["family-plan"],
        ...(prepared
          ? {
              preparedStaticProviderCatalog: await prepareImplicitProviderStaticCatalog({
                config: {},
                env: state.env,
                pluginMetadataSnapshot,
                providerDiscoveryProviderIds: ["family-plan"],
              }),
            }
          : {}),
        onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
      });
      expect(outcomes).toEqual([{ provider: "family-plan", status: "unavailable" }]);
    });
  },
);

it.each([
  { failure: undefined, fatal: false },
  { failure: new Error("synthetic preparation failed"), fatal: false },
  { failure: new PluginInstanceUnavailableError("broken"), fatal: true },
  { failure: new PreparedModelRuntimePluginGenerationRetiredError("retired"), fatal: true },
  { failure: new PreparedModelRuntimePublicationSupersededError("superseded"), fatal: true },
  {
    failure: new UnresolvedSecretInputError({
      path: "models.providers.broken.apiKey",
      ref: { source: "env", provider: "default", id: "MISSING_FIXTURE" },
    }),
    fatal: true,
  },
])("preserves live-source synthetic auth outcome: %j", async ({ failure, fatal }) => {
  await withOpenClawTestState({ label: "live-source-synthetic" }, async (state) => {
    const prepare = vi.fn(async () => {
      if (failure) {
        throw failure;
      }
      return undefined;
    });
    const run = vi.fn<Catalog["run"]>(async () => ({
      provider: { ...catalog("Broken"), api: "openai-completions" },
    }));
    const healthyPrepare = vi.fn<NonNullable<ProviderPlugin["prepareSyntheticAuth"]>>(async () => ({
      apiKey: "healthy-marker",
      source: "fixture",
      mode: "api-key",
    }));
    fixture.providers = [
      plugin("broken", "simple", run, {
        pluginId: "broken",
        aliases: ["broken-alias"],
        prepareSyntheticAuth: prepare,
      }),
      plugin(
        "healthy",
        "simple",
        async () => ({ provider: { ...catalog("Healthy"), api: "openai-completions" } }),
        { pluginId: "healthy", prepareSyntheticAuth: healthyPrepare },
      ),
    ];
    const refs = ["broken", "broken-alias", "healthy"];
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: "broken", providers: refs.slice(0, 2) },
        { id: "healthy", providers: ["healthy"] },
      ],
    });
    metadata.index.plugins[0]!.syntheticAuthRefs = refs.slice(0, 2);
    metadata.index.plugins[1]!.syntheticAuthRefs = ["healthy"];
    const registry = createEmptyPluginRegistry();
    registry.providers = fixture.providers.map((provider) => ({
      pluginId: provider.id,
      provider,
      source: "test",
    }));
    const operation = prepareAgentCatalogSource(
      {
        input: { config: {}, agentDir: state.agentDir(), env: state.env, readOnly: true },
        env: state.env,
        providerIds: refs,
      },
      { pluginMetadataSnapshot: metadata, pluginRegistry: registry },
      "live",
      false,
      { authStore: { version: 1, profiles: {} } },
    );
    if (fatal) {
      await expect(operation).rejects.toBe(failure);
      expect(prepare).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
      return;
    }
    const source = await operation;
    expect(prepare).toHaveBeenCalledTimes(failure ? 1 : 2);
    expect(healthyPrepare).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(failure ? 0 : 1);
    expect(
      source.pluginCatalogs.flatMap(({ contents }) => Object.keys(JSON.parse(contents).providers)),
    ).toEqual(failure ? ["healthy"] : refs);
    expect(source.providerOutcomes).toEqual(
      failure ? refs.slice(0, 2).map((provider) => ({ provider, status: "unavailable" })) : [],
    );
  });
});
