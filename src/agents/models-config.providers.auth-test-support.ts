import path from "node:path";
import { beforeAll, beforeEach, vi } from "vitest";
import type { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createAuthProfileStoreFixture } from "./auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";

const discovery = vi.hoisted(() => ({ providers: new Array<ProviderPlugin>() }));
vi.mock("../plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => discovery.providers,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderConfigWithPlugin: vi.fn(
    (params: { provider: string; context?: { providerConfig?: { baseUrl?: string } } }) => {
      const providerConfig = params.context?.providerConfig;
      const baseUrl = providerConfig?.baseUrl?.trim();
      if (params.provider !== "google" || !baseUrl || baseUrl.endsWith("/v1beta")) {
        return providerConfig;
      }
      return {
        ...providerConfig,
        baseUrl:
          baseUrl === "https://generativelanguage.googleapis.com"
            ? `${baseUrl}/v1beta`
            : providerConfig?.baseUrl,
      };
    },
  ),
  resolveProviderConfigApiKeyWithPlugin: (params: {
    provider: string;
    context: { env: NodeJS.ProcessEnv };
  }) => {
    if (params.provider === "amazon-bedrock") {
      return params.context.env.AWS_PROFILE?.trim() ? "AWS_PROFILE" : undefined;
    }
    if (params.provider === "anthropic-vertex") {
      return params.context.env.ANTHROPIC_VERTEX_USE_GCP_METADATA === "true"
        ? "gcp-vertex-credentials"
        : undefined;
    }
    return undefined;
  },
  resolveProviderSyntheticAuthWithPlugin: vi.fn(),
}));

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({ "proof-alias": "openai" }),
  resolveProviderIdForAuth: (provider: string) => {
    const normalized = provider.trim().toLowerCase();
    return normalized === "proof-alias" ? "openai" : normalized;
  },
}));

type ProviderRuntimeModule = typeof import("../plugins/provider-runtime.js");

export let CUSTOM_LOCAL_AUTH_MARKER: typeof import("./model-auth-markers.js").CUSTOM_LOCAL_AUTH_MARKER;
export let resolveApiKeyFromCredential: typeof import("./models-config.providers.secret-helpers.js").resolveApiKeyFromCredential;
export let createProviderApiKeyResolver: typeof import("./models-config.providers.secrets.js").createProviderApiKeyResolver;
export let createProviderAuthResolver: typeof import("./models-config.providers.secrets.js").createProviderAuthResolver;
export let mockedResolveProviderSyntheticAuthWithPlugin: ReturnType<
  typeof vi.mocked<ProviderRuntimeModule["resolveProviderSyntheticAuthWithPlugin"]>
>;

async function loadProviderAuthModules() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  const [providerRuntimeModule, markersModule, helperModule, secretsModule] = await Promise.all([
    import("../plugins/provider-runtime.js"),
    import("./model-auth-markers.js"),
    import("./models-config.providers.secret-helpers.js"),
    import("./models-config.providers.secrets.js"),
  ]);
  mockedResolveProviderSyntheticAuthWithPlugin = vi.mocked(
    providerRuntimeModule.resolveProviderSyntheticAuthWithPlugin,
  );
  CUSTOM_LOCAL_AUTH_MARKER = markersModule.CUSTOM_LOCAL_AUTH_MARKER;
  resolveApiKeyFromCredential = helperModule.resolveApiKeyFromCredential;
  createProviderApiKeyResolver = secretsModule.createProviderApiKeyResolver;
  createProviderAuthResolver = secretsModule.createProviderAuthResolver;
}

export function setupProviderAuthProvenanceTests() {
  beforeEach(() => {
    vi.doUnmock("../plugins/manifest-registry.js");
    vi.doUnmock("../secrets/provider-env-vars.js");
    mockedResolveProviderSyntheticAuthWithPlugin.mockReset().mockReturnValue(undefined);
  });

  beforeAll(loadProviderAuthModules);
}

export const configRef = { source: "store", provider: "default", id: "CONFIG_KEY" } as const;
export const configWithKey = (
  apiKey: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]["apiKey"],
): OpenClawConfig => ({
  models: {
    providers: { openai: { baseUrl: "https://catalog.example.test/v1", apiKey, models: [] } },
  },
});

export function createProviderAuthDiscoveryFixture(
  tempDirs: ReturnType<typeof useAutoCleanupTempDirTracker>,
) {
  type DiscoveryCallback = "resolveProviderAuth" | "resolveProviderApiKey";

  return async function withDiscoveryFixture(
    type: "api_key" | "token",
    callback: DiscoveryCallback,
    check: (fixture: {
      store: AuthProfileStore;
      published: AuthProfileStore;
      profileId: string;
      agentDir: string;
      runtimeKey: string;
      env: NodeJS.ProcessEnv;
      publish: (agentDir?: string) => void;
      clear: () => void;
      cold: () => void;
      discover: (
        config?: OpenClawConfig,
      ) => ReturnType<
        typeof import("./models-config.providers.implicit.js").resolveImplicitProviders
      >;
      emitOutcome: () => void;
      plan: (
        source?: OpenClawConfig,
        prepared?: OpenClawConfig,
      ) => ReturnType<typeof import("./models-config.plan.js").planOpenClawModelsJson>;
      authorization: Array<string | null>;
      authResults: Array<{ apiKey?: string; discoveryApiKey?: string }>;
      outcomes: Array<import("../plugins/provider-catalog.types.js").ProviderCatalogOutcome>;
      errors: unknown[];
      canonical: () => Promise<string | undefined>;
    }) => Promise<void>,
    requestedProvider = " OPENAI ",
    refSource: "store" | "env" = "store",
  ) {
    const stateDir = tempDirs.make("discovery-ref-provenance-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, OPENAI_API_KEY: undefined }, async () => {
      const { resolveImplicitProviders } = await import("./models-config.providers.implicit.js");
      const { planOpenClawModelsJson } = await import("./models-config.plan.js");
      const { clearRuntimeAuthProfileStoreSnapshots, setRuntimeAuthProfileStoreSnapshot } =
        await import("./auth-profiles/runtime-snapshots.js");
      const { resolveApiKeyForProfile } = await import("./auth-profiles/oauth.js");
      const { setActiveDegradedSecretOwners } =
        await import("../secrets/runtime-degraded-state.js");
      const { resolveAuthProfileSecretOwnerId } =
        await import("../secrets/runtime-auth-profile-owner.js");
      const { fetchLiveProviderModelIds } =
        await import("../plugin-sdk/provider-catalog-live-runtime.js");
      const provider = "openai";
      const profileId = `${provider}:selected`;
      const agentDir = path.join(stateDir, "agent");
      const ref = { source: refSource, provider: "default", id: "DISCOVERY_KEY" } as const;
      const profile: AuthProfileCredential =
        type === "api_key"
          ? { type, provider, keyRef: ref, key: "stale-inline-key" }
          : { type, provider, tokenRef: ref, token: "stale-inline-token" };
      const store: AuthProfileStore = { version: 1, profiles: { [profileId]: profile } };
      const runtimeKey = "runtime-discovery-key";
      const published: AuthProfileStore = createAuthProfileStoreFixture({
        [profileId]:
          profile.type === "api_key"
            ? { ...profile, key: runtimeKey }
            : { ...profile, token: runtimeKey },
      });
      const authorization: Array<string | null> = [];
      const authResults: Array<{ apiKey?: string; discoveryApiKey?: string }> = [];
      const outcomes: Array<import("../plugins/provider-catalog.types.js").ProviderCatalogOutcome> =
        [];
      const errors: unknown[] = [];
      const env: NodeJS.ProcessEnv = {};
      let emitProfileOutcome = false;
      discovery.providers = [
        {
          id: provider,
          label: "a requested provider",
          auth: [],
          catalog: {
            order: "simple",
            run: async (ctx) => {
              try {
                const auth = ctx[callback](requestedProvider);
                authResults.push(auth);
                await fetchLiveProviderModelIds({
                  providerId: provider,
                  endpoint: "https://catalog.example.test/v1/models",
                  ...auth,
                  fetchGuard: async ({ url, init }) => {
                    authorization.push(new Headers(init?.headers).get("authorization"));
                    return {
                      response: Response.json({ data: [{ id: "test-model" }] }),
                      finalUrl: url,
                      release: async () => {},
                    };
                  },
                });
                const result = {
                  provider: {
                    apiKey: auth.apiKey,
                    baseUrl: "https://catalog.example.test/v1",
                    models: [],
                  },
                };
                const selectedProfileId =
                  "profileId" in auth && typeof auth.profileId === "string"
                    ? auth.profileId
                    : undefined;
                return emitProfileOutcome && selectedProfileId
                  ? {
                      ...result,
                      outcomes: [
                        {
                          provider,
                          profileId: selectedProfileId,
                          status: "ready" as const,
                        },
                      ],
                    }
                  : result;
              } catch (error) {
                errors.push(error);
                throw error;
              }
            },
          },
        },
        {
          id: "healthy",
          label: "z independent provider",
          auth: [],
          catalog: {
            order: "simple",
            run: async () => ({
              provider: { baseUrl: "https://healthy.example.test", models: [] },
            }),
          },
        },
      ];
      const publish = (directory = agentDir) =>
        setRuntimeAuthProfileStoreSnapshot(published, directory);
      publish();
      try {
        await check({
          store,
          published,
          profileId,
          agentDir,
          runtimeKey,
          env,
          publish,
          clear: clearRuntimeAuthProfileStoreSnapshots,
          cold: () =>
            setActiveDegradedSecretOwners([
              {
                ownerKind: "account",
                ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId }),
                state: "unavailable",
                degradationState: "cold",
                paths: [],
                refKeys: [],
                reason: "secret reference was not found",
              },
            ]),
          discover: (config = {}) =>
            resolveImplicitProviders({
              agentDir,
              authStore: store,
              config,
              env,
              onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
            }),
          emitOutcome: () => {
            emitProfileOutcome = true;
          },
          plan: (source = {}, prepared = source) =>
            planOpenClawModelsJson({
              context: {
                cfg: source,
                discoveryAuthConfig: prepared,
                sourceConfigForSecrets: source,
                agentDir,
                env,
                envFingerprint: env,
                onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
              },
              authStore: store,
              existingRaw: "",
              existingParsed: null,
            }),
          authorization,
          authResults,
          outcomes,
          errors,
          canonical: async () =>
            (await resolveApiKeyForProfile({ cfg: {}, store, profileId, agentDir }))?.apiKey,
        });
      } finally {
        clearRuntimeAuthProfileStoreSnapshots();
        setActiveDegradedSecretOwners([]);
        discovery.providers = [];
      }
    });
  };
}
