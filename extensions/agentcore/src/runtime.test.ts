// @vitest-pool threads
// ↑ vi.mock for external packages requires threads pool (forks doesn't intercept).

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test.
// ---------------------------------------------------------------------------

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(function () {
    return { send: mockSend };
  }),
  InvokeAgentRuntimeCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input };
  }),
  StopRuntimeSessionCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input };
  }),
  RetrieveMemoryRecordsCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input };
  }),
  StartMemoryExtractionJobCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input };
  }),
}));

vi.mock("openclaw/plugin-sdk/acpx", () => {
  class AcpRuntimeError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = "AcpRuntimeError";
    }
  }
  return { AcpRuntimeError };
});

vi.mock("../../hyperion/src/globals.js", () => ({
  hasHyperionRuntime: vi.fn().mockReturnValue(false),
  getHyperionRuntime: vi.fn(),
}));

vi.mock("../../../src/hyperion/session-manager.js", () => ({
  extractTenantId: vi.fn((key: string) => {
    if (!key.startsWith("tenant_")) return null;
    const afterPrefix = key.slice(7);
    const sep = afterPrefix.indexOf(":");
    if (sep < 0) return null;
    return afterPrefix.slice(0, sep);
  }),
  extractAgentId: vi.fn((key: string) => {
    if (!key.startsWith("tenant_")) return "main";
    const afterPrefix = key.slice(7);
    const firstSep = afterPrefix.indexOf(":");
    if (firstSep < 0) return "main";
    const afterUserId = afterPrefix.slice(firstSep + 1);
    const secondSep = afterUserId.indexOf(":");
    if (secondSep < 0) return afterUserId || "main";
    return afterUserId.slice(0, secondSep) || "main";
  }),
}));

vi.mock("../../../src/hyperion/types.js", () => ({
  DEFAULT_AGENT_ID: "main",
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type {
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurnInput,
} from "openclaw/plugin-sdk/acpx";
import { hasHyperionRuntime, getHyperionRuntime } from "../../hyperion/src/globals.js";
import { AGENTCORE_BACKEND_ID, AgentCoreRuntime } from "./runtime.js";
import type { AgentCoreRuntimeConfig, AgentCoreHandleState } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RUNTIME_ARN = "arn:aws:bedrock:us-east-1:123456789012:agent-runtime/test-runtime";

function makeConfig(overrides?: Partial<AgentCoreRuntimeConfig>): AgentCoreRuntimeConfig {
  return {
    region: "us-east-1",
    runtimeArns: [RUNTIME_ARN],
    memoryNamespacePrefix: "tenant_",
    defaultModel: "anthropic.claude-sonnet-4-20250514",
    ...overrides,
  };
}

function createRuntime(overrides?: Partial<AgentCoreRuntimeConfig>): AgentCoreRuntime {
  return new AgentCoreRuntime(makeConfig(overrides));
}

function makeEnsureInput(overrides?: Partial<AcpRuntimeEnsureInput>): AcpRuntimeEnsureInput {
  return {
    agent: "user1",
    sessionKey: "tenant_user1:main:main",
    mode: "persistent",
    ...overrides,
  };
}

function makeTurnInput(
  handle: AcpRuntimeHandle,
  overrides?: Partial<AcpRuntimeTurnInput>,
): AcpRuntimeTurnInput {
  return {
    handle,
    text: "Hi there",
    mode: "prompt",
    requestId: "test-request-id",
    ...overrides,
  };
}

/** Decode the base64url state from a handle's runtimeSessionName. */
function decodeState(handle: AcpRuntimeHandle): AgentCoreHandleState {
  const prefix = "agentcore:v1:";
  const encoded = handle.runtimeSessionName.slice(prefix.length);
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

const SAMPLE_STATE: AgentCoreHandleState = {
  runtimeArn: RUNTIME_ARN,
  sessionId: "test-session-id",
  tenantId: "user123",
  agentId: "main",
  agent: "user123",
  mode: "persistent",
};

/** Collect all events from an async iterable. */
async function collectEvents<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) {
    results.push(item);
  }
  return results;
}

/** Narrow an AcpRuntimeEvent to the error variant. */
function expectErrorEvent(event: AcpRuntimeEvent): AcpRuntimeEvent & { type: "error" } {
  expect(event.type).toBe("error");
  return event as AcpRuntimeEvent & { type: "error" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AGENTCORE_BACKEND_ID", () => {
  it("equals 'agentcore'", () => {
    expect(AGENTCORE_BACKEND_ID).toBe("agentcore");
  });
});

describe("AgentCoreRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  // -----------------------------------------------------------------------
  // ensureSession
  // -----------------------------------------------------------------------

  describe("ensureSession", () => {
    it("throws AcpRuntimeError when agent is missing", async () => {
      const runtime = createRuntime();
      const input = {
        sessionKey: "tenant_u1:main:main",
        mode: "persistent",
      } as Partial<AcpRuntimeEnsureInput>;
      await expect(runtime.ensureSession(input as AcpRuntimeEnsureInput)).rejects.toThrow(
        "Agent ID is required.",
      );
    });

    it("throws AcpRuntimeError when agent is empty/whitespace", async () => {
      const runtime = createRuntime();
      await expect(runtime.ensureSession(makeEnsureInput({ agent: "   " }))).rejects.toThrow(
        "Agent ID is required.",
      );
    });

    it("throws AcpRuntimeError when sessionKey is missing", async () => {
      const runtime = createRuntime();
      const input = { agent: "user1", mode: "persistent" } as Partial<AcpRuntimeEnsureInput>;
      await expect(runtime.ensureSession(input as AcpRuntimeEnsureInput)).rejects.toThrow(
        "Session key is required.",
      );
    });

    it("throws AcpRuntimeError when sessionKey is empty/whitespace", async () => {
      const runtime = createRuntime();
      await expect(runtime.ensureSession(makeEnsureInput({ sessionKey: "   " }))).rejects.toThrow(
        "Session key is required.",
      );
    });

    it("returns handle with correct sessionKey and backend", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      expect(handle.sessionKey).toBe("tenant_user1:main:main");
      expect(handle.backend).toBe("agentcore");
    });

    it("returns handle with runtimeSessionName starting with 'agentcore:v1:'", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      expect(handle.runtimeSessionName).toMatch(/^agentcore:v1:/);
    });

    it("encodes handle state that roundtrips correctly", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      // Verify roundtrip: decode the encoded state and check fields
      const state = decodeState(handle);
      expect(state.runtimeArn).toBe(RUNTIME_ARN);
      expect(state.tenantId).toBe("user1");
      expect(state.agent).toBe("user1");
      expect(state.mode).toBe("persistent");
      expect(state.sessionId).toBeTruthy();

      // Also verify via getStatus (the public API roundtrip)
      const status = await runtime.getStatus({ handle });
      expect(status.summary).toContain(`session=${state.sessionId}`);
      expect(status.summary).toContain("tenant=user1");
      expect(status.backendSessionId).toBe(state.sessionId);
    });

    it("uses resumeSessionId when provided", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(
        makeEnsureInput({ resumeSessionId: "existing-session-id-123" }),
      );

      const state = decodeState(handle);
      expect(state.sessionId).toBe("existing-session-id-123");
      expect(handle.backendSessionId).toBe("existing-session-id-123");
    });

    it("generates new UUID sessionId when no resumeSessionId", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      const state = decodeState(handle);
      // UUID v4 format: 8-4-4-4-12 hex chars
      expect(state.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("extracts agentId from session key", async () => {
      const runtime = createRuntime();
      // Session key "tenant_user1:work:main" => agentId = "work"
      const handle = await runtime.ensureSession(
        makeEnsureInput({ sessionKey: "tenant_user1:work:main" }),
      );

      const state = decodeState(handle);
      expect(state.agentId).toBe("work");
    });
  });

  // -----------------------------------------------------------------------
  // cancel
  // -----------------------------------------------------------------------

  describe("cancel", () => {
    it("calls StopRuntimeSessionCommand via client.send", async () => {
      const runtime = createRuntime();
      mockSend.mockResolvedValue({});

      const handle = await runtime.ensureSession(makeEnsureInput());
      await runtime.cancel({ handle });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentCommand = mockSend.mock.calls[0][0];
      expect(sentCommand.input.agentRuntimeArn).toBe(RUNTIME_ARN);
      expect(sentCommand.input.runtimeSessionId).toBeTruthy();
    });

    it("swallows errors (best-effort)", async () => {
      const runtime = createRuntime();
      mockSend.mockRejectedValue(new Error("Network error"));

      const handle = await runtime.ensureSession(makeEnsureInput());

      // Should not throw
      await expect(runtime.cancel({ handle })).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // close
  // -----------------------------------------------------------------------

  describe("close", () => {
    it("calls StopRuntimeSessionCommand for oneshot mode", async () => {
      const runtime = createRuntime();
      mockSend.mockResolvedValue({});

      const handle = await runtime.ensureSession(makeEnsureInput({ mode: "oneshot" }));
      await runtime.close({ handle, reason: "done" });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentCommand = mockSend.mock.calls[0][0];
      expect(sentCommand.input.agentRuntimeArn).toBe(RUNTIME_ARN);
    });

    it("does NOT call StopRuntimeSessionCommand for persistent mode", async () => {
      const runtime = createRuntime();

      const handle = await runtime.ensureSession(makeEnsureInput());
      await runtime.close({ handle, reason: "done" });

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // doctor
  // -----------------------------------------------------------------------

  describe("doctor", () => {
    it("returns ok:false when no runtimeArns configured", async () => {
      const runtime = createRuntime({ runtimeArns: [] });

      const report = await runtime.doctor();

      expect(report.ok).toBe(false);
      expect(report.code).toBe("ACP_BACKEND_UNAVAILABLE");
      expect(report.message).toContain("No AgentCore Runtime ARNs configured");
    });

    it("returns ok:true with message when runtimeArns are present", async () => {
      const runtime = createRuntime();

      const report = await runtime.doctor();

      expect(report.ok).toBe(true);
      expect(report.message).toContain("AgentCore backend configured");
      expect(report.message).toContain("us-east-1");
      expect(report.message).toContain("runtimes: 1");
    });
  });

  // -----------------------------------------------------------------------
  // getCapabilities
  // -----------------------------------------------------------------------

  describe("getCapabilities", () => {
    it("returns capabilities with empty controls array", () => {
      const runtime = createRuntime();
      const caps = runtime.getCapabilities();
      expect(caps).toEqual({ controls: [] });
    });
  });

  // -----------------------------------------------------------------------
  // getStatus
  // -----------------------------------------------------------------------

  describe("getStatus", () => {
    it("returns summary with session, runtime, and tenant info", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput({ resumeSessionId: "sess-abc" }));

      const status = await runtime.getStatus({ handle });

      expect(status.summary).toContain("session=sess-abc");
      expect(status.summary).toContain(`runtime=${RUNTIME_ARN}`);
      expect(status.summary).toContain("tenant=user1");
      expect(status.backendSessionId).toBe("sess-abc");
    });
  });

  // -----------------------------------------------------------------------
  // isHealthy / setHealthy
  // -----------------------------------------------------------------------

  describe("isHealthy / setHealthy", () => {
    it("is initially false", () => {
      const runtime = createRuntime();
      expect(runtime.isHealthy()).toBe(false);
    });

    it("setHealthy(true) makes it true", () => {
      const runtime = createRuntime();
      runtime.setHealthy(true);
      expect(runtime.isHealthy()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // resolveHandleState (tested indirectly via getStatus)
  // -----------------------------------------------------------------------

  describe("resolveHandleState (indirect)", () => {
    it("throws AcpRuntimeError for handle with wrong prefix", async () => {
      const runtime = createRuntime();
      const badHandle: AcpRuntimeHandle = {
        sessionKey: "test",
        backend: "agentcore",
        runtimeSessionName: "wrong-prefix:eyJ0ZXN0IjoxfQ",
      };

      await expect(runtime.getStatus({ handle: badHandle })).rejects.toThrow(
        "Invalid AgentCore runtime handle",
      );
    });

    it("throws AcpRuntimeError for handle with corrupted base64", async () => {
      const runtime = createRuntime();
      const badHandle: AcpRuntimeHandle = {
        sessionKey: "test",
        backend: "agentcore",
        runtimeSessionName: "agentcore:v1:!!!not-valid-base64!!!",
      };

      await expect(runtime.getStatus({ handle: badHandle })).rejects.toThrow("could not decode");
    });
  });

  // -----------------------------------------------------------------------
  // pickRuntimeArn (tested indirectly via ensureSession)
  // -----------------------------------------------------------------------

  describe("pickRuntimeArn (indirect)", () => {
    it("throws when runtimeArns is empty", async () => {
      const runtime = createRuntime({ runtimeArns: [] });

      await expect(runtime.ensureSession(makeEnsureInput())).rejects.toThrow(
        "No AgentCore Runtime ARNs configured",
      );
    });

    it("selects from multiple ARNs without error", async () => {
      const arns = [
        "arn:aws:bedrock:us-east-1:123456789012:agent-runtime/rt-1",
        "arn:aws:bedrock:us-east-1:123456789012:agent-runtime/rt-2",
      ];
      const runtime = createRuntime({ runtimeArns: arns });

      const handle = await runtime.ensureSession(makeEnsureInput());

      const state = decodeState(handle);
      expect(arns).toContain(state.runtimeArn);
    });
  });

  // -----------------------------------------------------------------------
  // runTurn
  // -----------------------------------------------------------------------

  describe("runTurn", () => {
    it("yields text_delta and done events for a successful invocation", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      mockSend
        .mockResolvedValueOnce({ records: [] }) // retrieveMemory
        .mockResolvedValueOnce({
          response: {
            transformToString: async () => JSON.stringify({ response: "Hello, user!" }),
          },
        }) // InvokeAgentRuntime
        .mockResolvedValueOnce({}); // StartMemoryExtractionJob

      const events = await collectEvents(runtime.runTurn(makeTurnInput(handle)));

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: "text_delta",
        text: "Hello, user!",
        stream: "output",
      });
      expect(events[1]).toEqual({ type: "done" });
    });

    it("yields done event when response body is empty", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      mockSend
        .mockResolvedValueOnce({ records: [] }) // retrieveMemory
        .mockResolvedValueOnce({
          response: { transformToString: async () => "   " },
        });

      const events = await collectEvents(runtime.runTurn(makeTurnInput(handle)));

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "done" });
    });

    it("yields error event on invocation failure", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      mockSend
        .mockResolvedValueOnce({ records: [] }) // retrieveMemory
        .mockRejectedValueOnce(new Error("Connection refused"));

      const events = await collectEvents(runtime.runTurn(makeTurnInput(handle)));

      expect(events).toHaveLength(1);
      const errEvent = expectErrorEvent(events[0]);
      expect(errEvent.message).toContain("Connection refused");
    });

    it("yields retryable error on ThrottlingException", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      const throttleErr = new Error("Rate exceeded");
      throttleErr.name = "ThrottlingException";

      mockSend.mockResolvedValueOnce({ records: [] }).mockRejectedValueOnce(throttleErr);

      const events = await collectEvents(runtime.runTurn(makeTurnInput(handle)));

      expect(events).toHaveLength(1);
      const errEvent = expectErrorEvent(events[0]);
      expect(errEvent.code).toBe("RATE_LIMITED");
      expect(errEvent.retryable).toBe(true);
    });

    it("sets healthy=false on ResourceNotFoundException", async () => {
      const runtime = createRuntime();
      runtime.setHealthy(true);
      expect(runtime.isHealthy()).toBe(true);

      const handle = await runtime.ensureSession(makeEnsureInput());

      const notFoundErr = new Error("Runtime not found");
      notFoundErr.name = "ResourceNotFoundException";

      mockSend.mockResolvedValueOnce({ records: [] }).mockRejectedValueOnce(notFoundErr);

      const events = await collectEvents(runtime.runTurn(makeTurnInput(handle)));

      const errEvent = expectErrorEvent(events[0]);
      expect(errEvent.code).toBe("RESOURCE_NOT_FOUND");
      expect(runtime.isHealthy()).toBe(false);
    });

    it("silently returns when signal is aborted during invocation", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      const abortController = new AbortController();
      abortController.abort();

      mockSend
        .mockResolvedValueOnce({ records: [] })
        .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

      const events = await collectEvents(
        runtime.runTurn(makeTurnInput(handle, { signal: abortController.signal })),
      );

      expect(events).toHaveLength(0);
    });

    it("loads tenant context when Hyperion runtime is available", async () => {
      const mockDbClient = {
        getTenantConfig: vi.fn().mockResolvedValue({
          user_id: "user1",
          display_name: "Test User",
          model: "anthropic.claude-sonnet-4-20250514",
          custom_instructions: "Be helpful",
          tools: [],
          profile: {},
          plan: "pro",
        }),
      };

      vi.mocked(hasHyperionRuntime).mockReturnValue(true);
      vi.mocked(getHyperionRuntime).mockReturnValue({
        dbClient: mockDbClient,
      } as unknown as ReturnType<typeof getHyperionRuntime>);

      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      mockSend
        .mockResolvedValueOnce({ records: [] }) // retrieveMemory
        .mockResolvedValueOnce({
          response: {
            transformToString: async () => JSON.stringify({ response: "Hi!" }),
          },
        }) // InvokeAgentRuntime
        .mockResolvedValueOnce({}); // extractMemory

      const events = await collectEvents(runtime.runTurn(makeTurnInput(handle, { text: "Hello" })));

      expect(mockDbClient.getTenantConfig).toHaveBeenCalledWith("user1", "main");
      expect(events[0].type).toBe("text_delta");
    });

    it("includes memory records in invocation payload when available", async () => {
      vi.mocked(hasHyperionRuntime).mockReturnValue(false);

      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      mockSend
        .mockResolvedValueOnce({
          records: [
            { content: { text: "User likes coffee" }, score: 0.95 },
            { content: { text: "User is a developer" }, score: 0.88 },
          ],
        }) // retrieveMemory
        .mockResolvedValueOnce({
          response: {
            transformToString: async () => JSON.stringify({ response: "Got it!" }),
          },
        }) // InvokeAgentRuntime
        .mockResolvedValueOnce({}); // extractMemory

      await collectEvents(runtime.runTurn(makeTurnInput(handle, { text: "Tell me about myself" })));

      // Verify InvokeAgentRuntimeCommand was called (second send call)
      expect(mockSend).toHaveBeenCalledTimes(3);
      const invokeCall = mockSend.mock.calls[1][0];
      const payload = JSON.parse(new TextDecoder().decode(invokeCall.input.payload));
      expect(payload.memory_context).toHaveLength(2);
      expect(payload.memory_context[0].content).toBe("User likes coffee");
    });

    it("fires memory extraction after a turn with response text", async () => {
      vi.mocked(hasHyperionRuntime).mockReturnValue(false);

      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      mockSend
        .mockResolvedValueOnce({ records: [] }) // retrieveMemory
        .mockResolvedValueOnce({
          response: {
            transformToString: async () => JSON.stringify({ response: "Memory-worthy response" }),
          },
        }) // InvokeAgentRuntime
        .mockResolvedValueOnce({}); // extractMemory

      await collectEvents(runtime.runTurn(makeTurnInput(handle, { text: "Important message" })));

      // Wait a tick for fire-and-forget to execute
      await new Promise((r) => setTimeout(r, 10));

      // Third send call should be StartMemoryExtractionJobCommand
      expect(mockSend).toHaveBeenCalledTimes(3);
      const extractCall = mockSend.mock.calls[2][0];
      expect(extractCall.input.namespace).toBe("tenant_user1:main");
      expect(extractCall.input.content.text).toContain("Important message");
      expect(extractCall.input.content.text).toContain("Memory-worthy response");
    });

    it("uses correct memory namespace with agentId from session key", async () => {
      vi.mocked(hasHyperionRuntime).mockReturnValue(false);

      const runtime = createRuntime();
      // Session key with agentId "work"
      const handle = await runtime.ensureSession(
        makeEnsureInput({ sessionKey: "tenant_user1:work:slack:U111" }),
      );

      mockSend
        .mockResolvedValueOnce({ records: [] }) // retrieveMemory
        .mockResolvedValueOnce({
          response: {
            transformToString: async () => JSON.stringify({ response: "Reply" }),
          },
        })
        .mockResolvedValueOnce({}); // extractMemory

      await collectEvents(runtime.runTurn(makeTurnInput(handle, { text: "test" })));

      await new Promise((r) => setTimeout(r, 10));

      // Memory namespace should be "tenant_user1:work"
      const extractCall = mockSend.mock.calls[2][0];
      expect(extractCall.input.namespace).toBe("tenant_user1:work");
    });

    it("handles non-JSON response body as raw text", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      mockSend
        .mockResolvedValueOnce({ records: [] })
        .mockResolvedValueOnce({
          response: {
            transformToString: async () => "Plain text response",
          },
        })
        .mockResolvedValueOnce({});

      const events = await collectEvents(runtime.runTurn(makeTurnInput(handle)));

      expect(events[0]).toEqual({
        type: "text_delta",
        text: "Plain text response",
        stream: "output",
      });
    });

    it("handles response with no response body (yields done)", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      mockSend.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({
        response: undefined,
      });

      const events = await collectEvents(runtime.runTurn(makeTurnInput(handle)));

      expect(events).toEqual([{ type: "done" }]);
    });

    it("emits retryable error for 5xx status code", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      mockSend.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({
        response: { transformToString: async () => "error" },
        statusCode: 503,
      });

      const events = await collectEvents(runtime.runTurn(makeTurnInput(handle)));

      expect(events[0]).toMatchObject({
        type: "error",
        retryable: true,
      });
      const errEvent = expectErrorEvent(events[0]);
      expect(errEvent.message).toContain("503");
    });

    it("emits non-retryable error for 4xx status code", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      mockSend.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({
        response: { transformToString: async () => "error" },
        statusCode: 400,
      });

      const events = await collectEvents(runtime.runTurn(makeTurnInput(handle)));

      expect(events[0]).toMatchObject({
        type: "error",
        retryable: false,
      });
    });

    it("continues without tenant context when Hyperion runtime throws", async () => {
      vi.mocked(hasHyperionRuntime).mockReturnValue(true);
      vi.mocked(getHyperionRuntime).mockReturnValue({
        dbClient: {
          getTenantConfig: vi.fn().mockRejectedValue(new Error("DDB timeout")),
        },
      } as unknown as ReturnType<typeof getHyperionRuntime>);

      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      mockSend
        .mockResolvedValueOnce({ records: [] }) // retrieveMemory
        .mockResolvedValueOnce({
          response: {
            transformToString: async () => JSON.stringify({ response: "Still works" }),
          },
        })
        .mockResolvedValueOnce({});

      const events = await collectEvents(runtime.runTurn(makeTurnInput(handle)));

      // Should still get a response despite tenant context failure
      expect(events[0]).toMatchObject({ type: "text_delta", text: "Still works" });
    });

    it("continues without memory when retrieveMemory throws", async () => {
      vi.mocked(hasHyperionRuntime).mockReturnValue(false);

      const runtime = createRuntime();
      const handle = await runtime.ensureSession(makeEnsureInput());

      mockSend
        .mockRejectedValueOnce(new Error("Memory service down")) // retrieveMemory fails
        .mockResolvedValueOnce({
          response: {
            transformToString: async () => JSON.stringify({ response: "Works anyway" }),
          },
        })
        .mockResolvedValueOnce({});

      const events = await collectEvents(runtime.runTurn(makeTurnInput(handle)));

      expect(events[0]).toMatchObject({ type: "text_delta", text: "Works anyway" });
    });
  });

  // -----------------------------------------------------------------------
  // handleInvocationError — error classification (via private access)
  // -----------------------------------------------------------------------

  describe("handleInvocationError (error classification)", () => {
    function collectErrors(
      runtime: AgentCoreRuntime,
      err: unknown,
    ): Array<{ type: string; code?: string; message?: string; retryable?: boolean }> {
      const events: Array<{ type: string; code?: string; message?: string; retryable?: boolean }> =
        [];
      // Access private method via bracket notation for testing
      for (const event of runtime["handleInvocationError"](err)) {
        events.push(event);
      }
      return events;
    }

    it("classifies ThrottlingException as RATE_LIMITED and retryable", () => {
      const runtime = createRuntime();
      const err = new Error("Rate exceeded");
      err.name = "ThrottlingException";

      const events = collectErrors(runtime, err);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "error",
        code: "RATE_LIMITED",
        retryable: true,
      });
    });

    it("classifies 'Too Many Requests' message as RATE_LIMITED", () => {
      const runtime = createRuntime();
      const events = collectErrors(runtime, new Error("Too Many Requests"));
      expect(events[0]).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    });

    it("classifies ServiceUnavailableException as SERVICE_UNAVAILABLE", () => {
      const runtime = createRuntime();
      const err = new Error("Service unavailable");
      err.name = "ServiceUnavailableException";

      const events = collectErrors(runtime, err);
      expect(events[0]).toMatchObject({ code: "SERVICE_UNAVAILABLE", retryable: true });
    });

    it("classifies ResourceNotFoundException and sets unhealthy", () => {
      const runtime = createRuntime();
      runtime.setHealthy(true);
      const err = new Error("Not found");
      err.name = "ResourceNotFoundException";

      const events = collectErrors(runtime, err);
      expect(events[0]).toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      expect(runtime.isHealthy()).toBe(false);
    });

    it("classifies unknown errors as generic (no code, not retryable)", () => {
      const runtime = createRuntime();
      const events = collectErrors(runtime, new Error("Something unexpected"));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      expect(events[0].code).toBeUndefined();
      expect(events[0].retryable).toBeUndefined();
      expect(events[0].message).toContain("Something unexpected");
    });
  });

  // -----------------------------------------------------------------------
  // processResponse (via private access)
  // -----------------------------------------------------------------------

  describe("processResponse (indirect)", () => {
    interface MockResponse {
      response?: { transformToString: () => Promise<string> };
      statusCode?: number;
    }

    async function collectResponseEvents(
      runtime: AgentCoreRuntime,
      response: MockResponse,
      state: AgentCoreHandleState,
    ) {
      return collectEvents(runtime["processResponse"](response, state));
    }

    it("parses JSON with 'text' field", async () => {
      const runtime = createRuntime();
      const events = await collectResponseEvents(
        runtime,
        { response: { transformToString: async () => JSON.stringify({ text: "Text reply" }) } },
        SAMPLE_STATE,
      );
      expect(events).toEqual([
        { type: "text_delta", text: "Text reply", stream: "output" },
        { type: "done" },
      ]);
    });

    it("parses JSON with 'message' field", async () => {
      const runtime = createRuntime();
      const events = await collectResponseEvents(
        runtime,
        { response: { transformToString: async () => JSON.stringify({ message: "Msg reply" }) } },
        SAMPLE_STATE,
      );
      expect(events).toEqual([
        { type: "text_delta", text: "Msg reply", stream: "output" },
        { type: "done" },
      ]);
    });

    it("emits error when transformToString throws", async () => {
      const runtime = createRuntime();
      const events = await collectResponseEvents(
        runtime,
        {
          response: {
            transformToString: async () => {
              throw new Error("Stream interrupted");
            },
          },
        },
        SAMPLE_STATE,
      );
      expect(events[0]).toMatchObject({
        type: "error",
        message: expect.stringContaining("Stream interrupted"),
      });
    });
  });
});
