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

describe("native Slack progress command output details", () => {
  it("does not append a restated command detail when the command output line arrives", () => {
    // Slack appends task details; the output line's detail is the agent's item
    // title ("command <meta>") for the command the row already shows.
    const options = { commandText: "raw" as const };
    const start = buildChannelProgressDraftLine(
      {
        event: "tool",
        toolCallId: "call-1",
        name: "exec",
        phase: "start",
        args: { command: "pnpm test" },
      },
      options,
    );
    const commandItem = buildChannelProgressDraftLine(
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
      options,
    );
    const output = buildChannelProgressDraftLine(
      {
        event: "command-output",
        itemId: "command:call-1",
        toolCallId: "call-1",
        name: "exec",
        phase: "end",
        title: "command run tests",
        exitCode: 0,
      },
      options,
    );
    if (!start || !commandItem || !output) {
      throw new Error("expected exec progress lines");
    }
    let lines: ChannelProgressDraftLine[] = [];
    let snapshot = EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT;
    const emitted: unknown[][] = [];
    for (const line of [start, commandItem, output]) {
      lines = mergeChannelProgressDraftLine(lines, line, { maxLines: 8 });
      const reconciled = reconcileSlackNativeTaskChunks({
        previous: snapshot,
        chunks: buildSlackProgressStreamChunks({ lines }),
      });
      snapshot = reconciled.snapshot;
      emitted.push(reconciled.chunks ?? []);
    }

    expect(emitted[0]).toContainEqual(
      expect.objectContaining({ type: "task_update", status: "in_progress", details: "run tests" }),
    );
    const finished = (emitted[2] ?? []).filter(
      (chunk) => (chunk as { status?: string }).status === "complete",
    );
    expect(finished).toHaveLength(1);
    expect(finished[0]).not.toHaveProperty("details");
    const rows = [...snapshot.tasks.values()].filter((row) => row.details);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.details?.rendered === "run tests")).toBe(true);
  });

  it.each([
    { flags: ["pty"], exitCode: 0 },
    { flags: ["elevated"], exitCode: 1 },
    { flags: ["pty", "elevated"], exitCode: 0 },
  ])("does not append flagged details for $flags on exit $exitCode", ({ flags, exitCode }) => {
    const meta = ["run tests", ...flags].join(" · ");
    const detail = [...flags, "run tests"].join(" · ");
    // Item metadata includes the execution flags before completion arrives.
    const start = buildChannelProgressDraftLine(
      {
        event: "item",
        itemId: "tool:flagged",
        toolCallId: "flagged",
        itemKind: "tool",
        name: "exec",
        phase: "start",
        status: "running",
        meta,
      },
      { commandText: "raw" },
    );
    const output = buildChannelProgressDraftLine(
      {
        event: "command-output",
        itemId: "command:flagged",
        toolCallId: "flagged",
        name: "exec",
        phase: "end",
        title: "command " + meta,
        exitCode,
      },
      { commandText: "raw" },
    );
    if (!start || !output) {
      throw new Error("expected flagged command progress");
    }
    const first = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: buildSlackProgressStreamChunks({ lines: [start] }),
    });
    const finished = reconcileSlackNativeTaskChunks({
      previous: first.snapshot,
      chunks: buildSlackProgressStreamChunks({
        lines: mergeChannelProgressDraftLine([start], output, { maxLines: 8 }),
      }),
    });
    expect(finished.snapshot.tasks.size).toBe(1);
    expect([...finished.snapshot.tasks.values()][0]?.details?.rendered).toBe(detail);
    const update = finished.chunks?.find((chunk) => chunk.type === "task_update");
    expect(update).toMatchObject({ status: exitCode === 0 ? "complete" : "error" });
    expect(update).not.toHaveProperty("details");
    expect(finished.chunks?.some((chunk) => chunk.type === "plan_update")).toBe(false);
  });

  it("sends the command output detail when the row showed none", () => {
    const start = buildChannelProgressDraftLine(
      { event: "tool", toolCallId: "call-1", name: "exec", phase: "start" },
      { commandText: "raw" },
    );
    const output = buildChannelProgressDraftLine(
      {
        event: "command-output",
        itemId: "command:call-1",
        toolCallId: "call-1",
        name: "exec",
        phase: "end",
        title: "command pnpm test",
        exitCode: 0,
      },
      { commandText: "raw" },
    );
    if (!start || !output) {
      throw new Error("expected exec progress lines");
    }
    const first = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: buildSlackProgressStreamChunks({ lines: [start] }),
    });
    const lines = mergeChannelProgressDraftLine([start], output, { maxLines: 8 });
    const finished = reconcileSlackNativeTaskChunks({
      previous: first.snapshot,
      chunks: buildSlackProgressStreamChunks({ lines }),
    });

    expect(first.chunks?.[1]).not.toHaveProperty("details");
    expect(finished.chunks).toContainEqual(
      expect.objectContaining({
        type: "task_update",
        status: "complete",
        details: "command pnpm test",
      }),
    );
  });
});
