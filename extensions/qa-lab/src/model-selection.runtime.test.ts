// Qa Lab tests cover model selection plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveEnvApiKey, loadAuthProfileStoreForRuntime, listProfilesForProvider } = vi.hoisted(
  () => ({
    resolveEnvApiKey: vi.fn(),
    loadAuthProfileStoreForRuntime: vi.fn(),
    listProfilesForProvider: vi.fn(),
  }),
);

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveEnvApiKey,
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  loadAuthProfileStoreForRuntime,
  listProfilesForProvider,
}));

import {
  defaultQaRuntimeModelForMode,
  resolveQaRuntimeModelPair,
} from "./model-selection.runtime.js";

describe("qa model selection runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEnvApiKey.mockReturnValue(undefined);
    loadAuthProfileStoreForRuntime.mockReturnValue({ profiles: {} });
    listProfilesForProvider.mockImplementation((store: { profiles?: Record<string, unknown> }) =>
      Object.keys(store.profiles ?? {}),
    );
  });

  it("selects live defaults without reading credentials", () => {
    expect(defaultQaRuntimeModelForMode("live-frontier")).toBe("openai/gpt-5.6-luna");
    expect(resolveQaRuntimeModelPair({ providerMode: "live-frontier" })).toEqual({
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-terra",
    });
    expect(resolveEnvApiKey).not.toHaveBeenCalled();
    expect(loadAuthProfileStoreForRuntime).not.toHaveBeenCalled();
  });

  it("preserves an explicit preferred live model", () => {
    expect(
      defaultQaRuntimeModelForMode("live-frontier", {
        preferredLiveModel: "anthropic/claude-sonnet-4-6",
      }),
    ).toBe("anthropic/claude-sonnet-4-6");
  });

  it.each(["openai/gpt-5.6", "openai/gpt-5.6-sol", "openai/gpt-5.6-terra"])(
    "derives Luna after explicit primary %s",
    (primaryModel) => {
      expect(resolveQaRuntimeModelPair({ providerMode: "live-frontier", primaryModel })).toEqual({
        primaryModel,
        alternateModel: "openai/gpt-5.6-luna",
      });
    },
  );

  it("derives Terra after an explicit Luna primary", () => {
    expect(
      resolveQaRuntimeModelPair({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }),
    ).toEqual({
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-terra",
    });
  });

  it("falls back through the provider default for an unmapped primary", () => {
    expect(
      resolveQaRuntimeModelPair({
        providerMode: "live-frontier",
        primaryModel: "anthropic/claude-sonnet-4-6",
      }),
    ).toEqual({
      primaryModel: "anthropic/claude-sonnet-4-6",
      alternateModel: "openai/gpt-5.6-luna",
    });
  });

  it("preserves an explicit alternate model", () => {
    expect(
      resolveQaRuntimeModelPair({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6",
        alternateModel: "openai/gpt-5.6-terra",
      }),
    ).toEqual({
      primaryModel: "openai/gpt-5.6",
      alternateModel: "openai/gpt-5.6-terra",
    });
  });

  it.each([
    ["openai/gpt-5.4", "openai/gpt-5.4"],
    ["openai/gpt-5.6", "openai/gpt-5.6-sol"],
  ])("preserves the explicit model pair %s / %s", (primaryModel, alternateModel) => {
    expect(
      resolveQaRuntimeModelPair({
        providerMode: "live-frontier",
        primaryModel,
        alternateModel,
      }),
    ).toEqual({ primaryModel, alternateModel });
  });

  it("leaves mock defaults unchanged", () => {
    expect(defaultQaRuntimeModelForMode("mock-openai")).toBe("mock-openai/gpt-5.6-luna");
    expect(defaultQaRuntimeModelForMode("mock-openai", { alternate: true })).toBe(
      "mock-openai/gpt-5.6-luna-alt",
    );
    expect(defaultQaRuntimeModelForMode("aimock")).toBe("aimock/gpt-5.6-luna");
    expect(defaultQaRuntimeModelForMode("aimock", { alternate: true })).toBe(
      "aimock/gpt-5.6-luna-alt",
    );
  });
});
