// Covers provider-key canonicalization plus secret marker persistence safeguards.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigIoContext } from "../config/io.context.js";
import { readConfigFileSnapshotFromContext } from "../config/io.snapshot.js";
import { ModelsConfigSchema } from "../config/zod-schema.core.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  materializeConfiguredProviderCatalogModels,
  normalizeProviderCatalogModelsForConfig,
} from "./models-config.providers.catalog.js";
import { normalizeProviders } from "./models-config.providers.normalize.js";
import { resolveApiKeyFromProfiles } from "./models-config.providers.secret-helpers.js";
import { enforceSourceManagedProviderSecrets } from "./models-config.providers.source-managed.js";

function normalizeLmstudioBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/api\/v1$/, "").replace(/\/v1$/, "") + "/v1";
}

vi.mock("./models-config.providers.policy.js", () => {
  return {
    normalizeProviderSpecificConfig: (providerKey: string, provider: { baseUrl?: unknown }) =>
      // Keep the test focused on normalizeProviders while preserving LM Studio policy behavior.
      providerKey === "lmstudio" && typeof provider?.baseUrl === "string"
        ? { ...provider, baseUrl: normalizeLmstudioBaseUrl(provider.baseUrl) }
        : provider,
    resolveProviderConfigApiKeyResolver: () => undefined,
  };
});

describe("normalizeProviders", () => {
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

  it("trims provider keys so image models remain discoverable for custom providers", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        " dashscope-vision ": {
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          api: "openai-completions",
          apiKey: "DASHSCOPE_API_KEY", // pragma: allowlist secret
          models: [
            {
              id: "qwen-vl-max",
              name: "Qwen VL Max",
              input: ["text", "image"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32000,
              maxTokens: 4096,
            },
          ],
        },
      };

      const normalized = normalizeProviders({ providers, agentDir });
      expect(Object.keys(normalized ?? {})).toEqual(["dashscope-vision"]);
      expect(normalized?.["dashscope-vision"]?.models?.[0]?.id).toBe("qwen-vl-max");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps the latest provider config when duplicate keys only differ by whitespace", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
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
          models: [
            {
              id: "gpt-4.1-mini",
              name: "GPT-4.1 mini",
              input: ["text"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
      };

      const normalized = normalizeProviders({ providers, agentDir });
      expect(Object.keys(normalized ?? {})).toEqual(["openai"]);
      expect(normalized?.openai?.baseUrl).toBe("https://example.com/v1");
      expect(normalized?.openai?.apiKey).toBe("CUSTOM_OPENAI_API_KEY");
      expect(normalized?.openai?.models?.[0]?.id).toBe("gpt-4.1-mini");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["google", "gemini-3-pro-preview", "gemini-3.1-pro-preview"],
    ["google-gemini-cli", "gemini-3-pro-preview", "gemini-3.1-pro-preview"],
    ["openrouter", "google/gemini-3-pro-preview", "google/gemini-3.1-pro-preview"],
    ["custom", "proxy/google/gemini-3-pro-preview", "proxy/google/gemini-3.1-pro-preview"],
    ["together", "moonshotai/Kimi-K2.5", "moonshotai/Kimi-K2.6"],
  ])("publishes the named %s retirement %s as %s", (provider, id, expected) => {
    const providers = {
      [provider]: { baseUrl: "https://models.example/v1", models: [createModel({ id })] },
    };
    const normalized = normalizeProviderCatalogModelsForConfig(providers);
    expect(normalized?.[provider]?.models).toEqual([createModel({ id: expected })]);
  });

  const manifestPlugins = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "catalog-identity-fixture",
        providers: ["custom"],
        modelIdNormalization: {
          providers: {
            custom: {
              aliases: {
                latest: "middle",
                middle: "final",
                "alias-a": "target",
                "alias-b": "target",
              },
            },
          },
        },
      },
    ],
  });
  const exactSparseRow = { id: "target", name: "Exact" };
  const populatedAlias = createModel({ id: "alias-a", input: ["text", "image"] });

  it.each([
    {
      name: "one alias step",
      models: [{ id: "latest", name: "Authored" }],
      expected: [{ id: "middle", name: "Authored" }],
    },
    {
      name: "alias-chain membership without raw lookup keys",
      models: ["latest", "middle", "final"].map((id) => ({ id, name: id })),
      expected: [
        { id: "middle", name: "middle" },
        { id: "final", name: "final" },
      ],
    },
    {
      name: "reversed alias-chain membership",
      models: ["final", "middle", "latest"].map((id) => ({ id, name: id })),
      expected: [
        { id: "final", name: "final" },
        { id: "middle", name: "middle" },
      ],
    },
    {
      name: "exact omissions before an alias",
      models: [exactSparseRow, populatedAlias],
      expected: [exactSparseRow],
    },
    {
      name: "exact omissions after an alias",
      models: [populatedAlias, exactSparseRow],
      expected: [exactSparseRow],
    },
    {
      name: "first-equivalent omissions without an exact row",
      models: [{ id: "alias-b", name: "First" }, populatedAlias],
      expected: [{ id: "target", name: "First" }],
    },
    {
      name: "same-spelling partial costs and input omissions",
      models: [
        { id: "latest", name: "First", cost: { input: 7 } },
        { id: "latest", name: "Second", input: ["image"], cost: { input: 9, output: 8 } },
        { id: "latest", name: "Third", input: ["text"], cost: { cacheRead: 0.5 } },
      ],
      expected: [
        {
          id: "middle",
          name: "First",
          input: ["image"],
          cost: { input: 7, output: 8, cacheRead: 0.5 },
        },
      ],
    },
    {
      name: "invalid row positions between normalized members",
      models: [
        { id: "latest", name: "Alias" },
        { id: "", name: "Blank" },
        { id: " \t ", name: "Whitespace" },
        { id: 23, name: "Non-string" },
        { id: "middle", name: "Exact" },
      ],
      expected: [
        { id: "middle", name: "Exact" },
        { id: "", name: "Blank" },
        { id: " \t ", name: "Whitespace" },
        { id: 23, name: "Non-string" },
        { id: "final", name: "Exact" },
      ],
    },
  ])("materializes $name before discovery", ({ models, expected }) => {
    // Raw authored rows intentionally omit fields that discovery will supply.
    const providers = {
      custom: { baseUrl: "https://models.example/v1", models },
    } as unknown as NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;
    const original = structuredClone(providers);
    const materialized = materializeConfiguredProviderCatalogModels(providers, { manifestPlugins });
    expect(materialized?.custom?.models).toStrictEqual(expected);
    expect(providers).toStrictEqual(original);
  });

  it("preserves emitted aliases, case, whitespace, and self-provider namespaces during publication", () => {
    const ids: Array<[string, string[]]> = [
      ["custom", ["latest", "middle", "Model", "model", "custom/Model", " model "]],
      ["anthropic", ["sonnet", "anthropic/sonnet"]],
      ["google", [" unrelated-model "]],
      ["huggingface", ["huggingface/vendor/model"]],
      ["openrouter", ["auto"]],
      ["nvidia", ["Model"]],
      ["together", [" unrelated-model "]],
    ];
    const providers = Object.fromEntries(
      ids.map(([provider, models]) => [
        provider,
        { baseUrl: "https://models.example/v1", models: models.map((id) => createModel({ id })) },
      ]),
    );
    const published = withPluginMetadataSnapshotScope(manifestPlugins, () =>
      normalizeProviderCatalogModelsForConfig(providers),
    );
    expect(published).toBe(providers);
    expect(
      Object.entries(published ?? {}).map(([provider, value]) => [
        provider,
        value.models.map((model) => model.id),
      ]),
    ).toEqual(ids);
  });

  it("deduplicates model rows and keeps repeated publication stable with secret ownership", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
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
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("replaces resolved env var value with env var name to prevent plaintext persistence", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const env = {
      ...process.env,
      OPENAI_API_KEY: "sk-test-secret-value-12345", // pragma: allowlist secret
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    };
    const secretRefManagedProviders = new Set<string>();
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test-secret-value-12345", // pragma: allowlist secret; simulates resolved ${OPENAI_API_KEY}
          api: "openai-completions",
          models: [
            {
              id: "gpt-4.1",
              name: "GPT-4.1",
              input: ["text"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
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
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("normalizes SecretRef-managed provider apiKey values to env markers", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const secretRefManagedProviders = new Set<string>();
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        custom: {
          baseUrl: "https://config.example/v1",
          api: "openai-responses",
          apiKey: { source: "env", provider: "default", id: "CUSTOM_PROVIDER_API_KEY" },
          models: [createModel()],
        },
      };

      const normalized = normalizeProviders({
        providers,
        agentDir,
        secretRefManagedProviders,
      });

      expect(normalized?.custom?.apiKey).toBe("CUSTOM_PROVIDER_API_KEY"); // pragma: allowlist secret
      expect(secretRefManagedProviders.has("custom")).toBe(true);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("reads provider apiKey markers from auth-profiles env refs", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      await fs.writeFile(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "minimax:default": {
                type: "api_key",
                provider: "minimax",
                keyRef: { source: "env", provider: "default", id: "MINIMAX_API_KEY" },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const resolved = resolveApiKeyFromProfiles({
        provider: "minimax",
        store: {
          version: 1,
          profiles: {
            "minimax:default": {
              type: "api_key",
              provider: "minimax",
              keyRef: { source: "env", provider: "default", id: "MINIMAX_API_KEY" },
            },
          },
        },
        env: process.env,
      });

      expect(resolved?.apiKey).toBe("MINIMAX_API_KEY"); // pragma: allowlist secret
      expect(resolved?.source).toBe("env-ref");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("normalizes SecretRef-backed provider headers to non-secret marker values", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
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
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "substituted literal",
      authored: "${HEADER_SOURCE}",
      env: { HEADER_SOURCE: "${HEADER_LITERAL}" },
      expected: "${HEADER_LITERAL}",
    },
    {
      label: "escaped literal",
      authored: "$${HEADER_LITERAL}",
      env: {},
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

  it("ignores non-object provider entries during source-managed enforcement", () => {
    const providers = {
      openai: null,
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        api: "openai-completions",
        apiKey: "sk-runtime-moonshot", // pragma: allowlist secret
        models: [],
      },
    } as unknown as NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;

    const sourceProviders: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-completions",
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
        models: [],
      },
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        api: "openai-completions",
        apiKey: { source: "env", provider: "default", id: "MOONSHOT_API_KEY" }, // pragma: allowlist secret
        models: [],
      },
    };

    const enforced = enforceSourceManagedProviderSecrets({
      providers,
      sourceConfigForSecrets: { models: { providers: sourceProviders } },
    });
    expect((enforced as Record<string, unknown>).openai).toBeNull();
    expect(enforced?.moonshot?.apiKey).toBe("MOONSHOT_API_KEY"); // pragma: allowlist secret
  });

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

  const duplicateCatalogCost = {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 2,
    tieredPricing: [
      { input: 20, output: 100, cacheRead: 2, cacheWrite: 4, range: [0] as [number] },
    ],
  };
  const duplicateFlatCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const duplicateAuthoredTieredCost = {
    ...duplicateFlatCost,
    tieredPricing: [{ ...duplicateFlatCost, range: [0] as [number] }],
  };

  it.each([
    {
      name: "omitted cost inherits the lower-priority schedule",
      firstCost: undefined,
      expectedCost: duplicateCatalogCost,
    },
    {
      name: "empty cost inherits the lower-priority schedule",
      firstCost: {},
      expectedCost: duplicateCatalogCost,
    },
    {
      name: "partial flat cost inherits missing rates without tiers",
      firstCost: { input: 3 },
      expectedCost: { input: 3, output: 50, cacheRead: 1, cacheWrite: 2 },
    },
    {
      name: "flat cost excludes lower-priority tiers",
      firstCost: duplicateFlatCost,
      expectedCost: duplicateFlatCost,
    },
    {
      name: "zero cost excludes lower-priority tiers",
      firstCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      expectedCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    {
      name: "authored tiers replace lower-priority tiers",
      firstCost: duplicateAuthoredTieredCost,
      expectedCost: duplicateAuthoredTieredCost,
    },
    {
      name: "empty tiers retain flat pricing",
      firstCost: { ...duplicateFlatCost, tieredPricing: [] },
      expectedCost: { ...duplicateFlatCost, tieredPricing: [] },
    },
  ])("merges duplicate pricing: $name", ({ firstCost, expectedCost }) => {
    const providers = {
      custom: {
        baseUrl: "https://models.example/v1",
        models: [
          { ...createModel({ id: "duplicate" }), cost: firstCost },
          createModel({ id: "duplicate", cost: duplicateCatalogCost }),
        ],
      },
      // SAFETY: config schema accepts partial costs before catalog publication completes them.
    } as unknown as NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;

    const models = normalizeProviderCatalogModelsForConfig(providers)?.custom?.models;
    expect(models).toHaveLength(1);
    expect(models?.[0]?.cost).toEqual(expectedCost);
  });

  it("canonicalizes LM Studio baseUrl after merge-style explicit overwrite", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        lmstudio: {
          baseUrl: "http://localhost:1234/api/v1/",
          api: "openai-completions",
          apiKey: "LM_API_TOKEN",
          models: [],
        },
      };

      const normalized = normalizeProviders({ providers, agentDir });
      expect(normalized?.lmstudio?.baseUrl).toBe("http://localhost:1234/v1");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
