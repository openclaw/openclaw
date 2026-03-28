import { beforeEach, describe, expect, it, vi } from "vitest";

const normalizeProviderModelIdWithPluginMock = vi.fn();

vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderModelIdWithPlugin: (params: unknown) =>
    normalizeProviderModelIdWithPluginMock(params),
}));

describe("model-selection plugin runtime normalization", () => {
  beforeEach(() => {
    vi.resetModules();
    normalizeProviderModelIdWithPluginMock.mockReset();
  });

  it("delegates provider-owned model id normalization to plugin runtime hooks", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(({ provider, context }) => {
      if (
        provider === "xai" &&
        (context as { modelId?: string }).modelId === "grok-4.20-experimental-beta-0304-reasoning"
      ) {
        return "grok-4.20-beta-latest-reasoning";
      }
      return undefined;
    });

    const { parseModelRef } = await import("./model-selection.js");

    expect(parseModelRef("grok-4.20-experimental-beta-0304-reasoning", "xai")).toEqual({
      provider: "xai",
      model: "grok-4.20-beta-latest-reasoning",
    });
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledWith({
      provider: "xai",
      context: {
        provider: "xai",
        modelId: "grok-4.20-experimental-beta-0304-reasoning",
      },
    });
  });
});
