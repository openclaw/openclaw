// MAREF Governance extension tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  GateDecision,
  GovernanceStatus,
} from "@maref-org/sdk";
import plugin from "./index.js";

// ── Mocks ─────────────────────────────────────────────────────────────
// Use vi.mock to replace @maref-org/sdk with a test double.
// MAREFClient must be a proper constructor (returns an object from `new`).

const { mockClientInstance } = vi.hoisted(() => {
  const inst = {
    checkBeforeWrite: vi.fn(),
    checkBeforeExecute: vi.fn(),
    reportAction: vi.fn().mockResolvedValue(undefined),
    getGovernanceStatus: vi.fn(),
  };
  return { mockClientInstance: inst };
});

vi.mock("@maref-org/sdk", () => {
  // Must use a real function (not arrow) so `new` returns the object
  function MockMAREFClient() {
    return mockClientInstance;
  }
  MockMAREFClient.prototype.constructor = MockMAREFClient;
  return { MAREFClient: MockMAREFClient };
});

// ── Helpers ───────────────────────────────────────────────────────────

function makeAllowDecision(overrides?: Partial<GateDecision>): GateDecision {
  return {
    verdict: "allow",
    rule_id: "ALLOW-TEST",
    reason: "Policy allows this operation",
    risk_score: 0.1,
    decision_latency_ms: 5,
    actor: "test-agent",
    breaker_state: "closed",
    metadata: {},
    ...overrides,
  };
}

function makeBlockDecision(overrides?: Partial<GateDecision>): GateDecision {
  return {
    verdict: "block",
    rule_id: "BLOCK-TEST",
    reason: "Policy blocks this operation",
    risk_score: 0.9,
    decision_latency_ms: 5,
    actor: "test-agent",
    breaker_state: "closed",
    metadata: {},
    ...overrides,
  };
}

function makeHITLDecision(overrides?: Partial<GateDecision>): GateDecision {
  return {
    verdict: "hitl_required",
    rule_id: "HITL-TEST",
    reason: "Human review required",
    risk_score: 0.7,
    decision_latency_ms: 5,
    actor: "test-agent",
    breaker_state: "closed",
    metadata: {},
    ...overrides,
  };
}

function captureRegisterHook(
  api: OpenClawPluginApi,
): Map<string, (event: unknown, ctx: unknown) => unknown> {
  const hooks = new Map<
    string,
    (event: unknown, ctx: unknown) => unknown
  >();
  api.registerHook = vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
    hooks.set(name, handler);
  }) as typeof api.registerHook;
  return hooks;
}

/** Minimal plugin API with defaults for maref-governance tests. */
function createTestApi(
  overrides?: Partial<OpenClawPluginApi>,
): OpenClawPluginApi {
  return {
    id: "maref-governance",
    name: "MAREF Governance",
    source: "test",
    registrationMode: "full",
    pluginConfig: {},
    config: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerHostedMediaResolver: vi.fn(),
    registerMcpServerConnectionResolver: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerSessionCatalog: vi.fn(),
    registerCli: vi.fn(),
    registerNodeCliFeature: vi.fn(),
    registerCliBackend: vi.fn(),
    registerTextTransforms: vi.fn(),
    registerService: vi.fn(),
    registerGatewayDiscoveryService: vi.fn(),
    registerReload: vi.fn(),
    registerNodeHostCommand: vi.fn(),
    registerNodeInvokePolicy: vi.fn(),
    registerSecurityAuditCollector: vi.fn(),
    registerConfigMigration: vi.fn(),
    registerMigrationProvider: vi.fn(),
    registerAutoEnableProbe: vi.fn(),
    registerProvider: vi.fn(),
    registerModelCatalogProvider: vi.fn(),
    registerEmbeddingProvider: vi.fn(),
    registerSpeechProvider: vi.fn(),
    registerRealtimeTranscriptionProvider: vi.fn(),
    registerRealtimeVoiceProvider: vi.fn(),
    registerMediaUnderstandingProvider: vi.fn(),
    registerTranscriptSourceProvider: vi.fn(),
    registerImageGenerationProvider: vi.fn(),
    registerMusicGenerationProvider: vi.fn(),
    registerVideoGenerationProvider: vi.fn(),
    registerWebFetchProvider: vi.fn(),
    registerWebSearchProvider: vi.fn(),
    registerWorkerProvider: vi.fn(),
    registerInteractiveHandler: vi.fn(),
    onConversationBindingResolved: vi.fn(),
    registerCommand: vi.fn(),
    registerContextEngine: vi.fn(),
    registerCompactionProvider: vi.fn(),
    registerAgentHarness: vi.fn(),
    registerCodexAppServerExtensionFactory: vi.fn(),
    registerAgentToolResultMiddleware: vi.fn(),
    registerDetachedTaskRuntime: vi.fn(),
    registerSessionExtension: vi.fn(),
    registerTrustedToolPolicy: vi.fn(),
    registerToolMetadata: vi.fn(),
    registerControlUiDescriptor: vi.fn(),
    registerRuntimeLifecycle: vi.fn(),
    registerAgentEventSubscription: vi.fn(),
    registerSchedulerJob: vi.fn(),
    sendSessionAttachment: vi.fn(),
    scheduleSessionTurn: vi.fn(),
    unscheduleSessionTurnsByTag: vi.fn(),
    enqueueNextTurnInjection: vi.fn(),
    setRunContext: vi.fn(),
    getRunContext: vi.fn(),
    clearRunContext: vi.fn(),
    resolvePath: (input: string) => input,
    on: vi.fn(),
    ...overrides,
  } as unknown as OpenClawPluginApi;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("maref-governance plugin", () => {
  let api: OpenClawPluginApi;
  let hooks: Map<string, (event: unknown, ctx: unknown) => unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    api = createTestApi();
    hooks = captureRegisterHook(api);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function registerPlugin(config: Record<string, unknown> = {}): void {
    api.pluginConfig = config;
    plugin.register(api);
  }

  /** Convenience: get the before_tool_call handler or throw. */
  function getBeforeToolCallHandler(): (
    event: unknown,
    ctx: unknown,
  ) => unknown {
    const handler = hooks.get("before_tool_call");
    if (!handler) throw new Error("before_tool_call hook not registered");
    return handler;
  }

  /** Convenience: get the security audit collector or throw. */
  function getSecurityAuditCollector(): { collect: () => unknown } {
    const call = vi.mocked(api.registerSecurityAuditCollector).mock.calls[0];
    if (!call) throw new Error("securityAuditCollector not registered");
    return call[0] as unknown as { collect: () => unknown };
  }

  describe("registration", () => {
    it("registers before_tool_call hook and security audit collector", () => {
      registerPlugin();
      expect(api.registerHook).toHaveBeenCalledWith(
        "before_tool_call",
        expect.any(Function),
      );
      expect(api.registerSecurityAuditCollector).toHaveBeenCalledWith(
        expect.objectContaining({
          collectorId: "maref-governance",
          label: "MAREF Governance",
        }),
      );
    });
  });

  describe("logging mode", () => {
    beforeEach(() => {
      registerPlugin({ mode: "logging" });
    });

    it("passes through all tool calls without checking sidecar", async () => {
      const handler = getBeforeToolCallHandler();
      const result = await handler(
        { toolName: "write", params: { file_path: "/tmp/test.txt" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      );
      expect(result).toEqual({});
      expect(mockClientInstance!.checkBeforeWrite).not.toHaveBeenCalled();
      expect(mockClientInstance!.checkBeforeExecute).not.toHaveBeenCalled();
    });

    it("passes through any tool call (including exec) without checking sidecar", async () => {
      const handler = getBeforeToolCallHandler();
      const result = await handler(
        { toolName: "Bash", params: { command: "rm -rf /" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      );
      expect(result).toEqual({});
      expect(mockClientInstance!.checkBeforeExecute).not.toHaveBeenCalled();
    });
  });

  describe("advisory mode", () => {
    beforeEach(() => {
      registerPlugin({ mode: "advisory" });
    });

    it("passes through even when sidecar blocks", async () => {
      mockClientInstance!.checkBeforeWrite.mockResolvedValue(makeBlockDecision());
      const handler = getBeforeToolCallHandler();
      const result = await handler(
        { toolName: "write", params: { file_path: "/tmp/test.txt" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      );
      // Advisory mode always passes
      expect(result).toEqual({});
      expect(mockClientInstance!.checkBeforeWrite).toHaveBeenCalledTimes(1);
    });

    it("passes through block verdict and calls reportAction", async () => {
      mockClientInstance!.checkBeforeWrite.mockResolvedValue(makeBlockDecision());
      const handler = getBeforeToolCallHandler();
      await handler(
        { toolName: "write", params: { file_path: "/tmp/test.txt" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      );
      expect(mockClientInstance!.reportAction).toHaveBeenCalled();
    });

    it("passes through on sidecar error (fail-open)", async () => {
      mockClientInstance!.checkBeforeWrite.mockRejectedValue(new Error("ECONNREFUSED"));
      const handler = getBeforeToolCallHandler();
      const result = await handler(
        { toolName: "write", params: { file_path: "/tmp/test.txt" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      );
      expect(result).toEqual({});
    });
  });

  describe("enforcing mode", () => {
    beforeEach(() => {
      registerPlugin({ mode: "enforcing", failClosed: true });
    });

    it("allows when verdict is allow", async () => {
      mockClientInstance!.checkBeforeWrite.mockResolvedValue(makeAllowDecision());
      const handler = getBeforeToolCallHandler();
      const result = await handler(
        { toolName: "write", params: { file_path: "/tmp/test.txt" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      );
      expect(result).toEqual({});
    });

    it("blocks when verdict is block", async () => {
      mockClientInstance!.checkBeforeWrite.mockResolvedValue(makeBlockDecision());
      const handler = getBeforeToolCallHandler();
      const result = await handler(
        { toolName: "write", params: { file_path: "/tmp/test.txt" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      ) as { block?: boolean; blockReason?: string };
      expect(result.block).toBe(true);
      expect(result.blockReason).toContain("BLOCKED");
      expect(result.blockReason).toContain("BLOCK-TEST");
    });

    it("blocks when HITL is required", async () => {
      mockClientInstance!.checkBeforeWrite.mockResolvedValue(makeHITLDecision());
      const handler = getBeforeToolCallHandler();
      const result = await handler(
        { toolName: "write", params: { file_path: "/tmp/test.txt" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      ) as { block?: boolean; blockReason?: string };
      expect(result.block).toBe(true);
      expect(result.blockReason).toContain("HITL required");
    });

    it("blocks command execution when verdict is block", async () => {
      mockClientInstance!.checkBeforeExecute.mockResolvedValue(makeBlockDecision());
      const handler = getBeforeToolCallHandler();
      const result = await handler(
        { toolName: "exec", params: { command: "rm -rf /" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      ) as { block?: boolean; blockReason?: string };
      expect(result.block).toBe(true);
      expect(result.blockReason).toContain("execute");
    });

    it("allows command execution when verdict is allow", async () => {
      mockClientInstance!.checkBeforeExecute.mockResolvedValue(makeAllowDecision());
      const handler = getBeforeToolCallHandler();
      const result = await handler(
        { toolName: "exec", params: { command: "echo hello" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      );
      expect(result).toEqual({});
    });

    it("calls reportAction with correct context", async () => {
      mockClientInstance!.checkBeforeWrite.mockResolvedValue(makeAllowDecision());
      const handler = getBeforeToolCallHandler();
      await handler(
        { toolName: "write", params: { file_path: "/tmp/test.txt" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      );
      expect(mockClientInstance!.reportAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "openclaw:before_tool_call",
        }),
      );
    });
  });

  describe("fail-closed behavior", () => {
    it("blocks when sidecar unreachable in enforcing mode", async () => {
      registerPlugin({ mode: "enforcing", failClosed: true });
      mockClientInstance!.checkBeforeWrite.mockRejectedValue(new Error("ECONNREFUSED"));
      const handler = getBeforeToolCallHandler();
      const result = await handler(
        { toolName: "write", params: { file_path: "/tmp/test.txt" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      ) as { block?: boolean; blockReason?: string };
      expect(result.block).toBe(true);
      expect(result.blockReason).toContain("FAIL-CLOSED");
    });

    it("does not block on sidecar error when failClosed is false", async () => {
      registerPlugin({ mode: "enforcing", failClosed: false });
      mockClientInstance!.checkBeforeWrite.mockRejectedValue(new Error("ECONNREFUSED"));
      const handler = getBeforeToolCallHandler();
      const result = await handler(
        { toolName: "write", params: { file_path: "/tmp/test.txt" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      );
      expect(result).toEqual({});
    });

    it("does not block on sidecar error in advisory mode even with failClosed true", async () => {
      registerPlugin({ mode: "advisory", failClosed: true });
      mockClientInstance!.checkBeforeWrite.mockRejectedValue(new Error("ECONNREFUSED"));
      const handler = getBeforeToolCallHandler();
      const result = await handler(
        { toolName: "write", params: { file_path: "/tmp/test.txt" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      );
      expect(result).toEqual({});
    });
  });

  describe("non-file/non-command tool calls pass through", () => {
    it("allows tools with neither file_path nor command params", async () => {
      registerPlugin({ mode: "enforcing" });
      const handler = getBeforeToolCallHandler();
      const result = await handler(
        { toolName: "think", params: { thought: "hmm" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      );
      expect(result).toEqual({});
      expect(mockClientInstance!.checkBeforeWrite).not.toHaveBeenCalled();
      expect(mockClientInstance!.checkBeforeExecute).not.toHaveBeenCalled();
    });
  });

  describe("default config values", () => {
    it("defaults to enforcing mode, fail-closed, localhost sidecar", async () => {
      // pluginConfig not set — should use defaults
      registerPlugin();
      const handler = getBeforeToolCallHandler();
      mockClientInstance!.checkBeforeWrite.mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await handler(
        { toolName: "write", params: { file_path: "/tmp/test.txt" } },
        { agentId: "test-agent", sessionId: "sess-1" },
      ) as { block?: boolean; blockReason?: string };
      expect(result.block).toBe(true);
      expect(result.blockReason).toContain("FAIL-CLOSED");
    });
  });

  describe("security audit collector", () => {
    it("returns ok status when sidecar is reachable", async () => {
      registerPlugin();
      mockClientInstance!.getGovernanceStatus.mockResolvedValue({
        state: "active",
        circuit_breaker: "CLOSED",
        agent_count: 5,
        trust_score_avg: 0.85,
        drift_level: "LOW",
        timestamp: Date.now(),
      });
      const collector = getSecurityAuditCollector();
      const result = await collector.collect() as { status: string; data: Record<string, unknown> };
      expect(result.status).toBe("ok");
      expect(result.data.governance_state).toBe("active");
      expect(result.data.circuit_breaker).toBe("CLOSED");
      expect(result.data.trust_score_avg).toBe(0.85);
      expect(result.data.drift_level).toBe("LOW");
    });

    it("returns error status when sidecar is unreachable", async () => {
      registerPlugin();
      mockClientInstance!.getGovernanceStatus.mockRejectedValue(new Error("ECONNREFUSED"));
      const collector = getSecurityAuditCollector();
      const result = await collector.collect() as { status: string; data: Record<string, unknown> };
      expect(result.status).toBe("error");
      expect(result.data.error).toContain("unreachable");
    });
  });
});
