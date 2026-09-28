import {
  buildChannelProgressDraftLine,
  type ChannelProgressDraftLine,
  mergeChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import {
  buildSlackProgressStreamChunks,
  EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
  reconcileSlackNativeTaskChunks,
} from "./progress-blocks.js";

function streamProgress(inputs: Parameters<typeof buildChannelProgressDraftLine>[0][]) {
  let lines: ChannelProgressDraftLine[] = [];
  let snapshot = EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT;
  return inputs.map((input) => {
    const line = buildChannelProgressDraftLine(input, { commandText: "raw" });
    if (!line) {
      throw new Error("expected exec progress line");
    }
    lines = mergeChannelProgressDraftLine(lines, line, { maxLines: 8 });
    const reconciled = reconcileSlackNativeTaskChunks({
      previous: snapshot,
      chunks: buildSlackProgressStreamChunks({ lines }),
    });
    snapshot = reconciled.snapshot;
    return reconciled;
  });
}

function commandOutput(title: string, exitCode = 0) {
  return {
    event: "command-output" as const,
    itemId: "command:call-1",
    toolCallId: "call-1",
    name: "exec",
    phase: "end" as const,
    title,
    exitCode,
  };
}

describe("native Slack progress command output details", () => {
  it("does not append a restated command detail when the command output line arrives", () => {
    const emitted = streamProgress([
      {
        event: "tool",
        toolCallId: "call-1",
        name: "exec",
        phase: "start",
        args: { command: "pnpm test" },
      },
      {
        event: "item",
        itemId: "command:call-1",
        itemKind: "command",
        toolCallId: "call-1",
        name: "exec",
        phase: "start",
        status: "running",
        meta: "run tests",
      },
      commandOutput("command run tests"),
    ]);
    expect(emitted[0]?.chunks).toContainEqual(
      expect.objectContaining({ type: "task_update", status: "in_progress", details: "run tests" }),
    );
    const finished = emitted[2]?.chunks?.filter(
      (chunk) => chunk.type === "task_update" && chunk.status === "complete",
    );
    expect(finished).toHaveLength(1);
    expect(finished?.[0]).not.toHaveProperty("details");
    const rows = [...(emitted[2]?.snapshot.tasks.values() ?? [])].filter((row) => row.details);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.details?.rendered === "run tests")).toBe(true);
  });

  it("does not append flagged command details on failure", () => {
    const emitted = streamProgress([
      {
        event: "item",
        itemId: "tool:call-1",
        toolCallId: "call-1",
        itemKind: "tool",
        name: "exec",
        phase: "start",
        status: "running",
        meta: "run tests · pty · elevated",
      },
      commandOutput("command run tests · pty · elevated", 1),
    ]);
    const finished = emitted[1];
    expect(finished?.snapshot.tasks.size).toBe(1);
    expect([...(finished?.snapshot.tasks.values() ?? [])][0]?.details?.rendered).toBe(
      "pty · elevated · run tests",
    );
    const update = finished?.chunks?.find((chunk) => chunk.type === "task_update");
    expect(update).toMatchObject({ status: "error" });
    expect(update).not.toHaveProperty("details");
    expect(finished?.chunks?.some((chunk) => chunk.type === "plan_update")).toBe(false);
  });

  it("sends the command output detail when the row showed none", () => {
    const [first, finished] = streamProgress([
      { event: "tool", toolCallId: "call-1", name: "exec", phase: "start" },
      commandOutput("command pnpm test"),
    ]);
    expect(first?.chunks?.[1]).not.toHaveProperty("details");
    expect(finished?.chunks).toContainEqual(
      expect.objectContaining({
        type: "task_update",
        status: "complete",
        details: "command pnpm test",
      }),
    );
  });
});
