import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { formatCliCommand } from "openclaw/plugin-sdk/setup-tools";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

vi.mock("openclaw/plugin-sdk/provider-setup", () => ({
  promptAndConfigureOpenAICompatibleSelfHostedProviderAuth: vi.fn(),
  configureOpenAICompatibleSelfHostedProviderNonInteractive: vi.fn(),
  discoverOpenAICompatibleSelfHostedProvider: vi.fn(),
}));

function registerProvider() {
  const registerProviderMock = vi.fn();

  plugin.register(
    createTestPluginApi({
      id: "vllm",
      name: "vLLM",
      source: "test",
      config: {},
      runtime: {} as never,
      registerProvider: registerProviderMock,
    }),
  );

  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return registerProviderMock.mock.calls[0]?.[0];
}

describe("vllm provider doctor hints", () => {
  it("productizes configure guidance in unknown-model hints", () => {
    const previous = process.env.CLAWORKS_PRODUCT;
    process.env.CLAWORKS_PRODUCT = "1";
    try {
      const provider = registerProvider();
      const hint = provider.buildUnknownModelHint?.({} as never);
      expect(hint).toContain(formatCliCommand("openclaw configure"));
      expect(hint).toContain("claworks configure");
      expect(hint).not.toContain("openclaw configure");
    } finally {
      if (previous === undefined) {
        delete process.env.CLAWORKS_PRODUCT;
      } else {
        process.env.CLAWORKS_PRODUCT = previous;
      }
    }
  });
});
