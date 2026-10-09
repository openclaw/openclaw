import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { recoverStuckDiagnosticSession } from "../logging/diagnostic-stuck-session-recovery.runtime.js";
import { resetDiagnosticStateForTest } from "../logging/diagnostic.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "./admitted-run-context.js";
import { resolveBeforeToolCallApprovalOutcome } from "./agent-tools.before-tool-call.approval.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "./embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "./embedded-agent-runner/runs.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
import { callGatewayTool } from "./tools/gateway.js";

// mock-isolation: No Gateway runs here; each case scripts the approval RPCs to control timing.
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

const ref = {
  sessionId: "plugin-approval-session",
  sessionKey: "agent:main:main",
  runId: "plugin-approval-run",
};
// The Gateway adds this grace to the approval timeout (resolvePluginToolApprovalGatewayTimeoutMs).
const GATEWAY_GRACE_MS = 10_000;
const abort = vi.fn();
let handle: EmbeddedAgentQueueHandle;
let admission: PreparedAgentRunAdmission;
let authority: AgentRunDelegatedAuthority;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-29T11:18:37Z"));
  handle = {
    runId: ref.runId,
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort,
  };
  registerAgentRunContext(ref.runId, { sessionKey: ref.sessionKey, agentId: "main" });
  admission = prepareSystemAgentRunAdmission({}, ref.runId, "main", "plugin-approval-test");
  const admitted = await admission.admit("embedded");
  authority = getAdmittedRunDelegatedAuthority(admitted)!;
  abort.mockReset().mockImplementation(() => {
    releaseAgentRunDelegatedAuthority(authority);
    clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
  });
  await withGatewayToolCallerIdentity(
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: ref.sessionKey,
    }),
    () => setActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey),
  );
});

afterEach(() => {
  resetDiagnosticStateForTest();
  admission.close();
  releaseAgentRunDelegatedAuthority(authority);
  clearAgentRunContext(ref.runId);
  embeddedRunTesting.resetActiveEmbeddedRuns();
  mockCallGatewayTool.mockReset();
  vi.useRealTimers();
});

/** Parks the tool call on a two-phase Gateway approval whose decision the test controls. */
function requestApproval(timeoutMs: number, signal?: AbortSignal) {
  const decision = createDeferred<{ id: string; decision: unknown }>();
  mockCallGatewayTool.mockImplementation(async (method, _options, _params, extra) => {
    if (method === "plugin.approval.request") {
      return { id: "approval-1", status: "accepted" };
    }
    if (method === "plugin.approval.waitDecision") {
      // Like the real client, the wait rejects as soon as the run's signal aborts.
      const waitSignal = (extra as { signal?: AbortSignal } | undefined)?.signal;
      return await new Promise((resolve, reject) => {
        waitSignal?.addEventListener(
          "abort",
          () => {
            // Keep the signal's own reason: the hook recognizes cancellation by identity.
            const reason: unknown = waitSignal.reason;
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          },
          { once: true },
        );
        void decision.promise.then(resolve);
      });
    }
    throw new Error(`unexpected gateway method ${method}`);
  });
  const outcome = resolveBeforeToolCallApprovalOutcome({
    result: {
      requireApproval: {
        pluginId: "cron-approval",
        title: "Scheduled Task Confirmation",
        description: "Create this scheduled task?",
        timeoutMs,
        allowedDecisions: ["allow-once", "deny"],
      },
    },
    toolName: "cron",
    toolCallId: "cron-call",
    ctx: {
      agentId: "main",
      sessionKey: ref.sessionKey,
      sessionId: ref.sessionId,
      runId: ref.runId,
    },
    ...(signal ? { signal } : {}),
    baseParams: { action: "add" },
  });
  return { decision, outcome };
}

function recover() {
  return recoverStuckDiagnosticSession({
    ...ref,
    ageMs: 364_000,
    queueDepth: 0,
    allowActiveAbort: true,
  });
}

it("keeps the run alive while a plugin approval is pending, then lets the approver finish", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { decision, outcome } = requestApproval(480_000);
    await vi.advanceTimersByTimeAsync(0);

    // Seven minutes in: past the default five-minute stalled-run abort.
    await vi.advanceTimersByTimeAsync(420_000);
    await expect(recover()).resolves.toMatchObject({
      status: "skipped",
      reason: "human_input_wait",
    });
    expect(abort).not.toHaveBeenCalled();

    decision.resolve({ id: "approval-1", decision: "allow-once" });
    await expect(outcome).resolves.toMatchObject({ blocked: false });

    // The decision ends the wait: a run that then stays hung is recovered again.
    await recover();
    expect(abort).toHaveBeenCalledTimes(1);
  });
});

it("stops protecting the run once the approval window has passed", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { outcome } = requestApproval(120_000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(recover()).resolves.toMatchObject({ reason: "human_input_wait" });

    // A Gateway that never answers cannot hold the run past timeout + grace.
    await vi.advanceTimersByTimeAsync(120_000 + GATEWAY_GRACE_MS + 1);
    await recover();
    expect(abort).toHaveBeenCalledTimes(1);
    void outcome.catch(() => {});
  });
});

it("does not protect a run whose approval wait was cancelled", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const controller = new AbortController();
    const { outcome } = requestApproval(480_000, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(outcome).resolves.toMatchObject({ blocked: true });

    await recover();
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
