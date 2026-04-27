import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveManifestBuiltInModelSuppression: vi.fn(),
  resolveProviderBuiltInModelSuppression: vi.fn(),
}));

vi.mock("../plugins/manifest-model-suppression.js", () => ({
  resolveManifestBuiltInModelSuppression: mocks.resolveManifestBuiltInModelSuppression,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderBuiltInModelSuppression: mocks.resolveProviderBuiltInModelSuppression,
}));

import { shouldSuppressBuiltInModel } from "./model-suppression.js";

describe("model suppression", () => {
  beforeEach(() => {
    mocks.resolveManifestBuiltInModelSuppression.mockReset();
    mocks.resolveProviderBuiltInModelSuppression.mockReset();
  });

  it("uses manifest suppression before runtime hooks", () => {
    mocks.resolveManifestBuiltInModelSuppression.mockReturnValueOnce({
      suppress: true,
      errorMessage: "manifest suppression",
    });

    expect(
      shouldSuppressBuiltInModel({
        provider: "openai",
        id: "gpt-5.3-codex-spark",
        config: {},
      }),
    ).toBe(true);

    expect(mocks.resolveProviderBuiltInModelSuppression).not.toHaveBeenCalled();
  });

  it("falls back to runtime hooks when no manifest suppression matches", () => {
    mocks.resolveProviderBuiltInModelSuppression.mockReturnValueOnce({
      suppress: true,
      errorMessage: "runtime suppression",
    });

    expect(
      shouldSuppressBuiltInModel({
        provider: "openai",
        id: "gpt-5.3-codex-spark",
        config: {},
      }),
    ).toBe(true);

    expect(mocks.resolveProviderBuiltInModelSuppression).toHaveBeenCalledOnce();
  });
});
