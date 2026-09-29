// Covers provider-key canonicalization plus secret marker persistence safeguards.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigIoContext } from "../config/io.context.js";
import { readConfigFileSnapshotFromContext } from "../config/io.snapshot.js";
import { ModelsConfigSchema } from "../config/zod-schema.core.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeProviderCatalogModelsForConfig } from "./models-config.providers.catalog.js";
import { normalizeProviders } from "./models-config.providers.normalize.js";
import { enforceSourceManagedProviderSecrets } from "./models-config.providers.source-managed.js";

vi.mock("./models-config.providers.policy.js", () => ({
  normalizeProviderSpecificConfig: (_provider: string, config: object) => config,
  resolveProviderConfigApiKeyResolver: () => undefined,
}));

describe("normalizeProviders", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const createModel = (
    overrides: Partial<
      NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]["models"][number]
    > = {},
  ) => ({
    // Compact default model row reused by normalization cases that only vary ids.
    id: "config-model",
    name: "Config model",
    input: ["text"] as Array<"text" | "image">,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
    ...overrides,
  });

  it("keeps the latest provider config when duplicate keys only differ by whitespace", () => {
    const agentDir = tempDirs.make("provider-normalize-");
    const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-completions",
        apiKey: "OPENAI_API_KEY", // pragma: allowlist secret
        models: [],
      },
      " openai ": {
        baseUrl: "https://example.com/v1",
        api: "openai-completions",
        apiKey: "CUSTOM_OPENAI_API_KEY", // pragma: allowlist secret
        models: [createModel({ id: "gpt-4.1-mini" })],
      },
    };

    const normalized = normalizeProviders({ providers, agentDir });
    expect(Object.keys(normalized ?? {})).toEqual(["openai"]);
    expect(normalized?.openai?.baseUrl).toBe("https://example.com/v1");
    expect(normalized?.openai?.apiKey).toBe("CUSTOM_OPENAI_API_KEY");
    expect(normalized?.openai?.models?.[0]?.id).toBe("gpt-4.1-mini");
  });

  it("deduplicates model rows and keeps repeated publication stable with secret ownership", () => {
    const agentDir = tempDirs.make("provider-normalize-");
    const providers = {
      google: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        api: "google-generative-ai",
        apiKey: "GOOGLE_API_KEY", // pragma: allowlist secret
        models: [
          createModel({
            id: "gemini-3-pro-preview",
            name: "Pinned Gemini",
            contextWindow: 12345,
            cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
          }),
          createModel({
            id: "gemini-3.1-pro-preview",
            name: "Discovered Gemini",
            contextWindow: 1_048_576,
            maxTokens: 65536,
            reasoning: true,
          }),
        ],
      },
      custom: { baseUrl: "https://models.example/v1", models: [] },
    } satisfies NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;

    const normalized = normalizeProviders({ providers, agentDir, env: {} });
    expect(normalized?.google?.models).toBe(providers.google.models);
    const published = normalizeProviderCatalogModelsForConfig(normalized);

    expect(published?.google?.models).toHaveLength(1);
    // The first normalized row wins so explicit config details are not replaced by discovery.
    const model = published?.google?.models?.[0];
    expect(model?.id).toBe("gemini-3.1-pro-preview");
    expect(model?.name).toBe("Pinned Gemini");
    expect(model?.contextWindow).toBe(12345);
    expect(model?.maxTokens).toBe(2048);
    expect(model?.reasoning).toBe(false);
    expect(model?.cost).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });

    expect(normalizeProviderCatalogModelsForConfig(published)).toBe(published);
    const secretRefManagedProviders = new Set<string>();
    const repeated = normalizeProviders({
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

  it("replaces resolved env var value with env var name to prevent plaintext persistence", () => {
    const agentDir = tempDirs.make("provider-normalize-");
    const env = {
      ...process.env,
      OPENAI_API_KEY: "sk-test-secret-value-12345", // pragma: allowlist secret
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    };
    const secretRefManagedProviders = new Set<string>();
    const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test-secret-value-12345", // pragma: allowlist secret; simulates resolved ${OPENAI_API_KEY}
        api: "openai-completions",
        models: [createModel({ id: "gpt-4.1" })],
      },
    };
    const normalized = normalizeProviders({
      providers,
      agentDir,
      env,
      secretRefManagedProviders,
    });
    expect(normalized?.openai?.apiKey).toBe("OPENAI_API_KEY");
    expect(secretRefManagedProviders.has("openai")).toBe(true);
  });

  it("normalizes SecretRef-backed provider headers to non-secret marker values", () => {
    const agentDir = tempDirs.make("provider-normalize-");
    const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-completions",
        headers: {
          Authorization: { source: "env", provider: "default", id: "OPENAI_HEADER_TOKEN" },
          "X-Tenant-Token": { source: "file", provider: "vault", id: "/openai/token" },
        },
        models: [],
      },
    };

    const normalized = normalizeProviders({
      providers,
      agentDir,
    });
    // Env refs persist the env-name marker; non-env refs collapse to a non-secret sentinel.
    expect(normalized?.openai?.headers?.Authorization).toBe("secretref-env:OPENAI_HEADER_TOKEN");
    expect(normalized?.openai?.headers?.["X-Tenant-Token"]).toBe(NON_ENV_SECRETREF_MARKER);
  });

  it.each([
    {
      label: "substituted literal",
      authored: "${HEADER_SOURCE}",
      env: { HEADER_SOURCE: "${HEADER_LITERAL}" },
      expected: "${HEADER_LITERAL}",
    },
    {
      label: "pending reference",
      authored: "$HEADER_PENDING",
      env: {},
      expected: "secretref-env:HEADER_PENDING",
    },
  ])(
    "preserves loader $label headers through normalization and source enforcement",
    async ({ authored, env, expected }) => {
      await withOpenClawTestState(
        {
          label: "catalog-header-facts",
          env: { HEADER_LITERAL: undefined, HEADER_PENDING: undefined, ...env },
        },
        async (state) => {
          await state.writeConfig({
            plugins: { enabled: false },
            models: {
              providers: {
                custom: {
                  baseUrl: "https://provider.example/v1",
                  api: "openai-completions",
                  apiKey: "plain-fixture-key",
                  models: [],
                  headers: { "X.Trace": authored },
                },
              },
            },
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
          const normalized = normalizeProviders({
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
    type ConfigModel = NonNullable<
      NonNullable<OpenClawConfig["models"]>["providers"]
    >[string]["models"][number];
    const modelWithPartialCost = (id: string, cost: Partial<NonNullable<ConfigModel["cost"]>>) =>
      ({ ...createModel({ id }), cost }) as ConfigModel;
    const tieredPricing = [
      {
        input: 8,
        output: 40,
        cacheRead: 0.1,
        cacheWrite: 1,
        range: [0, 1_000_000] as [number, number],
      },
    ];
    const providers = {
      custom: {
        baseUrl: "https://models.example/v1",
        models: [
          modelWithPartialCost("partial", { input: 10, output: 50, tieredPricing }),
          createModel({ id: "unknown", cost: undefined }),
          modelWithPartialCost("duplicate", { input: 3, output: 15 }),
          modelWithPartialCost("duplicate", { cacheRead: 0.3, cacheWrite: 3.75 }),
        ],
      },
    } as unknown as NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;

    expect(ModelsConfigSchema.safeParse({ providers }).success).toBe(true);
    expect(normalizeProviderCatalogModelsForConfig(providers)?.custom?.models).toEqual([
      createModel({
        id: "partial",
        cost: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0, tieredPricing },
      }),
      createModel({ id: "unknown", cost: undefined }),
      createModel({
        id: "duplicate",
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      }),
    ]);
  });
});
