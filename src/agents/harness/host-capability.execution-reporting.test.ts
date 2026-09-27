import { afterEach, expect, it } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import {
  onTrustedToolExecutionEvent,
  type TrustedToolExecutionEvent,
} from "../../infra/diagnostic-events.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { retainBeforeToolCallForNativeHookRelay } from "./host-private-capabilities.js";

const hosts: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.closeHost();
    host.closeAdmission();
  }
  resetAgentRunRegistryForTest();
});
it("binds native execution facts to the admitted host and exact action while preserving late settlement", async () => {
  const controller = new AbortController();
  const host = await createAdmittedHostCapabilityTestFixture({
    runId: "bound-run",
    agentId: "main",
    sessionKey: "agent:main:bound",
    sessionId: "bound-session",
    abortSignal: controller.signal,
  });
  hosts.push(host);
  const events: TrustedToolExecutionEvent[] = [];
  const stop = onTrustedToolExecutionEvent((event) => events.push(event));
  try {
    const bind = host.hostCapabilities.bindToolExecution;
    expect(bind).toBeTypeOf("function");
    if (!bind) {
      throw new Error("missing host execution reporter");
    }
    const identity = { toolName: "exec", toolCallId: "action-1" };
    const report = bind(identity);
    identity.toolCallId = "forged-action";
    report.started();
    controller.abort();
    host.closeHost();
    expect(() => bind({ toolName: "exec", toolCallId: "new-action" })).toThrow();
    expect(() => report.started()).toThrow();
    report.finished({ type: "tool.execution.completed", durationMs: 1 });
    expect(() =>
      report.finished({ type: "tool.execution.error", durationMs: 2, errorCategory: "late" }),
    ).toThrow();
    expect(
      events.map(({ type, runId, agentId, toolOwner, toolCallId }) => ({
        type,
        runId,
        agentId,
        toolOwner,
        toolCallId,
      })),
    ).toEqual([
      {
        type: "tool.execution.started",
        runId: "bound-run",
        agentId: "main",
        toolOwner: "codex",
        toolCallId: "action-1",
      },
      {
        type: "tool.execution.completed",
        runId: "bound-run",
        agentId: "main",
        toolOwner: "codex",
        toolCallId: "action-1",
      },
    ]);
  } finally {
    stop();
  }
});

it.each(["close", "abort", "replace", "release"] as const)(
  "rejects fresh work after %s without suppressing an accepted failure",
  async (kind) => {
    const controller = new AbortController();
    const attempt = {
      runId: "reused-run",
      agentId: "main",
      sessionId: "original-session",
      abortSignal: controller.signal,
    };
    const host = await createAdmittedHostCapabilityTestFixture(attempt);
    hosts.push(host);
    const bind = host.hostCapabilities.bindToolExecution!;
    const accepted = bind({ toolName: "exec", toolCallId: "pending" });
    if (kind === "close") {
      host.closeHost();
    }
    if (kind === "abort") {
      controller.abort();
    }
    if (kind === "release") {
      host.closeAdmission();
    }
    if (kind === "replace") {
      hosts.push(
        await createAdmittedHostCapabilityTestFixture({
          ...attempt,
          sessionId: "replacement-session",
        }),
      );
    }
    expect(() => bind({ toolName: "exec", toolCallId: "new" })).toThrow();
    expect(() => accepted.started()).toThrow();
    const events: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => events.push(event));
    try {
      const outcome = {
        type: "tool.execution.error" as const,
        durationMs: 0,
        errorCategory: "before_tool_call",
        agentId: "forged-agent",
        sessionId: "forged-session",
        runId: "forged-run",
        toolOwner: "forged-plugin",
        toolCallId: "forged-call",
        privateData: { secret: "must-not-leak" },
      };
      accepted.finished(outcome);
      expect(events).toEqual([
        expect.objectContaining({
          agentId: "main",
          sessionId: "original-session",
          runId: "reused-run",
          toolCallId: "pending",
          toolOwner: "codex",
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain("forged");
      expect(JSON.stringify(events)).not.toContain("must-not-leak");
    } finally {
      stop();
    }
  },
);

it("uses the existing retained policy owner, then revokes new reports on release", async () => {
  const host = await createAdmittedHostCapabilityTestFixture({
    runId: "retained-reporter",
    agentId: "main",
  });
  hosts.push(host);
  const retained = retainBeforeToolCallForNativeHookRelay(host.hostCapabilities.runBeforeToolCall);
  expect(retained?.bindToolExecution).toBeTypeOf("function");
  if (!retained?.bindToolExecution) {
    throw new Error("missing retained reporting capability");
  }
  host.closeHost();
  host.closeAdmission();
  const report = retained.bindToolExecution({ toolName: "exec", toolCallId: "accepted-child" });
  retained.release();
  expect(() =>
    retained.bindToolExecution!({ toolName: "exec", toolCallId: "new-child" }),
  ).toThrow();
  expect(() => report.started()).toThrow();
  expect(() =>
    report.finished({
      type: "tool.execution.error",
      durationMs: 1,
      errorCategory: "before_tool_call",
      terminalReason: "cancelled",
    }),
  ).not.toThrow();
});
