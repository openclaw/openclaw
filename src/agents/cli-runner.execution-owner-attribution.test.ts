import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: vi.fn(() => false),
    runBeforeAgentReply: vi.fn(async () => undefined),
    runBeforeAgentRun: vi.fn(async () => undefined),
  })),
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  // Preparation replaces the policy requester with the session's execution owner.
  prepareCliRunContext: vi.fn(async (params: RunCliAgentParams) =>
    makeStubContext({ ...params, agentId: "main" }),
  ),
}));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: vi.fn(async () => ({ text: "ok" })),
}));

vi.mock("./cli-runner/cli-live-session-registry.js", () => ({
  closeCliLiveSession: vi.fn(),
  getCliLiveSessionGeneration: vi.fn(() => undefined),
  hasCliLiveSession: vi.fn(() => false),
  acceptsCliLiveSession: vi.fn(() => false),
}));

vi.mock("../gateway/mcp-http.js", () => ({
  closeMcpLoopbackServer: vi.fn(),
}));

vi.mock("./agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
  retireSessionMcpRuntime: vi.fn(async () => true),
}));

const baseRunParams = {
  sessionId: "owner-session",
  sessionKey: "agent:main:main",
  agentId: "worker",
  sessionFile: "/tmp/test-owner-session.jsonl",
  workspaceDir: "/tmp/test-owner-workspace",
  prompt: "visible ask",
  provider: "claude-cli",
  model: "sonnet-4.6",
  timeoutMs: 30_000,
  runId: "run-owner-attribution",
} as const;

function makeStubContext(params: RunCliAgentParams): PreparedCliRunContext {
  // Stub only the prepared context shape runCliAgent needs after the hook gate.
  return {
    params,
    started: Date.now(),
    workspaceDir: params.workspaceDir,
    modelId: params.model ?? "",
    normalizedModel: params.model ?? "",
    systemPrompt: "",
    systemPromptReport: {},
    authEpochVersion: 0,
    backendResolved: {},
    preparedBackend: { backend: { sessionMode: "none" } },
    reusableCliSession: { mode: "none" },
  } as unknown as PreparedCliRunContext;
}

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.clearAllMocks();
  resetDiagnosticEventsForTest();
});

describe("runCliAgent execution-owner attribution", () => {
  it("attributes run and harness spans to the resolved execution owner, not the policy requester", async () => {
    const cliRunner = await import("./cli-runner.js");
    const runCliAgent = wrapRunWithTestPreparedAdmission(cliRunner.runCliAgent);
    const runId = baseRunParams.runId;
    const events: DiagnosticEventPayload[] = [];
    setDiagnosticsEnabledForProcess(true);
    const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
      if ("runId" in event && event.runId === runId) {
        events.push(event);
      }
    });
    try {
      await runCliAgent({ ...baseRunParams });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      unsubscribe();
    }

    const eventOf = <T extends DiagnosticEventPayload["type"]>(type: T) =>
      events.find((event) => event.type === type) as Extract<DiagnosticEventPayload, { type: T }>;
    // Admission-time events carry the runtime-policy requester recorded at its producer.
    expect(eventOf("harness.run.started")?.agentId).toBe("worker");
    expect(eventOf("run.started")?.agentId).toBe("worker");
    // runCliAgentInternal publishes the resolved execution owner after
    // preparation, so terminal run/harness events attribute to it.
    expect(eventOf("run.completed")?.agentId).toBe("main");
    expect(eventOf("harness.run.completed")?.agentId).toBe("main");
  });
});
