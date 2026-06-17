import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";

const mocks = vi.hoisted(() => ({
  ensureCustomApiRegistered: vi.fn(),
  createTransportAwareStreamFnForModel: vi.fn(),
  resolveProviderStreamFn: vi.fn(),
  wrapProviderStreamFn: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderStreamFn: mocks.resolveProviderStreamFn,
  wrapProviderStreamFn: mocks.wrapProviderStreamFn,
}));
vi.mock("./custom-api-registry.js", () => ({
  ensureCustomApiRegistered: mocks.ensureCustomApiRegistered,
}));
vi.mock("./provider-transport-stream.js", () => ({
  createTransportAwareStreamFnForModel: mocks.createTransportAwareStreamFnForModel,
}));

import { registerProviderStreamForModel } from "./provider-stream.js";

const MODEL = {
  id: "anthropic/default",
  name: "Anthropic default",
  api: "anthropic-messages",
  provider: "clawrouter",
  baseUrl: "https://clawrouter.example/v1/native/anthropic",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_768,
} satisfies Model<"anthropic-messages">;

describe("registerProviderStreamForModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies an opted-in provider wrapper after selecting the managed transport", () => {
    const baseStream = vi.fn();
    const wrappedStream = vi.fn();
    mocks.createTransportAwareStreamFnForModel.mockReturnValue(baseStream);
    mocks.wrapProviderStreamFn.mockReturnValue(wrappedStream);

    expect(
      registerProviderStreamForModel({
        model: MODEL,
        cfg: { models: {} },
        agentDir: "/agent",
        workspaceDir: "/workspace",
        applyProviderWrapper: true,
      }),
    ).toBe(wrappedStream);
    expect(mocks.wrapProviderStreamFn).toHaveBeenCalledWith({
      provider: "clawrouter",
      config: { models: {} },
      workspaceDir: "/workspace",
      env: undefined,
      context: {
        config: { models: {} },
        agentDir: "/agent",
        workspaceDir: "/workspace",
        provider: "clawrouter",
        modelId: "anthropic/default",
        model: MODEL,
        streamFn: baseStream,
      },
    });
    expect(mocks.ensureCustomApiRegistered).toHaveBeenCalledWith(
      "anthropic-messages",
      wrappedStream,
    );
  });

  it("leaves existing callers unwrapped by default", () => {
    const baseStream = vi.fn();
    mocks.resolveProviderStreamFn.mockReturnValue(baseStream);

    expect(registerProviderStreamForModel({ model: MODEL })).toBe(baseStream);
    expect(mocks.wrapProviderStreamFn).not.toHaveBeenCalled();
  });
});
