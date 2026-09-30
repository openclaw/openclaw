import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { buildSlackProgressCardBlocks } from "./progress-blocks.js";
import { itemLine, progressLine, toolLine } from "./progress-blocks.test-helpers.js";

describe("buildSlackProgressCardBlocks", () => {
  it.each(["working", "success", "error"] as const)(
    "omits filler from an empty %s card",
    (state) => {
      for (const detailed of [false, true]) {
        expect(buildSlackProgressCardBlocks({ detailed, state, lines: [] })).toEqual([]);
      }
    },
  );

  it.each(["working", "success", "error"] as const)(
    "keeps only text, commentary, approvals, and session links by default when %s",
    (state) => {
      const blocks = buildSlackProgressCardBlocks({
        detailed: false,
        state,
        title: "Review",
        narration: [
          { text: "Checking the workspace" },
          { text: "Read *literal*", format: "plain" },
        ],
        plan: [{ step: "Inspect", status: "in_progress" }],
        lines: [
          itemLine("Considering the change", "Reasoning"),
          toolLine("pnpm test"),
          { ...itemLine("Tool output"), toolName: "exec" },
          { ...toolLine("failed check"), status: "exit 1" },
          {
            kind: "approval",
            label: "Approval",
            text: "Approval",
            detail: "Run checks",
            status: "requested",
          },
        ],
        toolCalls: 2,
        elapsedSeconds: 12,
        diffStat: { files: 1, added: 2, removed: 1 },
        sessionLinks: [{ text: "Open work session", url: "https://example.com/session" }],
      });
      expect(blocks).toEqual([
        { type: "section", text: { type: "plain_text", text: "Review", emoji: false } },
        { type: "section", text: { type: "mrkdwn", text: "_Checking the workspace_" } },
        { type: "section", text: { type: "plain_text", text: "Read *literal*", emoji: false } },
        { type: "section", text: { type: "mrkdwn", text: "_Considering the change_" } },
        ...(state === "working"
          ? [{ type: "section", text: { type: "mrkdwn", text: "Approval required: Run checks" } }]
          : [
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    action_id: "openclaw:session_link",
                    text: { type: "plain_text", text: "Open work session" },
                    url: "https://example.com/session",
                  },
                ],
              },
            ]),
      ]);
    },
  );

  it.each([
    { toolCalls: 1, files: 1, added: 0, removed: 0, footer: "1 tool · 1 file · 2s" },
    { toolCalls: 2, files: 3, added: 12, removed: 4, footer: "2 tools · 3 files +12 −4 · 2s" },
    { toolCalls: 0, files: 0, added: 0, removed: 0, footer: "2s" },
    { toolCalls: 0, files: 1, added: 0, removed: 4, footer: "1 file −4 · 2s" },
  ])("renders the live footer as $footer", ({ toolCalls, files, added, removed, footer }) => {
    expect(
      buildSlackProgressCardBlocks({
        detailed: true,
        state: "working",
        lines: [],
        toolCalls,
        elapsedSeconds: 2,
        diffStat: { files, added, removed },
      }),
    ).toEqual([{ type: "context", elements: [{ type: "mrkdwn", text: footer }] }]);
  });

  it("omits detail placeholders from completed tools and preserves plain narration", () => {
    expect(
      buildSlackProgressCardBlocks({
        detailed: true,
        state: "success",
        narration: [{ text: "Read *literal* <@U123>", format: "plain" }],
        lines: [{ ...toolLine(""), status: "completed" }],
        toolCalls: 1,
        elapsedSeconds: 2,
      }),
    ).toEqual([
      {
        type: "section",
        text: { type: "plain_text", text: "Read *literal* <@U123>", emoji: false },
      },
      { type: "section", text: { type: "mrkdwn", text: "Exec" } },
    ]);
  });

  it("keeps plan selection, summary, and truncation budgets without emoji", () => {
    const blocks = buildSlackProgressCardBlocks({
      detailed: true,
      state: "working",
      lines: [],
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
    const blocks = buildSlackProgressCardBlocks({
      detailed: true,
      state: "working",
      title: "Working",
      lines: [
        { kind: "approval", label: "Approve deploy", status: "requested", text: "Approve deploy" },
        {
          kind: "approval",
          label: "Approve restart",
          status: "requested",
          text: "Approve restart",
        },
        { kind: "command-output", label: "Build", status: "exit 1", text: "Build exit 1" },
        { kind: "command-output", label: "Test", status: "exit 2", text: "Test exit 2" },
      ],
    });
    const text = JSON.stringify(blocks);
    for (const expected of [
      "Approve deploy",
      "Approve restart",
      "Build — exit 1",
      "Test — exit 2",
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("preserves authored commentary and reasoning Markdown beside tool activity", () => {
    const blocks = buildSlackProgressCardBlocks({
      detailed: true,
      state: "working",
      title: "Checking the workspace",
      lines: [
        {
          id: "reasoning",
          kind: "item",
          label: "Reasoning",
          text: "Compare <#C123> approaches 🔍",
        },
        {
          id: "commentary:1",
          kind: "item",
          label: "Update",
          text: "Checking **the fix** <@U123> & <!channel> 🔧",
        },
        toolLine("run tests"),
      ],
    });
    expect(blocks[1]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Compare &lt;#C123&gt; approaches 🔍_\n_Checking *the fix* &lt;@U123&gt; &amp; &lt;!channel&gt; 🔧_\nExec — run tests",
      },
    });
  });

  it.each([
    ["Run **bold** checks", "_Run *bold* checks_"],
    ["Read C:\\path", "_Read C:\\path_"],
    [
      "Check `code` for <@U123> & <!channel>",
      "_Check `code` for &lt;@U123&gt; &amp; &lt;!channel&gt;_",
    ],
  ])("renders authored commentary %s inside one italic wrapper", (narration, expected) => {
    expect(
      buildSlackProgressCardBlocks({
        detailed: true,
        state: "working",
        narration: [{ text: narration }],
        lines: [],
      }),
    ).toEqual([{ type: "section", text: { type: "mrkdwn", text: expected } }]);
  });

  it("renders authored narration inside one italic wrapper while preserving inline code", () => {
    const blocks = buildSlackProgressCardBlocks({
      detailed: true,
      state: "working",
      title: "Working",
      narration: [{ text: "Check _x_ and *x* with `pnpm test` for <@U123> & <!channel>" }],
      lines: [],
    });
    expect(blocks[1]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Check x and x with `pnpm test` for &lt;@U123&gt; &amp; &lt;!channel&gt;_",
      },
    });
  });

  it("renders authored plan Markdown without activating Slack mentions", () => {
    const blocks = buildSlackProgressCardBlocks({
      detailed: true,
      state: "working",
      title: "Working",
      plan: [
        { step: "Run `pnpm test` for **checks** <@U123> & <!channel>", status: "in_progress" },
      ],
      lines: [],
    });
    expect(blocks[1]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "▸ Run `pnpm test` for *checks* &lt;@U123&gt; &amp; &lt;!channel&gt;",
      },
    });
  });

  it("escapes only entities in literal attention text", () => {
    const blocks = buildSlackProgressCardBlocks({
      detailed: true,
      state: "working",
      title: "Working",
      lines: [{ ...toolLine("`pnpm test` <@U123> & <!channel>"), status: "exit 1" }],
    });
    expect(blocks[1]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Exec — `pnpm test` &lt;@U123&gt; &amp; &lt;!channel&gt; — exit 1",
      },
    });
  });

  it("keeps approval attention visible beside fifty recent activity rows", () => {
    const blocks = buildSlackProgressCardBlocks({
      detailed: true,
      state: "working",
      title: "Working",
      maxLineChars: 300,
      lines: [
        {
          kind: "approval",
          label: "Approval",
          text: "Approval required",
          detail: "Run the command",
          status: "requested",
        },
        ...Array.from({ length: 50 }, (_, index) => ({
          ...progressLine(index),
          detail: "x".repeat(300),
        })),
      ],
    });
    expect(JSON.stringify(blocks)).toContain("Run the command");
  });

  it("renders the working card with narration, plan, one activity block, and live footer", () => {
    const blocks = buildSlackProgressCardBlocks({
      detailed: true,
      state: "working",
      title: "Implementing",
      narration: [{ text: "Checking the workspace." }],
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "in_progress" },
      ],
      lines: [toolLine("run tests"), itemLine("prepare the workspace", "Preamble")],
      toolCalls: 3,
      elapsedSeconds: 12,
      diffStat: { files: 4, added: 2, removed: 1 },
    });

    expect(blocks).toEqual([
      { type: "section", text: { type: "plain_text", text: "Implementing", emoji: false } },
      {
        type: "section",
        text: { type: "mrkdwn", text: "_Checking the workspace._" },
      },
      { type: "section", text: { type: "mrkdwn", text: "✓ Inspect\n▸ Patch" } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Exec — run tests\n_prepare the workspace_",
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "3 tools · 4 files +2 −1 · 12s" }],
      },
    ]);
  });

  it.each([{ state: "success" as const }, { state: "error" as const }])(
    "renders $state terminal cards and gates the session action on public URL",
    ({ state }) => {
      const blocks = buildSlackProgressCardBlocks({
        detailed: true,
        state,
        title: "Implementing",
        lines: [toolLine("run tests")],
        diffStat: { files: 2, added: 1, removed: 1 },
        sessionLinks: [
          { url: "https://team.openclaw.ai/openclaw/chat/main", text: "Open in OpenClaw" },
        ],
      });

      expect(blocks[0]).toEqual({
        type: "section",
        text: { type: "plain_text", text: "Implementing", emoji: false },
      });
      // Finished cards keep the diff stat only: no tool-call/elapsed receipt.
      expect(blocks).toContainEqual({
        type: "context",
        elements: [{ type: "mrkdwn", text: "2 files +1 −1" }],
      });
      expect(blocks.at(-1)).toEqual({
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "openclaw:session_link",
            text: { type: "plain_text", text: "Open in OpenClaw" },
            url: "https://team.openclaw.ai/openclaw/chat/main",
          },
        ],
      });

      expect(
        buildSlackProgressCardBlocks({ detailed: true, state, title: "Implementing", lines: [] }),
      ).toHaveLength(1);
    },
  );

  it("keeps the newest activity rows inside one section and the Slack block budget", () => {
    const blocks = buildSlackProgressCardBlocks({
      detailed: true,
      state: "working",
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
        {
          kind: "approval",
          label: "Approval",
          detail: "Run the command",
          status: "requested",
          text: "Approval required",
        },
        {
          kind: "command-output",
          label: "Bash",
          detail: "run checks",
          status: "exit 1",
          text: "Bash: run checks · exit 1",
        },
      ];
      const working = JSON.stringify(
        buildSlackProgressCardBlocks({ detailed: true, state: "working", title: "Working", lines }),
      );
      expect(working).toContain("Run the command");
      expect(working).toContain("exit 1");
      const finished = JSON.stringify(
        buildSlackProgressCardBlocks({ detailed: true, state, title: "Working", lines }),
      );
      expect(finished).not.toContain("Run the command");
      expect(finished).not.toContain("requested");
      expect(finished.includes("Recovered:")).toBe(state === "success");
      expect(finished).toContain("exit 1");
    },
  );
});
