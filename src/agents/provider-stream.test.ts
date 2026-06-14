import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";

const mocks = vi.hoisted(() => ({
  resolveProviderStreamFn: vi.fn(),
  ensureCustomApiRegistered: vi.fn(),
  createTransportAwareStreamFnForModel: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderStreamFn: mocks.resolveProviderStreamFn,
}));

vi.mock("./custom-api-registry.js", () => ({
  ensureCustomApiRegistered: mocks.ensureCustomApiRegistered,
}));

vi.mock("./provider-transport-stream.js", () => ({
  createTransportAwareStreamFnForModel: mocks.createTransportAwareStreamFnForModel,
}));

const { registerProviderStreamForModel } = await import("./provider-stream.js");

function buildModel(): Model {
  return {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "claude-cli",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

describe("registerProviderStreamForModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes request-scoped session identity to provider createStreamFn context", () => {
    const streamFn = vi.fn();
    const model = buildModel();
    mocks.resolveProviderStreamFn.mockReturnValue(streamFn);

    const result = registerProviderStreamForModel({
      model,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      sessionId: "session-123",
      sessionKey: "agent:main:telegram:direct:user-1",
    });

    expect(result).toBe(streamFn);
    expect(mocks.resolveProviderStreamFn).toHaveBeenCalledOnce();
    expect(mocks.resolveProviderStreamFn.mock.calls[0]?.[0].context).toMatchObject({
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      provider: "claude-cli",
      modelId: "claude-sonnet-4.6",
      model,
      sessionId: "session-123",
      sessionKey: "agent:main:telegram:direct:user-1",
    });
    expect(mocks.ensureCustomApiRegistered).toHaveBeenCalledWith("anthropic-messages", streamFn);
  });
});
