import { describe, expect, it, vi, beforeEach } from "vitest";

const mockRunEmbeddedPiAgent = vi.fn().mockResolvedValue({
  payloads: [{ text: "Hello", isError: false }],
  meta: {},
});

const mockResolveThinkingDefault = vi.fn().mockReturnValue("medium");

vi.mock("./core-bridge.js", () => ({
  loadCoreAgentDeps: vi.fn().mockResolvedValue({
    resolveStorePath: () => "/tmp/test-store",
    resolveAgentDir: () => "/tmp/test-agent",
    resolveAgentWorkspaceDir: () => "/tmp/test-workspace",
    ensureAgentWorkspace: vi.fn().mockResolvedValue(undefined),
    loadSessionStore: () => ({
      "voice:1234567890": { sessionId: "test-session", updatedAt: Date.now() },
    }),
    saveSessionStore: vi.fn().mockResolvedValue(undefined),
    resolveSessionFilePath: () => "/tmp/test-session.json",
    resolveAgentIdentity: () => ({ name: "TestBot" }),
    resolveThinkingDefault: (...args: unknown[]) => mockResolveThinkingDefault(...args),
    runEmbeddedPiAgent: (...args: unknown[]) => mockRunEmbeddedPiAgent(...args),
    resolveAgentTimeoutMs: () => 30000,
    DEFAULT_PROVIDER: "openai",
    DEFAULT_MODEL: "gpt-4o-mini",
  }),
}));

import { generateVoiceResponse } from "./response-generator.js";

describe("voice-call response-generator thinkLevel (#22423)", () => {
  beforeEach(() => {
    mockRunEmbeddedPiAgent.mockClear();
    mockResolveThinkingDefault.mockClear();
    mockResolveThinkingDefault.mockReturnValue("medium");
  });

  it("should pass thinkLevel 'off' to runEmbeddedPiAgent, not the global default", async () => {
    const cfg = {
      agents: { defaults: { thinkingDefault: "medium" } },
    };

    await generateVoiceResponse({
      voiceConfig: {},
      coreConfig: cfg,
      callId: "test-call",
      from: "+1234567890",
      transcript: [],
      userMessage: "Hello",
    });

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledOnce();
    const callArgs = mockRunEmbeddedPiAgent.mock.calls[0][0];

    // Bug: thinkLevel should be "off" for voice calls (latency-sensitive),
    // but currently it uses resolveThinkingDefault() which returns the global default
    expect(callArgs.thinkLevel).toBe("off");
  });
});
