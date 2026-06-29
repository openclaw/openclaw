import type { AgentToolResultMiddlewareEvent } from "openclaw/plugin-sdk/agent-harness";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin, {
  __testInternals,
  createSilmarilFirewallAgentToolResultMiddleware,
} from "./index.js";

const fetchMock = vi.fn();

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

function mockClassifyResponse(response: Record<string, unknown>) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => response,
  });
}

describe("silmaril-firewall bundled plugin", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
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
    mockClassifyResponse({
      prediction: "MALICIOUS",
      score: 0.99,
      threshold: 0.5,
      primary_outcome: "control_abuse",
    });
    const middleware = createSilmarilFirewallAgentToolResultMiddleware({
      silmarilApiKey: "key",
      apiUrl: "https://classifier.example/classify",
    });

    const result = await middleware(makeEvent(), { runtime: "codex" });

    expect(result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://classifier.example/classify",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "key",
        },
        redirect: "error",
        body: expect.any(String),
        signal: expect.any(AbortSignal),
      }),
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(requestBody).toMatchObject({
      text: "tool output",
      hook: "tool_response",
      tool_name: "exec",
      metadata: expect.objectContaining({
        eventType: "agent_tool_result_middleware",
        runtime: "codex",
        toolCallId: "call-1",
        toolName: "exec",
        cwd: "/workspace",
        silmaril: expect.objectContaining({
          client_language: "typescript",
          client_name: "openclaw-bundled-silmaril-firewall",
          input_index: 0,
          chunk_index: 0,
          chunk_count: 1,
          request_id: expect.any(String),
        }),
      }),
    });
  });

  it("replaces malicious tool results with safe metadata only when blocking is enabled", async () => {
    mockClassifyResponse({
      prediction: "MALICIOUS",
      score: 0.99,
      threshold: 0.5,
      primary_outcome: "control_abuse",
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
    fetchMock.mockRejectedValue(new Error("raw malicious tool output"));
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
    expect(fetchMock).not.toHaveBeenCalled();

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
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
