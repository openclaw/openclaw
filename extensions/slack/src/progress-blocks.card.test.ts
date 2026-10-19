import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { buildSlackProgressCardBlocks } from "./progress-blocks.js";
import { itemLine, progressLine, toolLine } from "./progress-blocks.test-helpers.js";

type CardOptions = Parameters<typeof buildSlackProgressCardBlocks>[0];
const card = (options: Partial<CardOptions>) =>
  buildSlackProgressCardBlocks({ detailed: true, state: "working", lines: [], ...options });
const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const plain = (text: string) => ({
  type: "section",
  text: { type: "plain_text", text, emoji: false },
});
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const approval = (detail: string, label = "Approval"): ChannelProgressDraftLine => ({
  kind: "approval",
  label,
  text: label,
  detail,
  status: "requested",
});
const sessionLink = (text: string, url: string) => ({
  type: "actions",
  elements: [
    {
      type: "button",
      action_id: "openclaw:session_link",
      text: { type: "plain_text", text },
      url,
    },
  ],
});

describe("buildSlackProgressCardBlocks", () => {
  it.each<[boolean, CardOptions["state"]]>([
    [false, "working"],
    [false, "success"],
    [false, "error"],
    [true, "working"],
    [true, "success"],
    [true, "error"],
  ])("renders card layout (detailed=%s, state=%s)", (detailed, state) => {
    const link = { text: "Open work session", url: "https://example.com/session" };
    const blocks = card({
      detailed,
      state,
      title: "Implementing",
      narration: [{ text: "Checking the workspace." }, { text: "Read *literal*", format: "plain" }],
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "in_progress" },
      ],
      lines: [
        itemLine("Considering the change", "Reasoning"),
        toolLine("run tests"),
        { ...itemLine("Tool output"), toolName: "exec" },
        { ...toolLine("failed check"), status: "exit 1" },
        approval("Run checks"),
      ],
      toolCalls: 3,
      elapsedSeconds: 12,
      diffStat: { files: 4, added: 2, removed: 1 },
      sessionLinks: [link],
    });
    const headings = [...(state === "error" ? [plain("Failed")] : []), plain("Implementing")];
    const failure = `${state === "success" ? "Recovered: " : ""}Exec — failed check — exit 1`;
    const attention = [
      ...(detailed ? [failure] : []),
      ...(state === "working" ? ["Approval required: Run checks"] : []),
    ];
    expect(blocks).toEqual([
      ...headings,
      section("_Checking the workspace._"),
      plain("Read *literal*"),
      ...(detailed ? [section("✓ Inspect\n▸ Patch")] : []),
      section(
        detailed
          ? "_Considering the change_\nExec — run tests\nTool output"
          : "_Considering the change_",
      ),
      ...(attention.length ? [section(attention.join("\n"))] : []),
      ...(detailed
        ? [context(state === "working" ? "3 tools · 4 files +2 −1 · 12s" : "4 files +2 −1")]
        : []),
      ...(state !== "working" ? [sessionLink(link.text, link.url)] : []),
    ]);
    if (state !== "working") {
      expect(card({ state, title: "Implementing" })).toEqual(headings);
    }
  });

  it("omits detail placeholders from completed tools and preserves plain narration", () => {
    expect(
      card({
        state: "success",
        narration: [{ text: "Read *literal* <@U123>", format: "plain" }],
        lines: [{ ...toolLine(""), status: "completed" }],
        toolCalls: 1,
        elapsedSeconds: 2,
        diffStat: { files: 0, added: 0, removed: 0 },
      }),
    ).toEqual([plain("Read *literal* <@U123>"), section("Exec")]);
  });

  it("keeps plan selection, summary, and truncation budgets without emoji", () => {
    const blocks = card({
      maxLineChars: 20,
      plan: Array.from({ length: 51 }, (_, index) => ({
        step: index === 49 ? "Active step with a long description" : `Step ${index}`,
        status: index < 49 ? "completed" : index === 49 ? "in_progress" : "pending",
      })),
    });
    expect(blocks).toHaveLength(1);
    const text = blocks[0]?.type === "section" && "text" in blocks[0] ? blocks[0].text?.text : "";
    const lines = text?.split("\n") ?? [];
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("49/51 done");
    expect(lines[1]).toBe("✓ Step 2");
    expect(lines[48]).toMatch(/^▸ .*…/u);
    expect(lines[49]).toBe("▢ Step 50");
    expect(lines.every((line) => Array.from(line).length <= 20)).toBe(true);
  });

  it("retains independent approvals and failures in the card attention section", () => {
    const blocks = card({
      title: "Working",
      lines: [
        approval("", "Approve deploy"),
        approval("", "Approve restart"),
        { kind: "command-output", label: "Build", status: "exit 1", text: "Build exit 1" },
        { kind: "command-output", label: "Test", status: "exit 2", text: "Test exit 2" },
      ],
    });
    expect(blocks).toEqual([
      plain("Working"),
      section(
        "Approval required: Approve deploy\nApproval required: Approve restart\nBuild — exit 1\nTest — exit 2",
      ),
    ]);
  });

  it.each<[Partial<CardOptions>, string]>([
    [
      {
        lines: [
          itemLine("Compare <#C123> approaches 🔍"),
          itemLine("Checking **the fix** <@U123> & <!channel> 🔧"),
          toolLine("run tests"),
        ],
      },
      "_Compare &lt;#C123&gt; approaches 🔍_\n_Checking *the fix* &lt;@U123&gt; &amp; &lt;!channel&gt; 🔧_\nExec — run tests",
    ],
    [{ narration: [{ text: "Read C:\\path" }] }, "_Read C:\\path_"],
    [
      { narration: [{ text: "Check _x_ and *x* with `pnpm test` for <@U123> & <!channel>" }] },
      "_Check x and x with `pnpm test` for &lt;@U123&gt; &amp; &lt;!channel&gt;_",
    ],
    [
      {
        plan: [
          { step: "Run `pnpm test` for **checks** <@U123> & <!channel>", status: "in_progress" },
        ],
      },
      "▸ Run `pnpm test` for *checks* &lt;@U123&gt; &amp; &lt;!channel&gt;",
    ],
    [
      { lines: [{ ...toolLine("`pnpm test` <@U123> & <!channel>"), status: "exit 1" }] },
      "Exec — `pnpm test` &lt;@U123&gt; &amp; &lt;!channel&gt; — exit 1",
    ],
  ])("renders literal progress text: %j", (options, expected) => {
    expect(card(options)).toEqual([section(expected)]);
  });

  it("keeps approval attention visible beside fifty recent activity rows", () => {
    const blocks = card({
      title: "Working",
      maxLineChars: 300,
      lines: [
        { ...approval("Run the command"), text: "Approval required" },
        ...Array.from({ length: 50 }, (_, index) => ({
          ...progressLine(index),
          detail: "x".repeat(300),
        })),
      ],
    });
    expect(JSON.stringify(blocks)).toContain("Run the command");
  });

  it("keeps the newest activity rows inside one section and the Slack block budget", () => {
    const blocks = card({
      title: "Working",
      lines: Array.from({ length: 60 }, (_value, index) => progressLine(index)),
      elapsedSeconds: 1,
    });
    const activity = blocks.find(
      (block) => block.type === "section" && JSON.stringify(block).includes("Exec 59"),
    );

    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(activity).toBeDefined();
    expect(JSON.stringify(activity)).toContain("Exec 59 — run 59");
    expect(JSON.stringify(activity)).not.toContain("Exec 0");
  });

  it.each(["success", "error"] as const)(
    "settles approval and failure text when a card ends as %s",
    (state) => {
      const lines: ChannelProgressDraftLine[] = [
        { ...approval("Run the command"), text: "Approval required" },
        {
          kind: "command-output",
          label: "Bash",
          detail: "run checks",
          status: "exit 1",
          text: "Bash: run checks · exit 1",
        },
      ];
      const working = JSON.stringify(card({ title: "Working", lines }));
      expect(working).toContain("Run the command");
      expect(working).toContain("exit 1");
      const finished = JSON.stringify(card({ state, title: "Working", lines }));
      expect(finished).not.toContain("Run the command");
      expect(finished).not.toContain("requested");
      expect(finished.includes("Recovered:")).toBe(state === "success");
      expect(finished).toContain("exit 1");
    },
  );
});
