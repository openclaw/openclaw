import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import plugin from "./index.js";
import {
  LITERTLM_MODEL_E2B,
  LITERTLM_MODEL_E4B,
  getDefaultLiteRtLmModelId,
} from "./src/provider-models.js";

function registerProvider() {
  const registerProviderMock = vi.fn();

  plugin.register(
    createTestPluginApi({
      id: "litertlm",
      name: "LiteRT-LM",
      source: "test",
      config: {},
      runtime: {} as never,
      registerProvider: registerProviderMock,
    }),
  );

  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return registerProviderMock.mock.calls[0]?.[0];
}

describe("litertlm plugin skeleton", () => {
  it("registers the experimental local provider", () => {
    const provider = registerProvider();

    expect(provider.id).toBe("litertlm-local");
    expect(provider.label).toBe("LiteRT-LM Local");
    expect(typeof provider.createStreamFn).toBe("function");
    expect(typeof provider.resolveSyntheticAuth).toBe("function");
  });

  it("keeps discovery disabled in the current draft skeleton", async () => {
    const provider = registerProvider();
    const discovered = await provider.discovery.run({} as never);

    expect(discovered).toBeNull();
    expect(LITERTLM_MODEL_E2B).toContain("litertlm/");
    expect(LITERTLM_MODEL_E4B).toContain("litertlm/");
  });

  it("uses E2B as the default experimental model id", () => {
    expect(getDefaultLiteRtLmModelId()).toBe(LITERTLM_MODEL_E2B);
  });

  it("exposes synthetic auth without requiring an external API key", () => {
    const provider = registerProvider();
    const auth = provider.resolveSyntheticAuth?.({} as never);

    expect(auth?.apiKey).toBe("litertlm-local");
    expect(auth?.mode).toBe("api-key");
  });
});
