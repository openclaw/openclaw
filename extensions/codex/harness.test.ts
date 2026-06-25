// Codex tests cover harness plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  closeAndWait: vi.fn(),
  createClient: vi.fn(),
  resolveRuntime: vi.fn(),
}));

vi.mock("./src/app-server/config.js", () => ({
  resolveCodexAppServerRuntimeOptions: mocks.resolveRuntime,
}));

vi.mock("./src/app-server/shared-client.js", () => ({
  clearSharedCodexAppServerClientAndWait: vi.fn(),
  createIsolatedCodexAppServerClient: mocks.createClient,
}));

describe("Codex agent harness supports()", () => {
  const harness = createCodexAppServerAgentHarness();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRuntime.mockReturnValue({
      start: {},
      requestTimeoutMs: 2_500,
    });
    mocks.createClient.mockResolvedValue({
      request: mocks.request,
      closeAndWait: mocks.closeAndWait,
    });
  });

  it("supports the canonical codex virtual provider", () => {
    expect(harness.supports({ provider: "codex", requestedRuntime: "codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("supports openai as the primary OpenClaw routing id", () => {
    expect(harness.supports({ provider: "openai", requestedRuntime: "codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("supports the canonical openai routing id (documented Codex path)", () => {
    expect(harness.supports({ provider: "openai", requestedRuntime: "codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("rejects providers Codex app-server cannot resolve from its own config", () => {
    const result = harness.supports({ provider: "9router", requestedRuntime: "codex" });
    expect(result.supported).toBe(false);
    expect(!result.supported ? (result.reason ?? "") : "").toContain("codex");
  });

  it("normalizes provider casing", () => {
    expect(harness.supports({ provider: "OpenAI", requestedRuntime: "codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("honors explicit provider id overrides", () => {
    const narrowHarness = createCodexAppServerAgentHarness({ providerIds: ["codex"] });
    const result = narrowHarness.supports({ provider: "openai", requestedRuntime: "codex" });
    expect(result.supported).toBe(false);
  });

  it.each([
    {
      response: { account: { type: "apiKey" }, requiresOpenaiAuth: true },
      expected: { ready: true },
    },
    {
      response: { account: null, requiresOpenaiAuth: false },
      expected: { ready: true },
    },
    {
      response: { account: null, requiresOpenaiAuth: true },
      expected: { ready: false, reason: "Codex app-server authentication is required" },
    },
  ])("checks Codex app-server runtime and auth readiness", async ({ response, expected }) => {
    mocks.request.mockResolvedValueOnce(response);
    if (!harness.checkReadiness) {
      throw new Error("expected Codex readiness probe");
    }
    const signal = new AbortController().signal;

    await expect(
      harness.checkReadiness({
        config: {},
        agentId: "main",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        provider: "openai",
        modelId: "gpt-5.5",
        providerAuthAvailable: true,
        signal,
      }),
    ).resolves.toEqual(expected);

    expect(mocks.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ abandonSignal: signal }),
    );
    expect(mocks.request).toHaveBeenCalledWith(
      "account/read",
      { refreshToken: false },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(mocks.closeAndWait).toHaveBeenCalledWith({
      exitTimeoutMs: 2_000,
      forceKillDelayMs: 250,
    });
  });

  it("closes the isolated app-server after a failed readiness request", async () => {
    mocks.request.mockRejectedValueOnce(new Error("request failed"));
    if (!harness.checkReadiness) {
      throw new Error("expected Codex readiness probe");
    }

    await expect(
      harness.checkReadiness({
        config: {},
        agentId: "main",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        provider: "openai",
        modelId: "gpt-5.5",
        providerAuthAvailable: true,
      }),
    ).resolves.toEqual({ ready: false, reason: "Codex app-server readiness check failed" });

    expect(mocks.closeAndWait).toHaveBeenCalledWith({
      exitTimeoutMs: 2_000,
      forceKillDelayMs: 250,
    });
  });
});
