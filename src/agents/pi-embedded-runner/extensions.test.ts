import type { Api, Model } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getCompactionSafeguardRuntime } from "../pi-extensions/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-extensions/compaction-safeguard.js";
import { buildEmbeddedExtensionFactories, resolveCompactionModelOverride } from "./extensions.js";

vi.mock("./model.js", () => ({
  resolveModel: vi.fn(),
}));

// eslint-disable-next-line import/no-duplicates -- needed after mock
const modelMod = await import("./model.js");
const resolveModelMock = vi.mocked(modelMod.resolveModel);

function buildSafeguardFactories(cfg: OpenClawConfig) {
  const sessionManager = {} as SessionManager;
  const model = {
    id: "claude-sonnet-4-20250514",
    contextWindow: 200_000,
  } as Model<Api>;

  const factories = buildEmbeddedExtensionFactories({
    cfg,
    sessionManager,
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    model,
  });

  return { factories, sessionManager };
}

function expectSafeguardRuntime(
  cfg: OpenClawConfig,
  expectedRuntime: { qualityGuardEnabled: boolean; qualityGuardMaxRetries?: number },
) {
  const { factories, sessionManager } = buildSafeguardFactories(cfg);

  expect(factories).toContain(compactionSafeguardExtension);
  expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject(expectedRuntime);
}

describe("resolveCompactionModelOverride", () => {
  const primaryModel = { id: "smart", provider: "arouter", contextWindow: 256_000 } as Model<Api>;
  const overrideModel = { id: "fast", provider: "arouter", contextWindow: 256_000 } as Model<Api>;

  afterEach(() => {
    resolveModelMock.mockReset();
  });

  it("returns fallback when compactionModelStr is undefined", () => {
    expect(resolveCompactionModelOverride(undefined, undefined, primaryModel)).toBe(primaryModel);
    expect(resolveModelMock).not.toHaveBeenCalled();
  });

  it("returns fallback when compactionModelStr has no slash", () => {
    expect(resolveCompactionModelOverride("fast", undefined, primaryModel)).toBe(primaryModel);
    expect(resolveModelMock).not.toHaveBeenCalled();
  });

  it("returns fallback when compactionModelStr has a leading slash", () => {
    expect(resolveCompactionModelOverride("/fast", undefined, primaryModel)).toBe(primaryModel);
    expect(resolveModelMock).not.toHaveBeenCalled();
  });

  it("returns fallback when compactionModelStr has a trailing slash", () => {
    expect(resolveCompactionModelOverride("arouter/", undefined, primaryModel)).toBe(primaryModel);
    expect(resolveModelMock).not.toHaveBeenCalled();
  });

  it("returns the resolved override model", () => {
    resolveModelMock.mockReturnValueOnce({
      model: overrideModel,
      authStorage: {} as never,
      modelRegistry: {} as never,
    });
    expect(resolveCompactionModelOverride("arouter/fast", undefined, primaryModel)).toBe(
      overrideModel,
    );
    expect(resolveModelMock).toHaveBeenCalledWith("arouter", "fast", undefined, undefined);
  });

  it("falls back to the primary model when the override cannot be resolved", () => {
    resolveModelMock.mockReturnValueOnce({
      model: undefined,
      error: "Unknown model: arouter/fast",
      authStorage: {} as never,
      modelRegistry: {} as never,
    });
    expect(resolveCompactionModelOverride("arouter/fast", undefined, primaryModel)).toBe(
      primaryModel,
    );
  });
});

describe("buildEmbeddedExtensionFactories", () => {
  it("does not opt safeguard mode into quality-guard retries", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: false,
    });
  });

  it("wires explicit safeguard quality-guard runtime flags", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            qualityGuard: {
              enabled: true,
              maxRetries: 2,
            },
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 2,
    });
  });

  it("wires compaction model override into safeguard runtime", () => {
    const primaryModel = {
      id: "smart",
      provider: "arouter",
      contextWindow: 256_000,
    } as Model<Api>;
    const overrideModel = {
      id: "fast",
      provider: "arouter",
      contextWindow: 256_000,
    } as Model<Api>;
    resolveModelMock.mockReturnValueOnce({
      model: overrideModel,
      authStorage: {} as never,
      modelRegistry: {} as never,
    });

    const sessionManager = {} as SessionManager;
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            model: "arouter/fast",
          },
        },
      },
    } as OpenClawConfig;

    buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "arouter",
      modelId: "smart",
      model: primaryModel,
    });

    expect(getCompactionSafeguardRuntime(sessionManager)?.model).toBe(overrideModel);
  });

  it("falls back to primary model in safeguard runtime when override cannot be resolved", () => {
    const primaryModel = {
      id: "smart",
      provider: "arouter",
      contextWindow: 256_000,
    } as Model<Api>;
    resolveModelMock.mockReturnValueOnce({
      model: undefined,
      error: "Unknown model",
      authStorage: {} as never,
      modelRegistry: {} as never,
    });

    const sessionManager = {} as SessionManager;
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            model: "arouter/nonexistent",
          },
        },
      },
    } as OpenClawConfig;

    buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "arouter",
      modelId: "smart",
      model: primaryModel,
    });

    expect(getCompactionSafeguardRuntime(sessionManager)?.model).toBe(primaryModel);
  });
});
