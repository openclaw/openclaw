import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it, vi } from "vitest";
import { createLegacyProviderConfig } from "../../test/helpers/plugins/onboard-config.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";
import { applyXiaomiConfig, applyXiaomiProviderConfig } from "./onboard.js";

describe("xiaomi onboard", () => {
  it("adds Xiaomi provider with correct settings", () => {
    const cfg = applyXiaomiConfig({});
    expect(cfg.models?.providers?.xiaomi).toMatchObject({
      baseUrl: "https://api.xiaomimimo.com/v1",
      api: "openai-completions",
    });
    expect(cfg.models?.providers?.xiaomi?.models.map((m) => m.id)).toEqual([
      "mimo-v2-flash",
      "mimo-v2-pro",
      "mimo-v2-omni",
    ]);
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe("xiaomi/mimo-v2-flash");
  });

  it("merges Xiaomi models and keeps existing provider overrides", () => {
    const cfg = applyXiaomiProviderConfig(
      createLegacyProviderConfig({
        providerId: "xiaomi",
        api: "openai-completions",
        modelId: "custom-model",
        modelName: "Custom",
      }),
    );

    expect(cfg.models?.providers?.xiaomi?.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(cfg.models?.providers?.xiaomi?.api).toBe("openai-completions");
    expect(cfg.models?.providers?.xiaomi?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.xiaomi?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "mimo-v2-flash",
      "mimo-v2-pro",
      "mimo-v2-omni",
    ]);
  });
});

describe("xiaomi wrapStreamFn", () => {
  function buildBaseStreamFn() {
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn((_model: unknown, _context: unknown, options: unknown) => {
      const opts = options as { onPayload?: (p: unknown, m: unknown) => unknown } | undefined;
      const payload: Record<string, unknown> = { messages: [], stream: true };
      opts?.onPayload?.(payload, _model);
      capturedPayload = payload;
      return {} as never;
    });
    return { baseStreamFn, getPayload: () => capturedPayload };
  }

  function getWrappedProvider() {
    return registerSingleProviderPlugin({ register: (api) => plugin.register(api) });
  }

  it("adds enable_thinking: false for reasoning models (mimo-v2-pro)", () => {
    const provider = getWrappedProvider();
    const { baseStreamFn, getPayload } = buildBaseStreamFn();

    const wrapped = provider.wrapStreamFn?.({
      provider: "xiaomi",
      modelId: "mimo-v2-pro",
      model: {
        api: "openai-completions",
        provider: "xiaomi",
        id: "mimo-v2-pro",
        reasoning: true,
        baseUrl: "https://api.xiaomimimo.com/v1",
      } as never,
      streamFn: baseStreamFn,
    } as never);

    expect(typeof wrapped).toBe("function");
    void wrapped?.({} as never, {} as never, {});
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(getPayload()?.enable_thinking).toBe(false);
  });

  it("adds enable_thinking: false for reasoning models (mimo-v2-omni)", () => {
    const provider = getWrappedProvider();
    const { baseStreamFn, getPayload } = buildBaseStreamFn();

    const wrapped = provider.wrapStreamFn?.({
      provider: "xiaomi",
      modelId: "mimo-v2-omni",
      model: {
        api: "openai-completions",
        provider: "xiaomi",
        id: "mimo-v2-omni",
        reasoning: true,
        baseUrl: "https://api.xiaomimimo.com/v1",
      } as never,
      streamFn: baseStreamFn,
    } as never);

    expect(typeof wrapped).toBe("function");
    void wrapped?.({} as never, {} as never, {});
    expect(getPayload()?.enable_thinking).toBe(false);
  });

  it("does not add enable_thinking for non-reasoning models (mimo-v2-flash)", () => {
    const provider = getWrappedProvider();
    const { baseStreamFn, getPayload } = buildBaseStreamFn();

    const wrapped = provider.wrapStreamFn?.({
      provider: "xiaomi",
      modelId: "mimo-v2-flash",
      model: {
        api: "openai-completions",
        provider: "xiaomi",
        id: "mimo-v2-flash",
        reasoning: false,
        baseUrl: "https://api.xiaomimimo.com/v1",
      } as never,
      streamFn: baseStreamFn,
    } as never);

    // Non-reasoning models return null (no wrapping needed)
    expect(wrapped).toBeNull();
    expect(getPayload()).toBeUndefined();
  });
});
