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
import { itemLine, progressLine, toolLine } from "./progress-blocks.test-helpers.js";

function planUpdate(title: string) {
  return { type: "plan_update", title };
}

function taskUpdate(
  id: unknown,
  title: string,
  status: "pending" | "in_progress" | "complete" | "error",
  extra?: Record<string, unknown>,
) {
  return { type: "task_update", id, title, status, ...extra };
}

function contentTaskId(prefix: string) {
  return expect.stringMatching(new RegExp(`^${prefix}_[a-f0-9]{8}_1$`, "u"));
}

type ProgressParams = Parameters<typeof buildSlackProgressStreamChunks>[0];
function createStream() {
  let previous = EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT;
  return (params: ProgressParams, finalStatus?: "complete" | "error") => {
    const result = reconcileSlackNativeTaskChunks({
      previous,
      chunks: buildSlackProgressStreamChunks(params),
      finalStatus,
    });
    previous = result.snapshot;
    return result;
  };
}
function approval(detail: string): ChannelProgressDraftLine {
  return {
    id: `approval:${detail.toLowerCase()}`,
    kind: "approval",
    label: "Approval",
    detail,
    status: "requested",
    text: `Approval required: ${detail}`,
  };
}
function command(label: string, detail: string, status: string): ChannelProgressDraftLine {
  return {
    id: `command:${label.toLowerCase()}`,
    kind: "command-output",
    label,
    detail,
    status,
    text: `${label}: ${detail} · ${status}`,
  };
}

describe("native Slack progress stream chunks", () => {
  it("clears an empty native snapshot once while retaining settled task history", () => {
    const first = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: [
        { type: "plan_update", title: "Working" },
        { type: "task_update", id: "read", title: "Read", status: "in_progress" },
      ],
    });
    const cleared = reconcileSlackNativeTaskChunks({ previous: first.snapshot, chunks: undefined });
    expect(cleared.chunks).toEqual([
      planUpdate("Thinking"),
      taskUpdate("read", "Read", "complete"),
    ]);
    const repeated = reconcileSlackNativeTaskChunks({
      previous: cleared.snapshot,
      chunks: undefined,
    });
    expect(repeated.chunks).toBeUndefined();
    expect([...repeated.snapshot.tasks.values()]).toEqual([{ title: "Read", status: "complete" }]);
  });

  it("preserves full native plan snapshots beyond the Block Kit block limit", () => {
    const chunks = buildSlackProgressStreamChunks({
      title: "Working",
      lines: [],
      plan: Array.from({ length: 51 }, (_, index) => ({
        step: `Step ${index}`,
        status: "pending" as const,
      })),
    });
    expect(chunks).toContainEqual(taskUpdate("plan_step_1", "Step 0", "pending"));
    expect(chunks).toContainEqual(taskUpdate("plan_step_51", "Step 50", "pending"));
  });

  it("updates a retained older native tool when it fails after fifty newer rows", () => {
    const older: ChannelProgressDraftLine = {
      id: "command:older",
      kind: "command-output",
      label: "Build",
      status: "running",
      text: "Build running",
    };
    const params = { title: "Working", lines: [older] };
    const update = createStream();
    const first = update(params);
    const newer = Array.from({ length: 50 }, (_, index) => progressLine(index));
    update({ ...params, lines: [older, ...newer] });
    const failed = update({
      ...params,
      lines: [{ ...older, status: "exit 1", text: "Build exit 1" }, ...newer],
    });
    const originalId = [...first.snapshot.tasks.keys()][0];
    expect(failed.chunks).toContainEqual(
      taskUpdate(originalId, "Build", "error", { output: "exit 1" }),
    );
  });

  it.each([
    { summaryRow: false, withPlan: true },
    { summaryRow: true, withPlan: false },
  ])(
    "preserves independent attention identities through reorder and resolution (quiet=$summaryRow, plan=$withPlan)",
    ({ summaryRow, withPlan }) => {
      const deploy = approval("Deploy");
      const restart = approval("Restart");
      const build = command("Build", "run build", "exit 1");
      const test = command("Test", "run tests", "exit 2");
      const params = {
        title: "Working",
        summaryRow,
        plan: withPlan ? [{ step: "Verify", status: "in_progress" as const }] : undefined,
        lines: [deploy, build, restart, test],
      };
      const update = createStream();
      const first = update(params);
      const attention = [...first.snapshot.tasks.values()].filter(
        (task) => task.status === "pending" || task.status === "error",
      );
      const failureRows = summaryRow
        ? []
        : [
            expect.objectContaining({ title: expect.stringContaining("Build"), status: "error" }),
            expect.objectContaining({ title: expect.stringContaining("Test"), status: "error" }),
          ];
      expect(attention).toHaveLength(summaryRow ? 2 : 4);
      expect(attention).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: "Approval required: Deploy", status: "pending" }),
          expect.objectContaining({ title: "Approval required: Restart", status: "pending" }),
          ...failureRows,
        ]),
      );
      const reordered = update({ ...params, lines: params.lines.toReversed() });
      expect(reordered.chunks).toBeUndefined();
      const withoutPlan = update({ ...params, plan: undefined });
      for (const [id, row] of reordered.snapshot.tasks) {
        if (row.status === "error") {
          expect(withoutPlan.snapshot.tasks.get(id)?.status).toBe("error");
        }
      }
      const busy = update({
        ...params,
        lines: [...params.lines, ...Array.from({ length: 50 }, (_, index) => progressLine(index))],
      });
      expect(
        [...busy.snapshot.tasks.values()].filter((task) => task.status === "pending"),
      ).toHaveLength(2);
      const resolved = update({ ...params, lines: [restart, test] });
      const resolvedRows = [...resolved.snapshot.tasks.values()];
      expect(resolvedRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: "Approval required: Deploy", status: "complete" }),
          expect.objectContaining({ title: "Approval required: Restart", status: "pending" }),
          ...failureRows,
        ]),
      );
      const finished = update(
        {
          ...params,
          lines: [restart, test],
          finalInProgressStatus: "complete",
        },
        "complete",
      );
      expect(
        [...finished.snapshot.tasks.values()].every((task) => task.status === "complete"),
      ).toBe(true);
    },
  );

  it("shows terminal failure after every authored milestone completed", () => {
    expect(
      buildSlackProgressStreamChunks({
        title: "Checking the workspace",
        lines: [],
        finalInProgressStatus: "error",
        plan: [{ step: "Run checks", status: "completed" }],
      }),
    ).toEqual([
      planUpdate("Checking the workspace"),
      taskUpdate("plan_step_1", "Run checks", "complete"),
      taskUpdate("openclaw_attention", "Failed", "error"),
    ]);
  });

  it.each([
    ["empty", false, "error"],
    ["approval", false, "error"],
    ["approval", true, "complete"],
    ["failed", false, "complete"],
  ] as const)(
    "settles an untitled %s snapshot without losing the turn outcome (quiet=%s, final=%s)",
    (activity, summaryRow, finalInProgressStatus) => {
      const lines: ChannelProgressDraftLine[] =
        activity === "empty"
          ? []
          : activity === "approval"
            ? [approval("Deploy")]
            : [{ ...toolLine("run checks"), status: "exit 1" }];
      const update = createStream();
      const first = update({ lines, summaryRow });
      if (activity === "empty") {
        expect(first.chunks).toBeUndefined();
      }
      const final = update({ lines, summaryRow, finalInProgressStatus }, finalInProgressStatus);
      const tasks = [...final.snapshot.tasks.values()];
      expect(tasks.filter((task) => task.status === "error")).toHaveLength(
        finalInProgressStatus === "error" ? 1 : 0,
      );
      expect(tasks.every((task) => task.status === "complete" || task.status === "error")).toBe(
        true,
      );
      if (activity === "approval") {
        expect(final.chunks).toContainEqual(
          taskUpdate(
            expect.stringMatching(/^openclaw-attention-/u),
            "Approval required: Deploy",
            "complete",
          ),
        );
      }
      if (finalInProgressStatus === "error") {
        expect(final.chunks).toContainEqual(taskUpdate("openclaw_attention", "Failed", "error"));
      }
    },
  );

  it.each([
    [false, "complete", "Checking the workspace", "Checking the workspace"],
    [true, "error", "Checking the workspace", "Run checks"],
    [false, "complete", undefined, "Completed"],
    [false, "error", undefined, "Failed"],
  ] as const)(
    "settles quiet work rows without command failures (plan=%s, final=%s, title=%s)",
    (withPlan, finalInProgressStatus, title, terminalTitle) => {
      const params = {
        title,
        summaryRow: true,
        plan: withPlan ? [{ step: "Run checks", status: "in_progress" as const }] : undefined,
        lines: [{ ...command("Bash", "run checks", "exit 1"), id: undefined }],
      };
      const update = createStream();
      const first = update(params);
      expect(first.chunks).toEqual([
        planUpdate(title ?? "Working"),
        withPlan
          ? taskUpdate("plan_step_1", "Run checks", "in_progress")
          : taskUpdate("openclaw_summary", title ?? "Working", "in_progress"),
      ]);
      const final = update({ ...params, finalInProgressStatus });
      expect([...final.snapshot.tasks.values()]).toEqual([
        { title: terminalTitle, status: finalInProgressStatus },
      ]);
    },
  );

  it("terminalizes orphaned rows when a plan snapshot shrinks", () => {
    const update = createStream();
    update({
      title: "Implementation",
      lines: [],
      plan: [
        { step: "Inspect code", status: "completed" },
        { step: "Patch code", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    });
    const shrunk = update({
      title: "Implementation",
      lines: [],
      plan: [{ step: "Inspect code", status: "in_progress" }],
    });

    expect(shrunk.chunks).toEqual([
      taskUpdate("plan_step_1", "Inspect code", "in_progress"),
      taskUpdate("plan_step_2", "Patch code", "complete"),
      taskUpdate("plan_step_3", "Run tests", "complete"),
    ]);
  });

  it("keeps content-derived task ids stable when a rolling line window shifts", () => {
    const update = createStream();
    const first = update({ lines: [itemLine("first task"), itemLine("shared task")] });
    const shifted = update({ lines: [itemLine("shared task"), itemLine("new task")] });
    const firstShared = [...first.snapshot.tasks].find(([, task]) => task.title === "shared task");
    const shiftedShared = [...shifted.snapshot.tasks].find(
      ([, task]) => task.title === "shared task",
    );

    expect(firstShared?.[0]).toBeDefined();
    expect(shiftedShared?.[0]).toBe(firstShared?.[0]);
    expect(shifted.chunks).toContainEqual(
      taskUpdate(contentTaskId("item"), "first task", "complete"),
    );
  });

  it("keeps a singleton content-derived task id when an identical line joins", () => {
    const singletonChunks = buildSlackProgressStreamChunks({
      lines: [itemLine("same task")],
    });
    const duplicateChunks = buildSlackProgressStreamChunks({
      lines: [itemLine("same task"), itemLine("same task")],
    });
    const singletonTasks = (singletonChunks ?? []).filter((chunk) => chunk.type === "task_update");
    const duplicateTasks = (duplicateChunks ?? []).filter((chunk) => chunk.type === "task_update");

    expect(singletonTasks).toHaveLength(1);
    expect(singletonTasks[0]).toEqual(
      taskUpdate(expect.stringMatching(/^item_[a-f0-9]{8}_1$/u), "same task", "in_progress"),
    );
    expect(duplicateTasks).toHaveLength(2);
    expect(duplicateTasks[0]?.id).toBe(singletonTasks[0]?.id);
    expect(duplicateTasks[1]).toEqual(
      taskUpdate(expect.stringMatching(/^item_[a-f0-9]{8}_2$/u), "same task", "in_progress"),
    );
  });

  it("streams task details and output as append-only deltas", () => {
    // Slack concatenates details/output per task, so resend only the unsent suffix.
    const line = (status: string): ChannelProgressDraftLine => ({
      id: "call-1",
      kind: "command-output",
      label: "Bash",
      detail: "pnpm test",
      status,
      text: `Bash: pnpm test · ${status}`,
      toolName: "bash",
    });
    const update = createStream();
    const first = update({ title: "Shelling", lines: [line("running")] });
    const repeated = update({ title: "Shelling", lines: [line("running")] });
    const failed = update({ title: "Shelling", lines: [line("exit 1")] });
    const finished = update({
      title: "Shelling",
      lines: [line("exit 1")],
      diffStat: { files: 2, added: 5, removed: 2 },
      finalInProgressStatus: "complete",
    });

    const taskId = expect.stringMatching(/^call_1_[a-f0-9]{8}$/u);
    expect(first.chunks).toEqual([
      planUpdate("Shelling"),
      taskUpdate(taskId, "Bash", "in_progress", { details: "pnpm test" }),
    ]);
    expect(repeated.chunks).toBeUndefined();
    expect(failed.chunks).toEqual([taskUpdate(taskId, "Bash", "error", { output: "exit 1" })]);
    expect(finished.chunks).toEqual([
      taskUpdate(taskId, "Recovered: Bash", "complete", { output: " · +5 −2" }),
    ]);
  });

  it("settles a recovered failure after its tool row leaves the rolling window", () => {
    const failed = reconcileSlackNativeTaskChunks({
      previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
      chunks: [
        {
          type: "task_update",
          id: "failed-call",
          title: "Bash",
          status: "error",
          output: "exit 1",
        },
      ],
    });
    const shifted = reconcileSlackNativeTaskChunks({
      previous: failed.snapshot,
      chunks: [{ type: "task_update", id: "next-call", title: "Read", status: "in_progress" }],
    });
    const finished = reconcileSlackNativeTaskChunks({
      previous: shifted.snapshot,
      chunks: [{ type: "task_update", id: "next-call", title: "Read", status: "complete" }],
      finalStatus: "complete",
    });
    expect(finished.chunks).toEqual([
      taskUpdate("next-call", "Read", "complete"),
      taskUpdate("failed-call", "Recovered: Bash", "complete"),
    ]);
    expect([...finished.snapshot.tasks.values()].every((task) => task.status === "complete")).toBe(
      true,
    );
  });

  it("uses configured max line chars for native task details", () => {
    const detail = "run tests in /Users/example/Projects/openclaw/packages/very/deep/path/example";
    expect(
      buildSlackProgressStreamChunks({
        title: "Shelling...",
        maxLineChars: 64,
        lines: [{ kind: "tool", label: "Exec", detail, text: `Exec: ${detail}` }],
      }),
    ).toEqual([
      planUpdate("Shelling..."),
      taskUpdate(contentTaskId("tool"), "Exec", "in_progress", {
        details: "run tests in /Users/example/P…aw/packages/very/deep/path/example",
      }),
    ]);
  });

  it("separates inline file deltas from native task details", () => {
    expect(
      buildSlackProgressStreamChunks({ lines: [toolLine("src/native-card.ts +4 -2", "Write")] }),
    ).toEqual([
      planUpdate("Write — src/native-card.ts"),
      taskUpdate(contentTaskId("write"), "Write", "in_progress", {
        details: "src/native-card.ts",
        output: "+4 −2",
      }),
    ]);
  });

  it("keeps a native status headline when no task rows are visible", () => {
    expect(buildSlackProgressStreamChunks({ title: "Checking the workspace", lines: [] })).toEqual([
      planUpdate("Checking the workspace"),
    ]);
  });

  it("caps explicit native plan titles to Slack chunk limits", () => {
    const chunks = buildSlackProgressStreamChunks({
      title: `Shelling ${"x".repeat(300)}`,
      lines: [toolLine("run tests")],
    });
    const title =
      chunks?.[0] && typeof chunks[0] === "object" && "title" in chunks[0]
        ? chunks[0].title
        : undefined;

    expect(title).toHaveLength(256);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("puts task detail, diff output, and the session source on the terminal row", () => {
    const link = { url: "https://team.openclaw.ai/openclaw/chat/main", text: "Open in OpenClaw" };
    expect(
      buildSlackProgressStreamChunks({
        finalInProgressStatus: "complete",
        lines: [toolLine("src/native-card.ts", "Write")],
        diffStat: { files: 1, added: 3, removed: 1 },
        sessionLinks: [link],
      }),
    ).toEqual([
      planUpdate("Write — src/native-card.ts"),
      taskUpdate(contentTaskId("write"), "Write", "complete", {
        details: "src/native-card.ts",
        output: "+3 −1",
        sources: [{ type: "url_source", ...link }],
      }),
    ]);
  });
});

function streamProgress(inputs: Parameters<typeof buildChannelProgressDraftLine>[0][]) {
  let lines: ChannelProgressDraftLine[] = [];
  const update = createStream();
  return inputs.map((input) => {
    const line = buildChannelProgressDraftLine(input, { commandText: "raw" });
    if (!line) {
      throw new Error("expected exec progress line");
    }
    lines = mergeChannelProgressDraftLine(lines, line, { maxLines: 8 });
    return update({ lines });
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
  it("keeps one task across tool, command, and output without repeating details", () => {
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
    expect([...(emitted[2]?.snapshot.tasks.keys() ?? [])]).toHaveLength(1);
    const taskId = expect.stringMatching(/^tool_call_1_[a-f0-9]{8}$/u);
    expect(emitted[0]?.chunks).toContainEqual(
      taskUpdate(taskId, "Exec", "in_progress", { details: "run tests" }),
    );
    expect(emitted[1]?.chunks).toBeUndefined();
    expect(emitted[2]?.chunks).not.toContainEqual(
      expect.objectContaining({ type: "task_update", status: "in_progress" }),
    );
    const finished = emitted[2]?.chunks?.filter(
      (chunk) => chunk.type === "task_update" && chunk.status === "complete",
    );
    expect(finished).toHaveLength(1);
    expect(finished?.[0]).toMatchObject({ id: taskId, status: "complete" });
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
