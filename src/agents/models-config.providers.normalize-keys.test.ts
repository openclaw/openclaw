import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigIoContext } from "../config/io.context.js";
import { readConfigFileSnapshotFromContext } from "../config/io.snapshot.js";
import { ModelsConfigSchema } from "../config/zod-schema.core.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { configForProviders, modelDefinition } from "./model-auth.fixtures.test-support.js";
import { normalizeProviderCatalogModelsForConfig } from "./models-config.providers.catalog.js";
import { normalizeProviders } from "./models-config.providers.normalize.js";
import { enforceSourceManagedProviderSecrets } from "./models-config.providers.source-managed.js";

// mock-isolation: normalization consumes hook results without loading the plugin runtime.
vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderConfigWithPlugin: () => undefined,
  resolveProviderConfigApiKeyWithPlugin: () => undefined,
}));

describe("normalizeProviders", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  type Providers = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;
  type ConfigModel = Providers[string]["models"][number];
  const provider = (overrides: Partial<Providers[string]> = {}): Providers[string] => ({
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    models: [],
    ...overrides,
  });
  const normalize = (
    providers: Providers,
    options: Partial<Parameters<typeof normalizeProviders>[0]> = {},
  ) =>
    normalizeProviders({
      providers,
      ...options,
      agentDir: options.agentDir ?? tempDirs.make("provider-normalize-"),
    });

  it("keeps the latest provider config when duplicate keys only differ by whitespace", async () => {
    const providers = {
      openai: provider({ apiKey: "OPENAI_API_KEY" }), // pragma: allowlist secret
      " openai ": provider({
        baseUrl: "https://example.com/v1",
        apiKey: "CUSTOM_OPENAI_API_KEY", // pragma: allowlist secret
        models: [modelDefinition("gpt-4.1-mini")],
      }),
    };
    const normalized = await normalize(providers);
    expect(Object.keys(normalized ?? {})).toEqual(["openai"]);
    expect(normalized?.openai).toMatchObject({
      baseUrl: "https://example.com/v1",
      apiKey: "CUSTOM_OPENAI_API_KEY",
      models: [{ id: "gpt-4.1-mini" }],
    });
  });

  it("deduplicates model rows and keeps repeated publication stable with secret ownership", async () => {
    const agentDir = tempDirs.make("provider-normalize-");
    const pinned = modelDefinition("gemini-3-pro-preview", {
      name: "Pinned Gemini",
      contextWindow: 12345,
      maxTokens: 2048,
      reasoning: false,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    });
    const expected = { ...structuredClone(pinned), id: "gemini-3.1-pro-preview" };
    const providers = {
      google: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        api: "google-generative-ai",
        apiKey: "GOOGLE_API_KEY", // pragma: allowlist secret
        models: [
          pinned,
          modelDefinition("gemini-3.1-pro-preview", {
            name: "Discovered Gemini",
            contextWindow: 1_048_576,
            maxTokens: 65536,
            reasoning: true,
          }),
        ],
      },
      custom: { baseUrl: "https://models.example/v1", models: [] },
    } satisfies Providers;

    const normalized = await normalize(providers, { agentDir, env: {} });
    expect(normalized?.google?.models).toBe(providers.google.models);
    const published = normalizeProviderCatalogModelsForConfig(normalized);

    // The first normalized row wins so explicit config details are not replaced by discovery.
    expect(published?.google?.models).toEqual([expected]);

    expect(normalizeProviderCatalogModelsForConfig(published)).toBe(published);
    const secretRefManagedProviders = new Set<string>();
    const repeated = await normalizeProviders({
      providers: published,
      agentDir,
      env: {},
      secretRefManagedProviders,
    });
    // A no-op object pass must still record marker ownership for secret preservation.
    expect(repeated).toBe(published);
    expect(normalizeProviderCatalogModelsForConfig(repeated)).toBe(published);
    expect(secretRefManagedProviders.has("google")).toBe(true);
  });

  it("replaces resolved env var value with env var name to prevent plaintext persistence", async () => {
    const env = {
      ...process.env,
      OPENAI_API_KEY: "sk-test-secret-value-12345", // pragma: allowlist secret
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    };
    const secretRefManagedProviders = new Set<string>();
    const providers = {
      openai: provider({
        apiKey: "sk-test-secret-value-12345", // pragma: allowlist secret; simulates resolved ${OPENAI_API_KEY}
        models: [modelDefinition("gpt-4.1")],
      }),
    };
    const normalized = await normalize(providers, { env, secretRefManagedProviders });
    expect(normalized?.openai?.apiKey).toBe("OPENAI_API_KEY");
    expect(secretRefManagedProviders.has("openai")).toBe(true);
  });

  it("normalizes SecretRef-backed provider headers to non-secret marker values", async () => {
    const providers = {
      openai: provider({
        headers: {
          Authorization: { source: "env", provider: "default", id: "OPENAI_HEADER_TOKEN" },
          "X-Tenant-Token": { source: "file", provider: "vault", id: "/openai/token" },
        },
      }),
    };
    const normalized = await normalize(providers);
    // Env refs persist the env-name marker; non-env refs collapse to a non-secret sentinel.
    expect(normalized?.openai?.headers?.Authorization).toBe("secretref-env:OPENAI_HEADER_TOKEN");
    expect(normalized?.openai?.headers?.["X-Tenant-Token"]).toBe(NON_ENV_SECRETREF_MARKER);
  });

  it.each([
    [
      "substituted literal",
      "${HEADER_SOURCE}",
      { HEADER_SOURCE: "${HEADER_LITERAL}" },
      "${HEADER_LITERAL}",
    ],
    ["pending reference", "$HEADER_PENDING", {}, "secretref-env:HEADER_PENDING"],
  ] satisfies Array<[string, string, NodeJS.ProcessEnv, string]>)(
    "preserves loader %s headers through normalization and source enforcement",
    async (_label, authored, env, expected) => {
      await withOpenClawTestState(
        {
          label: "catalog-header-facts",
          env: { HEADER_LITERAL: undefined, HEADER_PENDING: undefined, ...env },
        },
        async (state) => {
          await state.writeConfig({
            plugins: { enabled: false },
            ...configForProviders({
              custom: provider({
                baseUrl: "https://provider.example/v1",
                apiKey: "plain-fixture-key",
                headers: { "X.Trace": authored },
              }),
            }),
          });
          const snapshot = await readConfigFileSnapshotFromContext(
            createConfigIoContext({
              configPath: state.configPath,
              env: state.env,
              homedir: () => state.home,
              observe: false,
            }),
          );
          expect(snapshot.valid).toBe(true);
          const params = {
            providers: snapshot.config.models?.providers,
            sourceConfigForSecrets: snapshot.sourceConfig,
          };
          const normalized = await normalizeProviders({
            ...params,
            agentDir: state.agentDir(),
            env: state.env,
          });
          const enforced = enforceSourceManagedProviderSecrets(params);
          expect({
            normalized: normalized?.custom?.headers?.["X.Trace"],
            enforced: enforced?.custom?.headers?.["X.Trace"],
          }).toEqual({ normalized: expected, enforced: expected });
        },
      );
    },
  );

  it("publishes schema-complete costs after duplicate model rows merge", () => {
    const modelWithPartialCost = (id: string, cost: Partial<NonNullable<ConfigModel["cost"]>>) =>
      ({ ...modelDefinition(id), cost }) as ConfigModel;
    const tieredPricing = [
      {
        input: 8,
        output: 40,
        cacheRead: 0.1,
        cacheWrite: 1,
        range: [0, 1_000_000] as [number, number],
      },
    ];
    const providers: Providers = {
      custom: {
        baseUrl: "https://models.example/v1",
        models: [
          modelWithPartialCost("partial", { input: 10, output: 50, tieredPricing }),
          modelDefinition("unknown", { cost: undefined }),
          modelWithPartialCost("duplicate", { input: 3, output: 15 }),
          modelWithPartialCost("duplicate", { cacheRead: 0.3, cacheWrite: 3.75 }),
        ],
      },
    };

    expect(ModelsConfigSchema.safeParse({ providers }).success).toBe(true);
    expect(normalizeProviderCatalogModelsForConfig(providers)?.custom?.models).toEqual([
      modelDefinition("partial", {
        cost: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0, tieredPricing },
      }),
      modelDefinition("unknown", { cost: undefined }),
      modelDefinition("duplicate", {
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      }),
    ]);
  });
});
