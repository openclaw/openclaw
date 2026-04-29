import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveManifestBuiltInModelSuppression: vi.fn(),
  buildManifestBuiltInModelSuppressionResolver: vi.fn(),
}));

vi.mock("../plugins/manifest-model-suppression.js", () => ({
  resolveManifestBuiltInModelSuppression: mocks.resolveManifestBuiltInModelSuppression,
  buildManifestBuiltInModelSuppressionResolver: mocks.buildManifestBuiltInModelSuppressionResolver,
}));

import { buildShouldSuppressBuiltInModel, shouldSuppressBuiltInModel } from "./model-suppression.js";

describe("model suppression", () => {
  beforeEach(() => {
    mocks.resolveManifestBuiltInModelSuppression.mockReset();
  });

  it("uses manifest suppression", () => {
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

    expect(mocks.resolveManifestBuiltInModelSuppression).toHaveBeenCalledOnce();
  });

  it("does not run deprecated runtime suppression hooks", () => {
    expect(
      shouldSuppressBuiltInModel({
        provider: "openai",
        id: "gpt-5.3-codex-spark",
        config: {},
      }),
    ).toBe(false);

    expect(mocks.resolveManifestBuiltInModelSuppression).toHaveBeenCalledOnce();
  });

  describe("buildShouldSuppressBuiltInModel", () => {
    beforeEach(() => {
      mocks.buildManifestBuiltInModelSuppressionResolver.mockReset();
    });

    it("normalizes provider aliases before checking suppressions", () => {
      const resolverMock = vi.fn().mockReturnValue({ suppress: true });
      mocks.buildManifestBuiltInModelSuppressionResolver.mockReturnValueOnce(resolverMock);

      const predicate = buildShouldSuppressBuiltInModel({ config: {} });
      
      expect(predicate({ provider: "bedrock", id: "anthropic.claude-3-5-sonnet" })).toBe(true);

      expect(resolverMock).toHaveBeenCalledOnce();
      expect(resolverMock).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "amazon-bedrock", id: "anthropic.claude-3-5-sonnet" })
      );
    });
  });
});
