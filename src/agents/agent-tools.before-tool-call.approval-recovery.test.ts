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
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import type { SessionControllerWatchdogAttempt } from "../sessions/session-controller.watchdog.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "./admitted-run-context.js";
import { resolveBeforeToolCallApprovalOutcome } from "./agent-tools.before-tool-call.approval.js";
import type { EmbeddedAgentQueueHandle } from "./embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  testing as embeddedRunTesting,
} from "./embedded-agent-runner/runs.test-support.js";
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
let operation: ReplyOperation;
let watchdogAttempt: SessionControllerWatchdogAttempt;

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
  operation = await withGatewayToolCallerIdentity(
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: ref.sessionKey,
    }),
    () => setActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey),
  );
  watchdogAttempt = operation.watchdog.attachAttempt({
    assertCurrent: () => operation.abortSignal.throwIfAborted(),
  });
});

afterEach(() => {
  clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
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
      return { id: "approval-1", status: "accepted", expiresAtMs: Date.now() + timeoutMs };
    }
    if (method === "plugin.approval.waitDecision") {
      // Like the real client, the wait rejects as soon as the run's signal aborts.
      const waitSignal = (extra as { signal?: AbortSignal } | undefined)?.signal;
      return await new Promise((resolve, reject) => {
        waitSignal?.addEventListener("abort", () => reject(waitSignal.reason), { once: true });
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
    ctx: { ...ref, agentId: "main", watchdogAttempt },
    ...(signal ? { signal } : {}),
    baseParams: { action: "add" },
  });
  return { decision, outcome };
}

function recover() {
  return recoverStuckDiagnosticSession({
    ...ref,
    operation,
    ageMs: 364_000,
    queueDepth: 0,
    allowActiveAbort: true,
  });
}

async function expectHungRunRecovered() {
  vi.setSystemTime(Math.max(Date.now(), operation.watchdog.snapshot().semanticDeadlineAtMs));
  await recover();
  await operation.ownerSettlement;
  expect(abort).toHaveBeenCalledTimes(1);
}

it.each(["approved", "expired", "cancelled"] as const)(
  "protects pending approval work until %s, then recovers a hung run",
  async (ending) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const controller = new AbortController();
      const timeoutMs = ending === "expired" ? 120_000 : 480_000;
      const { decision, outcome } = requestApproval(
        timeoutMs,
        ending === "cancelled" ? controller.signal : undefined,
      );
      await vi.advanceTimersByTimeAsync(0);
      if (ending !== "cancelled") {
        // Approval can outlive the default five-minute stalled-run deadline.
        if (ending === "approved") {
          await vi.advanceTimersByTimeAsync(420_000);
        }
        await expect(recover()).resolves.toMatchObject({
          status: "skipped",
          reason: "active_reply_work",
        });
        expect(operation.watchdog.decide()).toMatchObject({
          action: "observe",
          reason: "approval",
        });
        expect(abort).not.toHaveBeenCalled();
      }
      if (ending === "expired") {
        await vi.advanceTimersByTimeAsync(timeoutMs + GATEWAY_GRACE_MS + 1);
      } else {
        if (ending === "cancelled") {
          controller.abort();
        } else {
          decision.resolve({ id: "approval-1", decision: "allow-once" });
        }
        await expect(outcome).resolves.toMatchObject({ blocked: ending === "cancelled" });
      }
      expect(operation.watchdog.decide().reason).not.toBe("approval");
      await expectHungRunRecovered();
      if (ending === "expired") {
        void outcome.catch(() => {});
      }
    }),
);
