/**
 * Node-host inline exec approval must register human_input_wait so stuck-session
 * recovery does not abort the turn during the approval's own timeout window
 * (same invariant as plugin approvals / #161821).
 *
 * Production caller: executeNodeHostCommand → waitForNodeInlineExecApprovalWithHumanInputProtection
 * when approvalFollowupMode is unset and a routed approval is parked inline.
 */
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
import { waitForNodeInlineExecApprovalWithHumanInputProtection } from "./bash-tools.exec-host-node-approval-wait.js";
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

const GATEWAY_GRACE_MS = 10_000;
const ref = {
  sessionId: "node-approval-session",
  sessionKey: "agent:main:main",
  runId: "node-approval-run",
};
const abort = vi.fn();
let handle: EmbeddedAgentQueueHandle;
let admission: PreparedAgentRunAdmission;
let authority: AgentRunDelegatedAuthority;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-08T12:00:00Z"));
  handle = {
    runId: ref.runId,
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort,
  };
  registerAgentRunContext(ref.runId, { sessionKey: ref.sessionKey, agentId: "main" });
  admission = prepareSystemAgentRunAdmission({}, ref.runId, "main", "node-approval-test");
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
  vi.useRealTimers();
});

function recover() {
  return recoverStuckDiagnosticSession({
    ...ref,
    ageMs: 364_000,
    queueDepth: 0,
    allowActiveAbort: true,
  });
}

function parkOnInlineApproval(timeoutMs: number) {
  const decision = createDeferred<{ decision: string }>();
  const outcome = waitForNodeInlineExecApprovalWithHumanInputProtection({
    runId: ref.runId,
    sessionKey: ref.sessionKey,
    sessionId: ref.sessionId,
    toolCallId: "tool-1",
    approvalId: "approval-1",
    expiresAtMs: Date.now() + timeoutMs,
    wait: async () => await decision.promise,
    isHumanDecision: (value) =>
      value.decision === "allow-once" ||
      value.decision === "allow-always" ||
      value.decision === "deny",
  });
  return { decision, outcome };
}

it("keeps the run alive while a node inline exec approval is pending", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { decision, outcome } = parkOnInlineApproval(1_800_000);
    await vi.advanceTimersByTimeAsync(0);

    // Seven minutes in: past the default five-minute stalled-run abort.
    await vi.advanceTimersByTimeAsync(420_000);
    const skipped = await recover();
    expect(skipped).toMatchObject({
      status: "skipped",
      reason: "human_input_wait",
    });
    expect(abort).not.toHaveBeenCalled();
    if (skipped.status !== "skipped") {
      throw new Error(`expected skipped recovery, got ${skipped.status}`);
    }
    console.log(
      `[node inline approval human_input_wait proof] phase=pending recover_status=${skipped.status} reason=${skipped.reason} ageMs=420000 abort_called=false`,
    );

    decision.resolve({ decision: "allow-once" });
    await expect(outcome).resolves.toMatchObject({ decision: "allow-once" });

    await recover();
    expect(abort).toHaveBeenCalledTimes(1);
    console.log(
      `[node inline approval human_input_wait proof] phase=resolved abort_called=true late_approval_completed=true`,
    );
  });
});

it("stops protecting the run once the node approval window has passed", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { outcome } = parkOnInlineApproval(120_000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(recover()).resolves.toMatchObject({ reason: "human_input_wait" });

    await vi.advanceTimersByTimeAsync(120_000 + GATEWAY_GRACE_MS + 1);
    await recover();
    expect(abort).toHaveBeenCalledTimes(1);
    void outcome.catch(() => {});
  });
});

it("does not protect a run whose node approval wait was cancelled", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const controller = new AbortController();
    const outcome = waitForNodeInlineExecApprovalWithHumanInputProtection({
      runId: ref.runId,
      sessionKey: ref.sessionKey,
      sessionId: ref.sessionId,
      approvalId: "approval-1",
      expiresAtMs: Date.now() + 480_000,
      signal: controller.signal,
      wait: async () =>
        await new Promise<{ decision: string }>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              const reason: unknown = controller.signal.reason;
              reject(
                reason instanceof Error
                  ? reason
                  : new Error(typeof reason === "string" && reason ? reason : "aborted"),
              );
            },
            { once: true },
          );
        }),
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(outcome).rejects.toThrow();

    await recover();
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
