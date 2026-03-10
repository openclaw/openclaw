import { describe, expect, it, vi, beforeEach } from "vitest";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

const mockDeps = {
  resolveStorePath: vi.fn().mockReturnValue("/tmp/store"),
  resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
  ensureAgentWorkspace: vi.fn().mockResolvedValue(undefined),
  loadSessionStore: vi.fn().mockReturnValue({}),
  saveSessionStore: vi.fn().mockResolvedValue(undefined),
  resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/session.jsonl"),
  resolveThinkingDefault: vi.fn().mockReturnValue("off"),
  resolveAgentIdentity: vi.fn().mockReturnValue({ name: "TestBot" }),
  resolveAgentTimeoutMs: vi.fn().mockReturnValue(30000),
  runEmbeddedPiAgent: vi.fn().mockResolvedValue({ payloads: [{ text: "Hello" }] }),
  DEFAULT_PROVIDER: "openai",
  DEFAULT_MODEL: "gpt-4o-mini",
};

vi.mock("./core-bridge.js", () => ({
  loadCoreAgentDeps: () => Promise.resolve(mockDeps),
}));

const { generateVoiceResponse } = await import("./response-generator.js");

describe("generateVoiceResponse", () => {
  const baseCoreConfig = { session: { store: "/tmp" } } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDeps.loadSessionStore.mockReturnValue({});
    mockDeps.runEmbeddedPiAgent.mockResolvedValue({ payloads: [{ text: "Hello" }] });
  });

  it("defaults agentId to 'main' when responseAgentId is not set", async () => {
    const voiceConfig = createVoiceCallBaseConfig();

    await generateVoiceResponse({
      voiceConfig,
      coreConfig: baseCoreConfig,
      callId: "call-1",
      from: "+15559991234",
      transcript: [],
      userMessage: "Hi",
    });

    expect(mockDeps.resolveStorePath).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: "main" }),
    );
    expect(mockDeps.resolveAgentDir).toHaveBeenCalledWith(expect.anything(), "main");
    expect(mockDeps.resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.anything(), "main");
    expect(mockDeps.resolveAgentIdentity).toHaveBeenCalledWith(expect.anything(), "main");
    expect(mockDeps.resolveSessionFilePath).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ agentId: "main" }),
    );
    expect(mockDeps.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
  });

  it("uses responseAgentId from config when set", async () => {
    const voiceConfig = { ...createVoiceCallBaseConfig(), responseAgentId: "nikki" };

    await generateVoiceResponse({
      voiceConfig,
      coreConfig: baseCoreConfig,
      callId: "call-2",
      from: "+15559991234",
      transcript: [],
      userMessage: "Hi",
    });

    expect(mockDeps.resolveStorePath).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: "nikki" }),
    );
    expect(mockDeps.resolveAgentDir).toHaveBeenCalledWith(expect.anything(), "nikki");
    expect(mockDeps.resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.anything(), "nikki");
    expect(mockDeps.resolveAgentIdentity).toHaveBeenCalledWith(expect.anything(), "nikki");
    expect(mockDeps.resolveSessionFilePath).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ agentId: "nikki" }),
    );
    expect(mockDeps.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "nikki" }),
    );
  });

  it("passes agentId through to embedded run", async () => {
    const voiceConfig = { ...createVoiceCallBaseConfig(), responseAgentId: "dev" };

    await generateVoiceResponse({
      voiceConfig,
      coreConfig: baseCoreConfig,
      callId: "call-3",
      from: "+15559991234",
      transcript: [],
      userMessage: "Test",
    });

    const runCall = mockDeps.runEmbeddedPiAgent.mock.calls[0][0];
    expect(runCall.agentId).toBe("dev");
    expect(runCall.lane).toBe("voice");
    expect(runCall.prompt).toBe("Test");
  });

  it("returns null text when coreConfig is falsy", async () => {
    const voiceConfig = createVoiceCallBaseConfig();
    const result = await generateVoiceResponse({
      voiceConfig,
      coreConfig: null as never,
      callId: "call-4",
      from: "+15559991234",
      transcript: [],
      userMessage: "Hi",
    });

    expect(result.text).toBeNull();
    expect(result.error).toContain("Core config unavailable");
  });
});
