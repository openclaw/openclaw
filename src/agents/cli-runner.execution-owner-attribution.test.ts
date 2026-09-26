/** Tests execution-owner attribution for CLI runs with a distinct policy requester. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import type { HookRunner } from "../plugins/hooks.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import type { CliOutput } from "./cli-output-contracts.js";
import { admitCliRunParams } from "./cli-runner/run-admission.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";

// vi.mock factories are hoisted above imports, so any references inside them
// must come from vi.hoisted() so they exist at hoist time. This test exercises
// the diagnostic seam between runCliAgent's synthetic harness lifecycle and the
// prepared context, so prepareCliRunContext + executePreparedCliRun stay mocked
// and no broader CLI runtime loads.
const {
  hasHooksMock,
  runBeforeAgentReplyMock,
  runBeforeAgentRunMock,
  executePreparedCliRunMock,
  prepareCliRunContextMock,
  closeCliSessionMock,
  closeMcpLoopbackServerMock,
  retireSessionMcpRuntimeForSessionKeyMock,
  retireSessionMcpRuntimeMock,
} = vi.hoisted(() => ({
  hasHooksMock: vi.fn<(hookName: string) => boolean>(() => false),
  runBeforeAgentReplyMock: vi.fn<(event: unknown, ctx: unknown) => Promise<undefined>>(
    async () => undefined,
  ),
  runBeforeAgentRunMock: vi.fn<HookRunner["runBeforeAgentRun"]>(async () => undefined),
  executePreparedCliRunMock: vi.fn<
    (_context: unknown, _cliSessionIdToUse?: string) => Promise<CliOutput>
  >(async () => ({ text: "ok" })),
  prepareCliRunContextMock: vi.fn(),
  closeCliSessionMock: vi.fn(),
  closeMcpLoopbackServerMock: vi.fn(),
  retireSessionMcpRuntimeForSessionKeyMock: vi.fn(),
  retireSessionMcpRuntimeMock: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: hasHooksMock,
    runBeforeAgentReply: runBeforeAgentReplyMock,
    runBeforeAgentRun: runBeforeAgentRunMock,
  })),
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  prepareCliRunContext: prepareCliRunContextMock,
}));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

vi.mock("./cli-runner/cli-live-session-registry.js", () => ({
  closeCliLiveSession: closeCliSessionMock,
  getCliLiveSessionGeneration: vi.fn(() => undefined),
  hasCliLiveSession: vi.fn(() => false),
  acceptsCliLiveSession: vi.fn(() => false),
}));

vi.mock("../gateway/mcp-http.js", () => ({
  closeMcpLoopbackServer: closeMcpLoopbackServerMock,
}));

vi.mock("./agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: retireSessionMcpRuntimeForSessionKeyMock,
  retireSessionMcpRuntime: retireSessionMcpRuntimeMock,
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

type ProductionRunCliAgent = typeof import("./cli-runner.js").runCliAgent;
type TestRunCliAgent = (
  params: Omit<Parameters<ProductionRunCliAgent>[0], "admittedRunContext">,
) => ReturnType<ProductionRunCliAgent>;
let runCliAgent: TestRunCliAgent;

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

beforeEach(() => {
  hasHooksMock.mockReset();
  hasHooksMock.mockReturnValue(false);
  runBeforeAgentReplyMock.mockReset();
  runBeforeAgentReplyMock.mockResolvedValue(undefined);
  runBeforeAgentRunMock.mockReset();
  runBeforeAgentRunMock.mockResolvedValue(undefined);
  executePreparedCliRunMock.mockReset();
  executePreparedCliRunMock.mockResolvedValue({ text: "ok" });
  prepareCliRunContextMock.mockReset();
  // Real preparation admits the run after resolving the execution owner.
  prepareCliRunContextMock.mockImplementation(async (params: RunCliAgentParams) =>
    makeStubContext(await admitCliRunParams(params, "main")),
  );
  closeCliSessionMock.mockReset();
  closeMcpLoopbackServerMock.mockReset();
  retireSessionMcpRuntimeForSessionKeyMock.mockReset();
  retireSessionMcpRuntimeForSessionKeyMock.mockResolvedValue(true);
  retireSessionMcpRuntimeMock.mockReset();
  retireSessionMcpRuntimeMock.mockResolvedValue(true);
});

beforeAll(async () => {
  const cliRunner = await import("./cli-runner.js");
  runCliAgent = wrapRunWithTestPreparedAdmission(cliRunner.runCliAgent);
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.clearAllMocks();
  resetDiagnosticEventsForTest();
});

describe("runCliAgent execution-owner attribution", () => {
  it("attributes run and harness spans to the resolved execution owner, not the policy requester", async () => {
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
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "harness.run.started",
        "run.started",
        "run.completed",
        "harness.run.completed",
      ]),
    );
    // Admission-time events carry the runtime-policy requester recorded at its producer.
    expect(eventOf("harness.run.started")?.agentId).toBe("worker");
    expect(eventOf("run.started")?.agentId).toBe("worker");
    // runCliAgentInternal publishes the resolved execution owner after
    // preparation, so terminal run/harness events attribute to it.
    expect(eventOf("run.completed")?.agentId).toBe("main");
    expect(eventOf("harness.run.completed")?.agentId).toBe("main");
  });
});
