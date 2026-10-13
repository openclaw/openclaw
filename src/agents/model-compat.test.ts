import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginMetadataSnapshotAsync } from "../plugins/plugin-metadata-snapshot.js";
import * as providerRuntime from "../plugins/provider-hook-runtime.js";
import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import { isModernModelRef } from "./test-helpers/live-model-dynamic-candidates.js";

let metadataSnapshot: Awaited<ReturnType<typeof resolvePluginMetadataSnapshotAsync>>;

const baseModel = (): Model =>
  ({
    id: "glm-4.7",
    name: "GLM-4.7",
    api: "openai-completions",
    provider: "zai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  }) as Model;

function supportsDeveloperRole(model: Model): boolean | undefined {
  return (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole;
}

function supportsUsageInStreaming(model: Model): boolean | undefined {
  return (model.compat as { supportsUsageInStreaming?: boolean } | undefined)
    ?.supportsUsageInStreaming;
}

function supportsStrictMode(model: Model): boolean | undefined {
  return (model.compat as { supportsStrictMode?: boolean } | undefined)?.supportsStrictMode;
}

function expectSupportsDeveloperRoleForcedOff(overrides?: Partial<Model>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model, metadataSnapshot.owners);
  expect(normalized).not.toBe(model);
  expect(model.compat).toBeUndefined();
  expect(supportsDeveloperRole(normalized)).toBe(false);
  expect(supportsUsageInStreaming(normalized)).toBe(false);
  expect(supportsStrictMode(normalized)).toBe(false);
}

beforeEach(async () => {
  // Endpoint capabilities come from manifests. Keep source tests independent
  // from partial dist output left by an earlier build in the same checkout.
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
  metadataSnapshot = await resolvePluginMetadataSnapshotAsync({});
  vi.spyOn(providerRuntime, "resolveProviderRuntimePluginAsync").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("isModernModelRef", () => {
  it("matches plugin-advertised modern models only for exact provider ids", async () => {
    vi.mocked(providerRuntime.resolveProviderRuntimePluginAsync).mockResolvedValue({
      id: "z.ai",
      label: "Modern model fixture",
      auth: [],
      isModernModelRef: ({ provider, modelId }) => provider === "z.ai" && modelId === "glm-5",
    });

    expect(await isModernModelRef({ provider: "z.ai", id: "glm-5" })).toBe(true);
    expect(await isModernModelRef({ provider: "z-ai", id: "glm-5" })).toBe(false);
  });
});

describe("normalizeModelCompat — Anthropic baseUrl", () => {
  const anthropicBase = (): Model =>
    ({
      id: "claude-opus-4-6",
      name: "claude-opus-4-6",
      api: "anthropic-messages",
      provider: "anthropic",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    }) as Model;

  it("strips trailing /v1/ (with slash) from anthropic-messages baseUrl", () => {
    const model = { ...anthropicBase(), baseUrl: "https://api.anthropic.com/v1/" };
    const normalized = normalizeModelCompat(model, metadataSnapshot.owners);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });
});

describe("normalizeModelCompat", () => {
  it.each([
    [
      "Azure OpenAI chat completions",
      { provider: "azure-openai", baseUrl: "https://my-deployment.openai.azure.com/openai" },
    ],
    [
      "malformed baseUrl values",
      { provider: "custom-cpa", baseUrl: "://api.openai.com malformed" },
    ],
  ] satisfies Array<[string, Partial<Model> | undefined]>)(
    "forces supportsDeveloperRole off for %s",
    (_name, overrides) => {
      expectSupportsDeveloperRoleForcedOff(overrides);
    },
  );

  it("leaves native api.openai.com model untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model, metadataSnapshot.owners);
    expect(normalized.compat).toBeUndefined();
  });

  it("respects explicit supportsDeveloperRole true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsDeveloperRole: true },
    };
    const normalized = normalizeModelCompat(model, metadataSnapshot.owners);
    expect(supportsDeveloperRole(normalized)).toBe(true);
  });

  it("respects explicit supportsUsageInStreaming true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsUsageInStreaming: true },
    };
    const normalized = normalizeModelCompat(model, metadataSnapshot.owners);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
  });

  it("respects explicit supportsStrictMode true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsStrictMode: true },
    };
    const normalized = normalizeModelCompat(model, metadataSnapshot.owners);
    expect(supportsStrictMode(normalized)).toBe(true);
  });

  it("leaves fully explicit non-native compat untouched", () => {
    const model = baseModel();
    model.baseUrl = "https://proxy.example.com/v1";
    model.compat = {
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
    };
    const normalized = normalizeModelCompat(model, metadataSnapshot.owners);
    expect(normalized).toBe(model);
  });

  it("preserves explicit usage compat when developer role is explicitly enabled", () => {
    const model = baseModel();
    model.baseUrl = "https://proxy.example.com/v1";
    model.compat = {
      supportsDeveloperRole: true,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
    };
    const normalized = normalizeModelCompat(model, metadataSnapshot.owners);
    expect(supportsDeveloperRole(normalized)).toBe(true);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
    expect(supportsStrictMode(normalized)).toBe(true);
  });
});
