import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { buildSlackProgressStreamChunks } from "./progress-blocks.js";
import { toolLine } from "./progress-blocks.test-helpers.js";

function planUpdate(title: string) {
  return { type: "plan_update", title };
}

function expectTaskUpdate(task: unknown, fields: { id: unknown; title: string; status: string }) {
  expect(task).toEqual({
    type: "task_update",
    id: fields.id,
    title: fields.title,
    status: fields.status,
  });
}

describe("native Slack reasoning card chunks", () => {
  it("renders reasoning cards with their text as the title, capped at 250 characters", () => {
    const long = `🧠 ${"reason ".repeat(60).trim()}`;
    const chunks = buildSlackProgressStreamChunks({
      title: "Working",
      lines: [
        {
          id: "reasoning:1",
          kind: "item",
          label: "Reasoning",
          text: "🧠 Reading the handler first.",
          status: "completed",
          prefix: false,
        },
        { id: "reasoning:2", kind: "item", label: "Reasoning", text: long, prefix: false },
      ],
    });
    const tasks = chunks?.filter((chunk) => chunk.type === "task_update") ?? [];
    expect(tasks).toHaveLength(2);
    expectTaskUpdate(tasks[0], {
      id: expect.stringMatching(/^reasoning_1_[a-f0-9]{8}$/u),
      title: "🧠 Reading the handler first.",
      status: "complete",
    });
    const open = tasks[1] as { title: string; status: string };
    expect(open.status).toBe("in_progress");
    expect(open.title.length).toBe(250);
    expect(open.title.endsWith("…")).toBe(true);
    expect(open.title.startsWith("🧠 reason reason")).toBe(true);
  });

  it("never lends a reasoning card's text to the plan headline", () => {
    const reasoning: ChannelProgressDraftLine = {
      id: "reasoning:1",
      kind: "item",
      label: "Reasoning",
      text: "🧠 Considering the transport choice.",
      prefix: false,
    };
    expect(buildSlackProgressStreamChunks({ lines: [reasoning] })?.[0]).toEqual(
      planUpdate("Thinking"),
    );
    expect(
      buildSlackProgressStreamChunks({
        lines: [toolLine("pnpm test"), { ...reasoning, id: "reasoning:2" }],
      })?.[0],
    ).toEqual(planUpdate("Exec — pnpm test"));
  });
});
