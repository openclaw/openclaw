import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { sendMessage } from "../infra/outbound/message.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  claimExecApprovalFollowupRuntimeHandoff,
  finalizeExecApprovalFollowupRuntimeHandoff,
} from "./bash-tools.exec-approval-followup-state.js";
import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";
import { sendExecApprovalFollowupResult } from "./bash-tools.exec-host-shared.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn(async () => ({ status: "ok" })) }));
vi.mock("../infra/outbound/message.js", () => ({ sendMessage: vi.fn(async () => ({ ok: true })) }));

const sessionDirs = useSessionStoreTempDirs(afterAll, "exec-approval-followup-store-");
const requireRecord = createRequireRecord("record", "expected-label");
const approvalId = "req-1";
const sessionKey = "agent:main:main";
const finished = "Exec finished (gateway id=req-1, code 0)\nok";
const denied = "Exec denied (gateway id=req-1, approval-timeout (allowlist-miss)): uname -a";
const route = { turnSourceChannel: "telegram", turnSourceTo: "123" };
const runId = "exec-approval-followup:req-1:nonce:nonce-test";
const pending = { ...route, internalRuntimeHandoffId: "handoff-test", idempotencyKey: runId };
type Followup = Parameters<typeof sendExecApprovalFollowup>[0];

function send(overrides: Partial<Followup> = {}) {
  return sendExecApprovalFollowup({ approvalId, sessionKey, resultText: finished, ...overrides });
}
function direct(overrides: Partial<Followup> = {}) {
  return send({ ...route, sessionKey: undefined, ...overrides });
}
function agentArgs(expected: Record<string, unknown> = {}) {
  const call = vi.mocked(callGatewayTool).mock.calls[0];
  expect(call?.[0]).toBe("agent");
  const params = requireRecord(call?.[2], "agent params");
  expect(params).toMatchObject(expected);
  return params;
}
function directArgs(expected: Record<string, unknown> = {}) {
  const params = requireRecord(vi.mocked(sendMessage).mock.calls[0]?.[0], "direct params");
  expect(params).toMatchObject({
    gatewayOwnedDelivery: true,
    idempotencyKey: `exec-approval-followup:${approvalId}`,
    deliveryIntentId: `exec-approval-followup:${approvalId}`,
    reusePendingDeliveryIntent: true,
    completionRetention: {
      idPrefix: "exec-approval-followup:",
      maxAgeMs: 86_400_000,
      maxEntries: 2_000,
    },
    ...expected,
  });
  return params;
}
function acceptRun() {
  vi.mocked(callGatewayTool).mockResolvedValueOnce({ runId, status: "accepted" });
  return vi.mocked(callGatewayTool);
}
function diagnostics(internal = false) {
  const events: DiagnosticEventPayload[] = [];
  (internal ? onInternalDiagnosticEvent : onDiagnosticEvent)((event) => events.push(event));
  return events;
}
function terminalFailure(error: string) {
  return { runId, status: "error", endedAt: Date.now(), error };
}
function expectCalls(gateway: number, deliveries: number) {
  expect(callGatewayTool).toHaveBeenCalledTimes(gateway);
  expect(sendMessage).toHaveBeenCalledTimes(deliveries);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  resetDiagnosticEventsForTest();
});

describe("exec approval followup", () => {
  it("resumes a denied command with its session pin and no prior output", async () => {
    await send({ resultText: denied, turnSourceChannel: "webchat", expectedSessionId: "original" });
    const params = agentArgs({
      sessionKey,
      channel: "webchat",
      deliver: false,
      execApprovalFollowupExpectedSessionId: "original",
    });
    expect(params.message).toContain("did not run");
    expect(params.message).toContain("Do not mention, summarize, or reuse output");
    expect(params.message).not.toContain("already approved has completed");
  });

  it.each([
    [
      "Exec outcome unknown (node=node-1 id=req-1, outcome-unknown)\nThe command may have executed.\nCommand:\nprintf 'one\\ntwo'",
      [
        "The command may have executed.",
        "Do not run the command again automatically.",
        "Do not claim it was denied, not dispatched, or safe to retry.",
        "Command:\nprintf 'one\\ntwo'",
      ],
      [],
    ],
    [
      "Exec not dispatched (node=node-1 id=req-1, not-dispatched)\nNode command was not dispatched to node-1.",
      ["was not dispatched and did not run", "Retry only after resolving the connection failure"],
      ["already approved has completed", "Do not run the command again."],
    ],
  ] as const)("preserves retry guidance for %s", async (resultText, contains, excludes) => {
    await send({ resultText });
    const prompt = agentArgs({ sessionKey }).message;
    for (const text of contains) {
      expect(prompt).toContain(text);
    }
    for (const text of excludes) {
      expect(prompt).not.toContain(text);
    }
  });

  it("preserves outcome-unknown details in direct delivery", async () => {
    const resultText =
      "Exec outcome unknown (node=node-1 id=req-1, outcome-unknown)\nThe command may have executed. Do not rerun it automatically.\n\nCommand:\necho first\necho second";
    await direct({ direct: true, resultText });
    directArgs({ content: resultText });
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it.each([
    [denied, "replacement", true],
    [finished, "replacement", true],
    [denied, "original", false],
  ] as const)(
    "validates approval-time session for %s / %s (stale=%s)",
    async (resultText, currentSession, stale) => {
      const sessionStore = path.join(sessionDirs.make(), "sessions.json");
      await replaceSessionEntry(
        { storePath: sessionStore, sessionKey },
        { sessionId: currentSession, updatedAt: Date.now() },
      );
      const events = diagnostics();
      await expect(
        send({ ...route, direct: true, resultText, expectedSessionId: "original", sessionStore }),
      ).resolves.toBe(!stale);
      expect(callGatewayTool).not.toHaveBeenCalled();
      if (stale) {
        expect(sendMessage).not.toHaveBeenCalled();
        await waitForDiagnosticEventsDrained();
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "exec.approval.followup_suppressed",
            approvalId,
            reason: "session_rebound",
            phase: "direct_delivery",
          }),
        );
      } else {
        expect(sendMessage).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([4, 0])("delivers terminal fallback after %i ambiguous waits", async (waits) => {
    const gateway = acceptRun();
    for (let i = 0; i < waits; i++) {
      gateway.mockResolvedValueOnce({
        runId,
        status: "timeout",
        timeoutPhase: "queue",
        providerStarted: false,
      });
    }
    gateway.mockResolvedValueOnce(
      terminalFailure(waits ? "provider failed after prolonged execution" : "provider failed"),
    );
    const clippedOutput = `Exec finished (gateway id=req-1, code 1)\nHEAD_SENTINEL_${"x".repeat(5_000)}TAIL_SENTINEL_🚀`;
    await expect(
      send({ ...pending, ...(waits ? {} : { resultText: clippedOutput }) }),
    ).resolves.toBe(true);
    expectCalls(waits + 2, 1);
    if (!waits) {
      const content = directArgs({ channel: "telegram", to: "123" }).content;
      if (typeof content !== "string") {
        throw new Error("expected fallback content");
      }
      expect(content).toHaveLength(4_000);
      expect(content).toMatch(
        /^Automatic session resume failed, so sending the status directly\.\n\n\[\.\.\. earlier command output omitted \.\.\.\]\n/,
      );
      expect(content).not.toContain("HEAD_SENTINEL");
      expect(content).toContain("TAIL_SENTINEL_🚀");
      expect(Buffer.from(content, "utf8").toString("utf8")).toBe(content);
    }
  });

  it("retries observation after a transport error without competing direct delivery", async () => {
    acceptRun()
      .mockRejectedValueOnce(new Error("gateway reconnecting"))
      .mockResolvedValueOnce({ runId, status: "ok" });
    await send(pending);
    expectCalls(3, 0);
  });

  it("ends observation at its deadline without competing direct delivery", async () => {
    const events = diagnostics(true);
    const startedAt = new Date("2026-08-01T00:00:00Z").getTime();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    acceptRun().mockImplementationOnce(async () => {
      clock.mockReturnValue(startedAt + 10 * 60_000);
      throw new Error("gateway permanently unreachable");
    });
    await expect(send(pending)).resolves.toBe(true);
    clock.mockRestore();
    await waitForDiagnosticEventsDrained();
    expectCalls(2, 0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "log.record",
        level: "WARN",
        message: "Exec approval followup observation ended",
        loggerName: "agents/exec-approval-followup",
        attributes: {
          approvalId,
          runId,
          reason: "deadline",
          transportErrors: 1,
          deliveryOwner: "accepted_agent_run",
        },
      }),
    );
  });

  it.each([
    { suppressionReason: "cancelled_by_message_sending_hook", error: "delivery was suppressed" },
    { suppressionReason: "adapter_returned_no_identity", error: "delivery could not be confirmed" },
  ] as const)(
    "rejects direct delivery after $suppressionReason",
    async ({ suppressionReason, error }) => {
      vi.mocked(sendMessage).mockResolvedValueOnce({
        channel: "telegram",
        to: "123",
        via: "direct",
        mediaUrl: null,
        deliveryStatus: "suppressed",
        suppressionReason,
      });
      await expect(direct()).rejects.toThrow(error);
    },
  );

  it("provides a summary when a no-session completion has no output", async () => {
    await direct({ resultText: "Exec finished (gateway id=req-1, code 0)" });
    directArgs({ content: "Background command finished." });
  });

  it("suppresses denied delivery for a subagent session", async () => {
    await expect(
      send({ ...route, sessionKey: "agent:main:subagent:test", resultText: denied.toLowerCase() }),
    ).resolves.toBe(false);
    expectCalls(0, 0);
  });

  it("registers the authenticated runtime handoff before dispatch without exposing elevation", async () => {
    const target = {
      approvalId,
      sessionKey,
      turnSourceChannel: "telegram",
      bashElevated: { enabled: true, allowed: true, defaultLevel: "on" as const },
    };
    let handoff: ReturnType<typeof claimExecApprovalFollowupRuntimeHandoff>;
    vi.mocked(callGatewayTool).mockImplementationOnce(async (_method, _options, raw) => {
      const params = requireRecord(raw, "followup params");
      const handoffId = String(params.internalRuntimeHandoffId);
      handoff = claimExecApprovalFollowupRuntimeHandoff({
        handoffId,
        approvalId,
        sessionKey,
        idempotencyKey: String(params.idempotencyKey),
        claimId: "default-dispatch",
      });
      finalizeExecApprovalFollowupRuntimeHandoff({ handoffId, claimId: "default-dispatch" });
      return { status: "ok" };
    });
    await sendExecApprovalFollowupResult(target, finished);
    const params = agentArgs({ sessionKey, channel: "telegram" });
    expect(params).toMatchObject({
      message: expect.stringContaining("<<<BEGIN_UNTRUSTED_EXEC_OUTPUT>>>"),
      internalRuntimeHandoffId: expect.any(String),
      idempotencyKey: expect.stringMatching(/^exec-approval-followup:req-1:nonce:[0-9a-f-]{36}$/),
    });
    expect(params.inputProvenance).toEqual({
      kind: "inter_session",
      sourceSessionKey: sessionKey,
      sourceTool: "exec_approval_followup",
    });
    expect(handoff).toEqual({
      kind: "exec-approval-followup",
      approvalId,
      sessionKey,
      idempotencyKey: params.idempotencyKey,
      bashElevated: target.bashElevated,
      resultText: finished,
    });
    expect(params.message).toContain("ok");
    expect(params).not.toHaveProperty("bashElevated");
    expect(params).not.toHaveProperty("execApprovalFollowupToken");
  });

  it("requires a session or deliverable route", async () => {
    await expect(send({ sessionKey: undefined, turnSourceChannel: "slack" })).rejects.toThrow(
      "Session key or deliverable origin route is required",
    );
  });
});
