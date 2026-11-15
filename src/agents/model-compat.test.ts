import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveProviderRuntimePlugin = vi.hoisted(() => vi.fn());

// mock-isolation: Model identity tests control provider claims without activating a runtime registry.
vi.mock("../plugins/provider-hook-runtime.js", () => ({ resolveProviderRuntimePlugin }));

import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import { isModernModelRef } from "./test-helpers/live-model-dynamic-candidates.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const baseModel = (overrides: Partial<Model> = {}): Model =>
  makeProviderModelFixture({
    id: "glm-4.7",
    api: "openai-completions",
    provider: "zai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    ...overrides,
  });

beforeEach(() => {
  // Ignore stale dist manifests left by earlier builds.
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
  resolveProviderRuntimePlugin.mockReset().mockReturnValue(undefined);
});

afterEach(vi.unstubAllEnvs);

describe("isModernModelRef", () => {
  it("matches plugin-advertised modern models only for exact provider ids", () => {
    resolveProviderRuntimePlugin.mockImplementation(({ provider }) =>
      provider === "z.ai"
        ? { isModernModelRef: ({ modelId }: { modelId: string }) => modelId === "glm-5" }
        : undefined,
    );

    expect(isModernModelRef({ provider: "z.ai", id: "glm-5" })).toBe(true);
    expect(isModernModelRef({ provider: "z-ai", id: "glm-5" })).toBe(false);
  });

  it("retains the scoped owner, hook receiver, context, and exact true result", () => {
    const scope = { provider: "demo", config: {}, workspaceDir: "/tmp/model-policy", env: {} };
    const context = { provider: "demo", modelId: "model" };
    const hook = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce("true");
    const plugin = { isModernModelRef: hook };
    resolveProviderRuntimePlugin.mockReturnValue(plugin);
    const ref = { id: "model", ...scope };
    expect(isModernModelRef(ref)).toBe(true);
    expect(resolveProviderRuntimePlugin).toHaveBeenCalledExactlyOnceWith({ ...scope, context });
    expect(isModernModelRef(ref)).toBe(false);
    resolveProviderRuntimePlugin.mockReturnValue({});
    expect(isModernModelRef(ref)).toBe(false);
    expect(hook.mock.contexts).toEqual([plugin, plugin]);
    expect(hook.mock.calls).toEqual([[context], [context]]);
    resolveProviderRuntimePlugin.mockClear();
    expect(isModernModelRef({ provider: "demo", id: "" })).toBe(false);
    expect(resolveProviderRuntimePlugin).not.toHaveBeenCalled();
  });
});

describe("normalizeModelCompat", () => {
  it("strips trailing /v1/ (with slash) from anthropic-messages baseUrl", () => {
    const model = baseModel({
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1/",
    });
    expect(normalizeModelCompat(model).baseUrl).toBe("https://api.anthropic.com");
  });
  it.each([
    ["azure-openai", "https://my-deployment.openai.azure.com/openai"],
    ["custom-cpa", "://api.openai.com malformed"],
  ])("defaults non-native capabilities off for %s (%s)", (provider, baseUrl) => {
    const model = baseModel({ provider, baseUrl });
    const normalized = normalizeModelCompat(model);
    expect(normalized).not.toBe(model);
    expect(model.compat).toBeUndefined();
    expect(normalized.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
    });
  });

  it("leaves native api.openai.com model untouched", () => {
    const model = baseModel({ provider: "openai", baseUrl: "https://api.openai.com/v1" });
    expect(normalizeModelCompat(model).compat).toBeUndefined();
  });

  it.each(["supportsDeveloperRole", "supportsUsageInStreaming", "supportsStrictMode"] as const)(
    "respects explicit %s true on non-native endpoints",
    (capability) => {
      const model = baseModel({
        provider: "custom-cpa",
        baseUrl: "https://proxy.example.com/v1",
        compat: { [capability]: true },
      });
      expect(normalizeModelCompat(model).compat).toMatchObject({ [capability]: true });
    },
  );

  it.each([false, true])("preserves fully explicit compat with developer role %s", (enabled) => {
    const compat = {
      supportsDeveloperRole: enabled,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
    };
    const model = baseModel({ baseUrl: "https://proxy.example.com/v1", compat: { ...compat } });
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat).toMatchObject(compat);
    expect(normalized).toBe(model);
  });
});
