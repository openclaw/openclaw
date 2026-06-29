import type { AgentToolResultMiddlewareEvent } from "openclaw/plugin-sdk/agent-harness";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { classifyMock, firewallConstructorMock, firewallInstances } = vi.hoisted(() => {
  const classifyMock = vi.fn();
  const firewallInstances: Array<{ options: unknown }> = [];
  const firewallConstructorMock = vi.fn(function Firewall(
    this: { classify?: unknown },
    options: unknown,
  ) {
    firewallInstances.push({ options });
    this.classify = classifyMock;
  });
  return {
    classifyMock,
    firewallConstructorMock,
    firewallInstances,
  };
});

vi.mock("@silmaril-security/sdk", () => ({
  HookLabel: {
    TOOL_RESPONSE: "tool_response",
  },
  Firewall: firewallConstructorMock,
}));

import plugin, {
  __testInternals,
  createSilmarilFirewallAgentToolResultMiddleware,
} from "./index.js";

function makeEvent(
  overrides: Partial<AgentToolResultMiddlewareEvent> = {},
): AgentToolResultMiddlewareEvent {
  return {
    toolCallId: "call-1",
    toolName: "exec",
    args: { workdir: "/workspace" },
    cwd: "/workspace",
    result: {
      content: [{ type: "text", text: "tool output" }],
      details: {},
    },
    ...overrides,
  };
}

describe("silmaril-firewall bundled plugin", () => {
  beforeEach(() => {
    classifyMock.mockReset();
    firewallConstructorMock.mockClear();
    firewallInstances.length = 0;
  });

  it("registers tool result middleware for Pi and Codex runtimes", () => {
    const registerAgentToolResultMiddleware = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "silmaril-firewall",
        name: "Silmaril Firewall",
        source: "test",
        pluginConfig: {
          silmarilApiKey: "key",
          apiUrl: "https://classifier.example/classify",
        },
        runtime: {} as never,
        registerAgentToolResultMiddleware,
      }),
    );

    expect(registerAgentToolResultMiddleware).toHaveBeenCalledWith(expect.any(Function), {
      runtimes: ["pi", "codex"],
    });
  });

  it("classifies tool results and passes through by default", async () => {
    classifyMock.mockResolvedValue({
      prediction: "MALICIOUS",
      score: 0.99,
      threshold: 0.5,
      primaryOutcome: "control_abuse",
    });
    const middleware = createSilmarilFirewallAgentToolResultMiddleware({
      silmarilApiKey: "key",
      apiUrl: "https://classifier.example/classify",
    });

    const result = await middleware(makeEvent(), { runtime: "codex" });

    expect(result).toBeUndefined();
    expect(firewallInstances[0]?.options).toEqual({
      apiKey: "key",
      apiUrl: "https://classifier.example/classify",
      timeoutMs: 2500,
      shadowMode: true,
    });
    expect(classifyMock).toHaveBeenCalledWith("tool output", {
      hook: "tool_response",
      toolName: "exec",
      metadata: expect.objectContaining({
        eventType: "agent_tool_result_middleware",
        runtime: "codex",
        toolCallId: "call-1",
        toolName: "exec",
        cwd: "/workspace",
      }),
    });
  });

  it("replaces malicious tool results with safe metadata only when blocking is enabled", async () => {
    classifyMock.mockResolvedValue({
      prediction: "MALICIOUS",
      score: 0.99,
      threshold: 0.5,
      primaryOutcome: "control_abuse",
    });
    const middleware = createSilmarilFirewallAgentToolResultMiddleware({
      silmarilApiKey: "key",
      apiUrl: "https://classifier.example/classify",
      shadowMode: false,
      blockMalicious: true,
    });

    const result = await middleware(
      makeEvent({
        result: {
          content: [{ type: "text", text: "raw malicious tool output" }],
          details: { raw: "raw malicious detail" },
        },
      }),
      { runtime: "pi", agentId: "agent-1", sessionId: "session-1" },
    );

    expect(result?.result.content).toHaveLength(1);
    const text = result?.result.content[0]?.type === "text" ? result.result.content[0].text : "";
    expect(text).not.toContain("raw malicious tool output");
    expect(JSON.parse(text)).toEqual({
      silmarilFirewall: {
        blocked: true,
        hook: "tool_response",
        openClawHookEvent: "agent_tool_result_middleware",
        runtime: "pi",
        toolName: "exec",
        toolCallId: "call-1",
        reason: "malicious tool output withheld before model reuse",
        classification: {
          prediction: "MALICIOUS",
          score: 0.99,
          threshold: 0.5,
          primaryOutcome: "control_abuse",
        },
      },
    });
    expect(JSON.stringify(result?.result.details)).not.toContain("raw malicious detail");
    expect(result?.result.details).toEqual({
      status: "blocked",
      silmarilFirewall: {
        blocked: true,
        hook: "tool_response",
        openClawHookEvent: "agent_tool_result_middleware",
        runtime: "pi",
        toolName: "exec",
        toolCallId: "call-1",
        reason: "malicious tool output withheld before model reuse",
        classification: {
          prediction: "MALICIOUS",
          score: 0.99,
          threshold: 0.5,
          primaryOutcome: "control_abuse",
        },
      },
    });
  });

  it("honors benign outcomes, thresholds, shadow mode, and classifier failures", async () => {
    const config = {
      apiKey: "key",
      apiUrl: "url",
      timeoutMs: 2500,
      shadowMode: false,
      blockMalicious: true,
    };

    expect(
      __testInternals.shouldBlockClassification(config, {
        prediction: "MALICIOUS",
        score: 0.99,
        threshold: 0.5,
        primaryOutcome: "benign",
      }),
    ).toBe(false);
    expect(
      __testInternals.shouldBlockClassification(config, {
        prediction: "BENIGN",
        score: 0.99,
        threshold: 0.5,
        primaryOutcome: "control_abuse",
      }),
    ).toBe(false);
    expect(
      __testInternals.shouldBlockClassification(config, {
        prediction: "MALICIOUS",
        score: 0.1,
        threshold: 0.5,
        primaryOutcome: "control_abuse",
      }),
    ).toBe(false);
    expect(
      __testInternals.shouldBlockClassification(
        { ...config, shadowMode: true },
        {
          prediction: "MALICIOUS",
          score: 0.99,
          threshold: 0.5,
          primaryOutcome: "control_abuse",
        },
      ),
    ).toBe(false);
  });

  it("fails open when classification throws and does not log raw output", async () => {
    classifyMock.mockRejectedValue(new Error("raw malicious tool output"));
    const logger = { warn: vi.fn() };
    const middleware = createSilmarilFirewallAgentToolResultMiddleware(
      {
        silmarilApiKey: "key",
        apiUrl: "https://classifier.example/classify",
        shadowMode: false,
        blockMalicious: true,
      },
      logger,
    );

    const result = await middleware(
      makeEvent({
        result: {
          content: [{ type: "text", text: "raw malicious tool output" }],
          details: {},
        },
      }),
      { runtime: "codex" },
    );

    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "silmaril-firewall: tool-result classification failed open",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("raw malicious tool output");
  });

  it("skips missing config and non-text results", async () => {
    const logger = { warn: vi.fn() };
    const missingConfigMiddleware = createSilmarilFirewallAgentToolResultMiddleware({}, logger);

    await expect(
      missingConfigMiddleware(makeEvent(), { runtime: "codex" }),
    ).resolves.toBeUndefined();
    await expect(
      missingConfigMiddleware(makeEvent(), { runtime: "codex" }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(classifyMock).not.toHaveBeenCalled();

    const middleware = createSilmarilFirewallAgentToolResultMiddleware({
      silmarilApiKey: "key",
      apiUrl: "https://classifier.example/classify",
    });
    await expect(
      middleware(
        makeEvent({
          result: {
            content: [{ type: "image", mimeType: "image/png", data: "abc" }],
            details: {},
          },
        }),
        { runtime: "pi" },
      ),
    ).resolves.toBeUndefined();
    expect(classifyMock).not.toHaveBeenCalled();
  });
});
