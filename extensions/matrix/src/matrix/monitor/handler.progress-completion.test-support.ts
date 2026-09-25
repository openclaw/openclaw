import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it, vi } from "vitest";
import type { MatrixConfig } from "../../types.js";

type ProgressCompletionHarness = {
  createStreamingHarness: (options: {
    streaming: "progress";
    previewToolProgressEnabled: boolean;
    accountConfig: MatrixConfig;
  }) => {
    dispatch: () => Promise<{
      opts: Pick<
        GetReplyOptions,
        "onItemEvent" | "onToolStart" | "onCommandOutput" | "onPatchSummary"
      >;
      finish: () => Promise<void>;
    }>;
  };
  sendSingleTextMessageMatrixMock: unknown;
  editMessageMatrixMock: unknown;
  singleTextMessageBody: () => unknown;
  mockCalls: (mock: unknown, label: string) => unknown[][];
  lastCallArg: (mock: unknown, argIndex: number, label: string) => unknown;
};

export function registerMatrixProgressCompletionTests(harness: ProgressCompletionHarness) {
  const {
    createStreamingHarness,
    sendSingleTextMessageMatrixMock,
    editMessageMatrixMock,
    singleTextMessageBody,
    mockCalls,
    lastCallArg,
  } = harness;
  it("replaces recovered Matrix command progress instead of leaving stale failed text", async () => {
    vi.useFakeTimers();
    const { dispatch } = createStreamingHarness({
      streaming: "progress",
      previewToolProgressEnabled: true,
      accountConfig: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Working" } },
      } as never,
    });
    const { opts, finish } = await dispatch();

    await opts.onItemEvent?.(
      projectAgentToolActivity({
        toolCallId: "call-1",
        name: "exec",
        phase: "result",
        status: "failed",
        meta: "run openclaw cron -> run jq (agent) failed",
      }),
    );
    await opts.onItemEvent?.(
      projectAgentToolActivity({
        toolCallId: "call-1",
        name: "exec",
        phase: "result",
        status: "failed",
        meta: "run openclaw cron -> run jq (agent) failed",
      }),
    );
    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(singleTextMessageBody()).toContain("failed");

    await opts.onCommandOutput?.({
      itemId: "command-1",
      toolCallId: "call-1",
      phase: "end",
      name: "exec",
      status: "completed",
      exitCode: 0,
    });
    await opts.onItemEvent?.(
      projectAgentToolActivity({
        toolCallId: "call-1",
        name: "exec",
        phase: "result",
        status: "completed",
        result: { details: { status: "completed", exitCode: 0 } },
      }),
    );

    await finish();
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      expect.stringContaining("Exec"),
      expect.any(Object),
    );
    const recoveredEdit = mockCalls(editMessageMatrixMock, "editMessageMatrix").find(
      ([, eventId, body]) => eventId === "$draft1" && typeof body === "string",
    );
    expect(recoveredEdit?.[2]).not.toContain("completed");
    expect(recoveredEdit?.[2]).not.toContain("failed");
    expect(recoveredEdit?.[2]).not.toContain("run openclaw cron -> run jq");
    vi.useRealTimers();
  });

  it("keeps Matrix tool progress free of terminal status text", async () => {
    vi.useFakeTimers();
    const { dispatch } = createStreamingHarness({
      streaming: "progress",
      previewToolProgressEnabled: true,
      accountConfig: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Working" } },
      } as never,
    });
    const { opts, finish } = await dispatch();

    await opts.onItemEvent?.(
      projectAgentToolActivity({
        toolCallId: "call-2",
        name: "exec",
        phase: "start",
        args: { command: "npm install" },
      }),
    );
    await opts.onToolStart?.({
      toolCallId: "call-2",
      name: "exec",
      phase: "start",
      args: { command: "npm install" },
    });
    await opts.onItemEvent?.(
      projectAgentToolActivity({
        toolCallId: "call-2",
        name: "exec",
        phase: "update",
        args: { command: "npm install" },
      }),
    );
    await opts.onToolStart?.({
      itemId: "fc-call-2",
      toolCallId: "call-2",
      name: "exec",
      phase: "update",
      args: { command: "npm install" },
    });
    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(singleTextMessageBody()).toContain("Exec");

    await opts.onItemEvent?.(
      projectAgentToolActivity({
        toolCallId: "call-2",
        name: "exec",
        phase: "update",
        meta: "install dependencies",
      }),
    );

    await opts.onCommandOutput?.({
      itemId: "fc-call-2-output",
      toolCallId: "call-2",
      phase: "end",
      name: "exec",
      status: "completed",
      exitCode: 0,
    });

    await opts.onItemEvent?.(
      projectAgentToolActivity({
        toolCallId: "call-2",
        name: "exec",
        phase: "result",
        status: "completed",
        result: { details: { status: "completed", exitCode: 0 } },
      }),
    );
    await finish();
    const completedEdit = mockCalls(editMessageMatrixMock, "editMessageMatrix").find(
      ([, eventId, body]) =>
        eventId === "$draft1" && typeof body === "string" && body.includes("completed"),
    );
    expect(completedEdit).toBeUndefined();
    expect(singleTextMessageBody()).toContain("Exec");
    vi.useRealTimers();
  });

  it("replaces the running Matrix patch row with its prepared completion", async () => {
    vi.useFakeTimers();
    const { dispatch } = createStreamingHarness({
      streaming: "progress",
      previewToolProgressEnabled: true,
      accountConfig: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Working" } },
      } as never,
    });
    const { opts, finish } = await dispatch();

    await opts.onItemEvent?.(
      projectAgentToolActivity({ toolCallId: "call-3", name: "apply_patch", phase: "update" }),
    );
    await opts.onItemEvent?.(
      projectAgentToolActivity({ toolCallId: "call-3", name: "apply_patch", phase: "update" }),
    );
    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(singleTextMessageBody()).toContain("Apply Patch: running");

    await opts.onPatchSummary?.({
      itemId: "patch:call-3",
      toolCallId: "call-3",
      phase: "end",
      name: "apply_patch",
      modified: ["extensions/matrix/src/matrix/monitor/handler.ts"],
      summary: "1 file modified",
    });

    await opts.onItemEvent?.(
      projectAgentToolActivity({
        toolCallId: "call-3",
        name: "apply_patch",
        phase: "result",
        status: "completed",
        result: {
          details: {
            summary: {
              added: [],
              modified: ["extensions/matrix/src/matrix/monitor/handler.ts"],
              deleted: [],
            },
          },
        },
      }),
    );
    await finish();
    const patchEdit = lastCallArg(editMessageMatrixMock, 2, "Matrix completed patch body");
    expect(patchEdit).toBe("Working\n\n`🩹 Apply Patch`");
    vi.useRealTimers();
  });
}
