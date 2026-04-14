import { beforeEach, describe, expect, it, vi } from "vitest";

const loadQaLabRuntimeModule = vi.hoisted(() => vi.fn());
const defaultQaRuntimeModelForMode = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/qa-lab-runtime", () => ({
  loadQaLabRuntimeModule,
}));

describe("matrix qa model selection", () => {
  beforeEach(() => {
    defaultQaRuntimeModelForMode.mockReset().mockImplementation((mode, options) =>
      options?.alternate ? `${mode}:alt` : `${mode}:primary`,
    );
    loadQaLabRuntimeModule.mockReset().mockReturnValue({
      defaultQaRuntimeModelForMode,
    });
  });

  it("delegates default model selection through qa-lab runtime defaults", async () => {
    const { resolveMatrixQaModels } = await import("./model-selection.js");

    expect(resolveMatrixQaModels({ providerMode: "live-openai" })).toEqual({
      providerMode: "live-frontier",
      primaryModel: "live-frontier:primary",
      alternateModel: "live-frontier:alt",
    });
    expect(defaultQaRuntimeModelForMode).toHaveBeenNthCalledWith(1, "live-frontier");
    expect(defaultQaRuntimeModelForMode).toHaveBeenNthCalledWith(2, "live-frontier", {
      alternate: true,
    });
  });

  it("preserves explicit model overrides", async () => {
    const { resolveMatrixQaModels } = await import("./model-selection.js");

    expect(
      resolveMatrixQaModels({
        providerMode: "mock-openai",
        primaryModel: "custom-primary",
        alternateModel: "custom-alt",
      }),
    ).toEqual({
      providerMode: "mock-openai",
      primaryModel: "custom-primary",
      alternateModel: "custom-alt",
    });
    expect(loadQaLabRuntimeModule).not.toHaveBeenCalled();
    expect(defaultQaRuntimeModelForMode).not.toHaveBeenCalled();
  });
});
