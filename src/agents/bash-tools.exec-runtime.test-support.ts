import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { dispatchInboundMessageWithRoutedChannelDispatcher } from "../auto-reply/dispatch.js";
import { onAgentEvent } from "../infra/agent-events.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import type { ManagedRun } from "../process/supervisor/index.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { ExecApprovalFollowupFactory } from "./bash-tools.exec-types.js";

export function createDeferredExecDispatchMock(label = "notification") {
  return {
    dispatchInboundMessageWithRoutedChannelDispatcher: vi.fn<
      typeof dispatchInboundMessageWithRoutedChannelDispatcher
    >(async ({ replyOptions }) => {
      const lifecycle = expectDefined(replyOptions?.turnAdoptionLifecycle, `${label} lifecycle`);
      const signal = expectDefined(lifecycle.abortSignal, `${label} cancellation`);
      lifecycle.onDeferred?.();
      const onAbort = async () => {
        try {
          await lifecycle.onAbandoned?.();
        } finally {
          await lifecycle.onSettled?.();
        }
      };
      signal.addEventListener("abort", () => void onAbort(), { once: true });
      if (signal.aborted) {
        await onAbort();
      }
      return {
        deferredToActiveRun: "followup",
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    }),
  };
}

export function captureProcessUnhandledRejections() {
  const reasons: unknown[] = [];
  const originalProcessEmit = process.emit.bind(process);
  const processEmit = vi.spyOn(process, "emit").mockImplementation((event, ...args) => {
    if (event === "unhandledRejection") {
      reasons.push(args[0]);
      return true;
    }
    return originalProcessEmit(event, ...args);
  });
  return { reasons, restore: () => processEmit.mockRestore() };
}

export type HeldSupervisorExit = {
  wait: Promise<void>;
  waitStarted: Promise<void>;
  markStarted: () => void;
  release: () => void;
};

let heldSupervisorExit: (HeldSupervisorExit & { claimed: boolean }) | undefined;

function holdNextSupervisorExit(): Pick<HeldSupervisorExit, "waitStarted" | "release"> {
  if (heldSupervisorExit) {
    throw new Error("a supervisor exit is already held");
  }
  const exit = createDeferred();
  const started = createDeferred();
  const gate = {
    claimed: false,
    wait: exit.promise,
    waitStarted: started.promise,
    markStarted: started.resolve,
    release: () => {
      if (heldSupervisorExit === gate) {
        heldSupervisorExit = undefined;
      }
      exit.resolve();
    },
  };
  heldSupervisorExit = gate;
  return gate;
}

export function takeHeldSupervisorExit(): HeldSupervisorExit | undefined {
  if (!heldSupervisorExit || heldSupervisorExit.claimed) {
    return undefined;
  }
  heldSupervisorExit.claimed = true;
  return heldSupervisorExit;
}

export async function withHeldSupervisorExit<T>(
  run: (exit: Pick<HeldSupervisorExit, "waitStarted">) => Promise<T>,
  settle: () => Promise<void>,
): Promise<T> {
  vi.useFakeTimers();
  try {
    return await run(holdNextSupervisorExit());
  } finally {
    heldSupervisorExit?.release();
    try {
      await settle();
    } finally {
      vi.useRealTimers();
    }
  }
}

export function createRunExit(overrides: Partial<RunExit> = {}): RunExit {
  return {
    reason: "exit",
    exitCode: 0,
    exitSignal: null,
    durationMs: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
    ...overrides,
  };
}

export function runtimeManagedRun(input: SpawnInput, stdout = ""): ManagedRun {
  if (stdout) {
    input.onStdout?.(stdout);
  }
  return {
    activity: { resultSettled: true, lastOutputAtMs: Date.now() },
    runId: input.runId ?? "test-run",
    pid: 1234,
    startedAtMs: Date.now(),
    stdin: { write: vi.fn(), end: vi.fn(), destroy: vi.fn() },
    cancel: vi.fn(),
    wait: vi.fn(async () => createRunExit()),
  };
}

// Register under the caller's describe so the original approval fixtures and cleanup own these cases.
export function registerGatewayApprovalEventCases({
  configurePlanBackedCommand,
  runGatewayAllowlist,
  approvalDecisionMock,
  approvalRouteFixture,
  approvalRouteMock,
  prepareDiagnosticsExport,
  expectPending,
  waitForFollowup,
  readFollowupTarget,
  requireSentFollowupText,
}: {
  configurePlanBackedCommand: (params: { command: string }) => Promise<unknown>;
  runGatewayAllowlist: (
    params: Partial<
      Parameters<typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist>[0]
    > & { command: string },
  ) => ReturnType<typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist>;
  approvalDecisionMock: { mockResolvedValue: (value: string) => unknown };
  approvalRouteFixture: { id: string };
  approvalRouteMock: unknown;
  prepareDiagnosticsExport: (output: string) => void;
  expectPending: (
    result: Awaited<
      ReturnType<typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist>
    >,
  ) => void;
  waitForFollowup: () => Promise<void>;
  readFollowupTarget: () => unknown;
  requireSentFollowupText: () => string;
}) {
  it("publishes and records the approved Guardian review on its exec call", async () => {
    const assessment = { decision: "allow-once", risk: "low", rationale: "read-only" } as const;
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    const review = createDeferredCore<Awaited<ReturnType<ExecAutoReviewer>>>();
    const autoReviewer = vi.fn<ExecAutoReviewer>(() => review.promise);
    const reviews: Array<Record<string, unknown>> = [];
    const publicationOrder: string[] = [];
    const onApprovalReview = vi.fn((value: { status: string }) => {
      publicationOrder.push(`stored:${value.status}`);
    });
    const unsubscribe = onAgentEvent((event) => {
      if (
        event.runId === "run-review" &&
        event.stream === "tool" &&
        event.data.phase === "review"
      ) {
        publicationOrder.push(`emitted:${String(event.data.approvalReviewOutcome)}`);
        reviews.push(event.data);
      }
    });
    try {
      const pending = runGatewayAllowlist({
        command,
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        runId: "run-review",
        toolCallId: "tool-review",
        onApprovalReview,
      });
      await vi.waitFor(() => expect(autoReviewer).toHaveBeenCalledOnce());
      expect(reviews).toMatchObject([
        {
          toolCallId: "tool-review",
          approvalReviewOutcome: "reviewing",
          review: { id: "guardian:tool-review", label: "Guardian", status: "in_progress" },
        },
      ]);
      review.resolve(assessment);
      const result = await pending;
      expect(reviews.map((event) => event.approvalReviewOutcome)).toEqual([
        "reviewing",
        "approved",
      ]);
      expect(reviews[1]).toMatchObject({
        toolCallId: "tool-review",
        review: { id: "guardian:tool-review", label: "Guardian", status: "approved" },
      });
      expect(publicationOrder).toEqual([
        "emitted:reviewing",
        "stored:approved",
        "emitted:approved",
      ]);
      expect(approvalRouteMock).not.toHaveBeenCalled();
      expect(result.deniedResult).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it("emits inline approval park and clear events for a denial", async () => {
    approvalDecisionMock.mockResolvedValue("deny");
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === "run-inline" && event.stream === "lifecycle") {
        events.push(event.data);
      }
    });

    try {
      await runGatewayAllowlist({
        command: "pwd",
        turnSourceChannel: "webchat",
        runId: "run-inline",
        toolCallId: "tool-inline",
        sessionKey: "agent:main:main",
        sessionId: "session-inline",
      });
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([
      { phase: "waiting-approval", approvalId: approvalRouteFixture.id, toolCallId: "tool-inline" },
      {
        phase: "approval-resolved",
        approvalId: approvalRouteFixture.id,
        toolCallId: "tool-inline",
      },
    ]);
  });

  it("keeps webchat diagnostics approvals as direct pasteable followups", async () => {
    prepareDiagnosticsExport(
      JSON.stringify({
        path: "/tmp/openclaw-diagnostics.zip",
        bytes: 1234,
        manifest: {
          privacy: {
            payloadFree: true,
            rawLogsIncluded: false,
            notes: ["Logs keep operational summaries."],
          },
        },
      }),
    );

    const approvalFollowup = vi.fn<ExecApprovalFollowupFactory>(
      async () => "Synthetic harness diagnostics: thread-1",
    );

    const result = await runGatewayAllowlist({
      command: "openclaw gateway diagnostics export --json",
      trigger: "diagnostics",
      approvalFollowupMode: "direct",
      approvalFollowup,
      turnSourceChannel: "webchat",
    });
    expectPending(result);
    await waitForFollowup();

    expect(readFollowupTarget()).toMatchObject({ direct: true });
    const followupText = requireSentFollowupText();
    expect(followupText).toContain("Diagnostics export created.");
    expect(followupText).toContain("Path: /tmp/openclaw-diagnostics.zip");
    expect(followupText).toContain("Size: 1234 bytes");
    expect(followupText).toContain("Privacy:\n- payload-free: yes\n- raw logs included: no");
    expect(followupText).toContain("- Logs keep operational summaries.");
    expect(followupText).toContain("Synthetic harness diagnostics: thread-1");
    expect(approvalFollowup.mock.calls[0]?.[0]).toMatchObject({
      approvalId: approvalRouteFixture.id,
      sessionId: "sess-1",
      trigger: "diagnostics",
      outcome: { status: "completed", exitCode: 0 },
    });
  });
}
