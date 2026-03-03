import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptParams } from "../pi-embedded-runner/run/types.js";
import { createClaudeSdkSession } from "./create-session.js";
import {
  assertAutoCompactEnabled,
  prepareClaudeSdkSession,
  resolveClaudeSdkConfig,
} from "./prepare-session.js";

vi.mock("./create-session.js", () => ({
  createClaudeSdkSession: vi.fn().mockResolvedValue({ sessionId: "mock-session" }),
}));

const baseParams = {
  modelId: "claude-sonnet-4-5",
  sessionId: "s1",
  sessionFile: "/tmp/s.jsonl",
  model: { cost: undefined },
  thinkLevel: "off",
  streamParams: undefined,
} as unknown as EmbeddedRunAttemptParams;

const baseSessionManager = () => ({
  getEntries: vi.fn(() => [] as Array<{ type: string; customType?: string; data?: unknown }>),
  appendCustomEntry: vi.fn(),
  appendMessage: vi.fn(),
});

const claudeSdkConfig = {};
const resolvedWorkspace = "/tmp/ws";
const agentDir = undefined;
const systemPromptText = "sys";
const builtInTools: [] = [];
const allCustomTools: [] = [];
const resolvedProviderAuth = undefined;

type PrepareSessionManager = Parameters<typeof prepareClaudeSdkSession>[3];

function callPrepare(
  params: EmbeddedRunAttemptParams,
  sessionManager: PrepareSessionManager,
  cfg = claudeSdkConfig,
  forceFresh = false,
) {
  return prepareClaudeSdkSession(
    params,
    cfg,
    resolvedProviderAuth,
    sessionManager,
    resolvedWorkspace,
    agentDir,
    systemPromptText,
    builtInTools,
    allCustomTools,
    forceFresh,
  );
}

describe("prepareClaudeSdkSession — model ID validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects modelId that does not start with 'claude-'", async () => {
    const params = { ...baseParams, modelId: "gpt-4o" } as unknown as EmbeddedRunAttemptParams;
    await expect(callPrepare(params, baseSessionManager())).rejects.toThrow(
      /must start with "claude-"/,
    );
  });

  it("resolves without throwing for a valid claude- modelId", async () => {
    await expect(callPrepare(baseParams, baseSessionManager())).resolves.not.toThrow();
  });
});

describe("prepareClaudeSdkSession — resume session ID", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes claudeSdkResumeSessionId from a matching custom entry", async () => {
    const sm = baseSessionManager();
    sm.getEntries.mockReturnValue([
      { type: "custom", customType: "openclaw:claude-sdk-session-id", data: "sess-abc" },
    ]);
    await callPrepare(baseParams, sm);
    const mock = createClaudeSdkSession as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0].claudeSdkResumeSessionId).toBe("sess-abc");
  });

  it("uses the last matching entry when multiple entries exist", async () => {
    const sm = baseSessionManager();
    sm.getEntries.mockReturnValue([
      { type: "custom", customType: "openclaw:claude-sdk-session-id", data: "old-id" },
      { type: "custom", customType: "openclaw:claude-sdk-session-id", data: "new-id" },
    ]);
    await callPrepare(baseParams, sm);
    const mock = createClaudeSdkSession as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0].claudeSdkResumeSessionId).toBe("new-id");
  });

  it("sets claudeSdkResumeSessionId to undefined when data is non-string", async () => {
    const sm = baseSessionManager();
    sm.getEntries.mockReturnValue([
      { type: "custom", customType: "openclaw:claude-sdk-session-id", data: 123 },
    ]);
    await callPrepare(baseParams, sm);
    const mock = createClaudeSdkSession as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0].claudeSdkResumeSessionId).toBeUndefined();
  });

  it("sets claudeSdkResumeSessionId to undefined when no matching entries exist", async () => {
    const sm = baseSessionManager();
    sm.getEntries.mockReturnValue([{ type: "message", data: "irrelevant" }]);
    await callPrepare(baseParams, sm);
    const mock = createClaudeSdkSession as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0].claudeSdkResumeSessionId).toBeUndefined();
  });

  it("sets claudeSdkResumeSessionId to undefined when getEntries is undefined", async () => {
    const sm = { appendCustomEntry: vi.fn(), appendMessage: vi.fn() };
    await callPrepare(baseParams, sm);
    const mock = createClaudeSdkSession as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0].claudeSdkResumeSessionId).toBeUndefined();
  });

  it("clears stale resume marker and forces fresh session when requested", async () => {
    const sm = baseSessionManager();
    sm.getEntries.mockReturnValue([
      { type: "custom", customType: "openclaw:claude-sdk-session-id", data: "sess-stale" },
    ]);
    await callPrepare(baseParams, sm, claudeSdkConfig, true);
    const mock = createClaudeSdkSession as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0].claudeSdkResumeSessionId).toBeUndefined();
    expect(sm.appendCustomEntry).toHaveBeenCalledWith("openclaw:claude-sdk-session-id", null);
    expect(sm.appendCustomEntry).toHaveBeenCalledWith(
      "openclaw:claude-sdk-stale-resume-recovered",
      expect.objectContaining({
        staleSessionId: "sess-stale",
        sessionId: "s1",
      }),
    );
  });
});

describe("prepareClaudeSdkSession — thinkLevel resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses params thinkLevel when it is not 'off'", async () => {
    const params = { ...baseParams, thinkLevel: "low" } as unknown as EmbeddedRunAttemptParams;
    await callPrepare(params, baseSessionManager());
    const mock = createClaudeSdkSession as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0].thinkLevel).toBe("low");
  });

  it("uses thinkingDefault from config when thinkLevel is 'off'", async () => {
    const cfg = { thinkingDefault: "medium" as const };
    await callPrepare(baseParams, baseSessionManager(), cfg);
    const mock = createClaudeSdkSession as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0].thinkLevel).toBe("medium");
  });

  it("keeps 'off' when thinkLevel is 'off' and no thinkingDefault is set", async () => {
    await callPrepare(baseParams, baseSessionManager());
    const mock = createClaudeSdkSession as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0].thinkLevel).toBe("off");
  });

  it("forwards diagnosticsEnabled and sessionKey to createClaudeSdkSession", async () => {
    const params = {
      ...baseParams,
      sessionKey: "agent:test:session",
      config: { diagnostics: { enabled: true } },
    } as unknown as EmbeddedRunAttemptParams;
    await callPrepare(params, baseSessionManager());
    const mock = createClaudeSdkSession as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0].sessionKey).toBe("agent:test:session");
    expect(mock.mock.calls[0][0].diagnosticsEnabled).toBe(true);
  });
});

describe("resolveClaudeSdkConfig — thinkingDefault compatibility", () => {
  it("keeps claudeSdk config when thinkingDefault is legacy 'none'", () => {
    const params = {
      config: {
        agents: {
          defaults: {
            claudeSdk: {
              thinkingDefault: "none",
            },
          },
          list: [],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    const resolved = resolveClaudeSdkConfig(params, "agent-1");
    expect(resolved).toBeDefined();
    expect(resolved?.thinkingDefault).toBe("none");
  });
});

describe("assertAutoCompactEnabled", () => {
  let tmpDir: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-autocompact-test-"));
    // Clean env for each test
    delete process.env.DISABLE_AUTO_COMPACT;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...origEnv };
  });

  it("throws when claude.json has autoCompactEnabled: false", () => {
    const configPath = path.join(tmpDir, ".claude.json");
    fs.writeFileSync(configPath, JSON.stringify({ autoCompactEnabled: false }));
    expect(() => assertAutoCompactEnabled({ configDir: tmpDir })).toThrow(
      /autoCompactEnabled.*false/,
    );
  });

  it("does not throw when autoCompactEnabled is true", () => {
    const configPath = path.join(tmpDir, ".claude.json");
    fs.writeFileSync(configPath, JSON.stringify({ autoCompactEnabled: true }));
    expect(() => assertAutoCompactEnabled({ configDir: tmpDir })).not.toThrow();
  });

  it("does not throw when autoCompactEnabled is absent (default is true)", () => {
    const configPath = path.join(tmpDir, ".claude.json");
    fs.writeFileSync(configPath, JSON.stringify({ someOtherSetting: "value" }));
    expect(() => assertAutoCompactEnabled({ configDir: tmpDir })).not.toThrow();
  });

  it("does not throw when config file does not exist", () => {
    expect(() => assertAutoCompactEnabled({ configDir: tmpDir })).not.toThrow();
  });

  it("does not throw when config file is malformed JSON", () => {
    const configPath = path.join(tmpDir, ".claude.json");
    fs.writeFileSync(configPath, "not valid json{{{");
    expect(() => assertAutoCompactEnabled({ configDir: tmpDir })).not.toThrow();
  });

  it("prefers .config.json over .claude.json when both exist", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".config.json"),
      JSON.stringify({ autoCompactEnabled: false }),
    );
    fs.writeFileSync(
      path.join(tmpDir, ".claude.json"),
      JSON.stringify({ autoCompactEnabled: true }),
    );
    // Should throw because .config.json takes precedence
    expect(() => assertAutoCompactEnabled({ configDir: tmpDir })).toThrow(
      /autoCompactEnabled.*false/,
    );
  });

  it("throws when DISABLE_AUTO_COMPACT env var is '1'", () => {
    // Config file is fine
    const configPath = path.join(tmpDir, ".claude.json");
    fs.writeFileSync(configPath, JSON.stringify({ autoCompactEnabled: true }));
    process.env.DISABLE_AUTO_COMPACT = "1";
    expect(() => assertAutoCompactEnabled({ configDir: tmpDir })).toThrow(/DISABLE_AUTO_COMPACT/);
  });

  it("throws when DISABLE_AUTO_COMPACT env var is 'true'", () => {
    process.env.DISABLE_AUTO_COMPACT = "true";
    expect(() => assertAutoCompactEnabled({ configDir: tmpDir })).toThrow(/DISABLE_AUTO_COMPACT/);
  });

  it("does not throw when DISABLE_AUTO_COMPACT is '0'", () => {
    const configPath = path.join(tmpDir, ".claude.json");
    fs.writeFileSync(configPath, JSON.stringify({ autoCompactEnabled: true }));
    process.env.DISABLE_AUTO_COMPACT = "0";
    expect(() => assertAutoCompactEnabled({ configDir: tmpDir })).not.toThrow();
  });
});
