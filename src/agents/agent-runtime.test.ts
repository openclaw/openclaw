import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime, AgentRuntimeRunParams } from "./agent-runtime.js";
import { createPiAgentRuntime } from "./pi-agent-runtime.js";
import { createSdkAgentRuntime } from "./claude-agent-sdk/sdk-agent-runtime.js";
import { isSdkRunnerEnabled } from "./claude-agent-sdk/sdk-runner.config.js";
import type { ClawdbrainConfig } from "../config/config.js";

// ---------------------------------------------------------------------------
// Mock the underlying runners so we don't need real infra.
// ---------------------------------------------------------------------------

vi.mock("./pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn().mockResolvedValue({
    payloads: [{ text: "pi-response" }],
    meta: { durationMs: 100 },
  }),
}));

vi.mock("./claude-agent-sdk/sdk-runner-adapter.js", () => ({
  runSdkAgentAdapted: vi.fn().mockResolvedValue({
    payloads: [{ text: "sdk-response" }],
    meta: { durationMs: 50 },
  }),
}));

const baseRunParams: AgentRuntimeRunParams = {
  sessionId: "test-session",
  sessionFile: "/tmp/test.jsonl",
  workspaceDir: "/tmp/workspace",
  prompt: "Hello",
  timeoutMs: 30000,
  runId: "test-run-1",
};

// ---------------------------------------------------------------------------
// AgentRuntime interface conformance
// ---------------------------------------------------------------------------

describe("AgentRuntime interface conformance", () => {
  it("createPiAgentRuntime produces correct kind and displayName", () => {
    const runtime: AgentRuntime = createPiAgentRuntime({});
    expect(runtime.kind).toBe("pi");
    expect(runtime.displayName).toBe("Pi Agent");
  });

  it("createSdkAgentRuntime produces correct kind and displayName", () => {
    const runtime: AgentRuntime = createSdkAgentRuntime({ tools: [] });
    expect(runtime.kind).toBe("sdk");
    expect(runtime.displayName).toBe("Claude Agent SDK");
  });

  it("Pi runtime run() returns EmbeddedPiRunResult", async () => {
    const runtime = createPiAgentRuntime({});
    const result = await runtime.run(baseRunParams);
    expect(result.payloads).toBeDefined();
    expect(result.payloads![0]!.text).toBe("pi-response");
  });

  it("SDK runtime run() returns EmbeddedPiRunResult", async () => {
    const runtime = createSdkAgentRuntime({ tools: [] });
    const result = await runtime.run(baseRunParams);
    expect(result.payloads).toBeDefined();
    expect(result.payloads![0]!.text).toBe("sdk-response");
  });
});

// ---------------------------------------------------------------------------
// Runtime selection via isSdkRunnerEnabled
// ---------------------------------------------------------------------------

describe("Runtime selection via isSdkRunnerEnabled", () => {
  it("returns true when agents.main.runtime is sdk", () => {
    const config = {
      agents: { main: { runtime: "sdk" } },
    } as ClawdbrainConfig;
    expect(isSdkRunnerEnabled(config)).toBe(true);
  });

  it("returns false when agents.main.runtime is pi", () => {
    const config = {
      agents: { main: { runtime: "pi" } },
    } as ClawdbrainConfig;
    expect(isSdkRunnerEnabled(config)).toBe(false);
  });

  it("returns false when no config is provided", () => {
    expect(isSdkRunnerEnabled(undefined)).toBe(false);
  });

  it("returns false when config is empty", () => {
    expect(isSdkRunnerEnabled({} as ClawdbrainConfig)).toBe(false);
  });

  it("falls back to agents.defaults.runtime when agents.main.runtime is unset", () => {
    const config = {
      agents: { defaults: { runtime: "sdk" } },
    } as ClawdbrainConfig;
    expect(isSdkRunnerEnabled(config)).toBe(true);
  });

  it("agents.main.runtime takes precedence over agents.defaults.runtime", () => {
    const config = {
      agents: { main: { runtime: "pi" }, defaults: { runtime: "sdk" } },
    } as ClawdbrainConfig;
    expect(isSdkRunnerEnabled(config)).toBe(false);
  });

  it("does not enable SDK runtime from tools.codingTask config", () => {
    const config = {
      tools: {
        codingTask: {
          enabled: true,
          providers: {
            zai: { env: { ANTHROPIC_AUTH_TOKEN: "test" } },
          },
        },
      },
    } as ClawdbrainConfig;
    expect(isSdkRunnerEnabled(config)).toBe(false);
  });

  it("runtime sdk takes precedence over codingTask disabled", () => {
    const config = {
      agents: { main: { runtime: "sdk" } },
      tools: {
        codingTask: {
          enabled: false,
        },
      },
    } as ClawdbrainConfig;
    expect(isSdkRunnerEnabled(config)).toBe(true);
  });
});
