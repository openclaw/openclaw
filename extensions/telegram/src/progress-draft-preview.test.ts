import {
  buildChannelProgressDraftLine,
  type ChannelProgressDraftCompositorSnapshot,
} from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { telegramHtmlToPlainTextFallback } from "./format.js";
import { renderTelegramProgressDraftPreview } from "./progress-draft-preview.js";

const options = { richMessages: false, toolProgress: true, maxLines: 8, maxLineChars: 300 };

describe("renderTelegramProgressDraftPreview", () => {
  it.each(["Bash", "bash", "exec", "Read"])("prints one tool icon for %s", (name) => {
    const line = buildChannelProgressDraftLine(
      {
        event: "tool",
        toolCallId: "call-1",
        name,
        phase: "start",
        args: { command: "echo alpha", description: "print text", file_path: "/tmp/x.ts" },
      },
      { commandText: "raw" },
    );
    if (!line?.icon) {
      throw new Error(`expected an icon for ${name}`);
    }
    const preview = renderTelegramProgressDraftPreview({ lines: [line] }, options);
    expect(preview.text.split(line.icon)).toHaveLength(2);
    expect(preview.text).toContain(`<b>${line.icon} ${line.label}</b>`);
  });

  it("renders native checkboxes and equivalent readable HTML from the same plan", () => {
    const snapshot: ChannelProgressDraftCompositorSnapshot = {
      lines: [],
      statusHeadline: "1/3 complete",
      plan: [
        { step: "Inspect <fixture>", status: "completed" },
        { step: "Repair & verify", status: "in_progress" },
        { step: "Ship the fix", status: "pending" },
      ],
    };
    const rich = renderTelegramProgressDraftPreview(snapshot, { ...options, richMessages: true });
    const html = renderTelegramProgressDraftPreview(snapshot, options);
    expect(rich.richMessage?.blocks).toEqual([
      { type: "paragraph", text: { type: "bold", text: "1/3 complete" } },
      {
        type: "list",
        items: [
          {
            has_checkbox: true,
            is_checked: true,
            blocks: [{ type: "paragraph", text: "Inspect <fixture>" }],
          },
          {
            has_checkbox: true,
            blocks: [
              { type: "paragraph", text: { type: "bold", text: "Repair & verify (in progress)" } },
            ],
          },
          { has_checkbox: true, blocks: [{ type: "paragraph", text: "Ship the fix" }] },
        ],
      },
    ]);
    expect(telegramHtmlToPlainTextFallback(html.text)).toBe(rich.text);
    expect(html.text).not.toContain("<code>");
    expect(html.text).toContain("Inspect &lt;fixture&gt;");
    expect(html.complete).toBe(true);
    expect(rich.complete).toBe(true);
  });

  it.each([undefined, "exit 1", "exit 0"])(
    "keeps approval and the active step within the window regardless of status (%s)",
    (status) => {
      const preview = renderTelegramProgressDraftPreview(
        {
          lines: [
            { kind: "tool", label: "Read", text: "Read files" },
            {
              kind: "approval",
              label: "Approval",
              text: "Approval",
              detail: "Confirm access",
              status,
            },
          ],
          diffStat: { files: 1, added: 2, removed: 1 },
          plan: [
            { step: "Inspect", status: "completed" },
            { step: "Repair", status: "in_progress" },
            { step: "Verify", status: "pending" },
            { step: "Ship", status: "pending" },
          ],
        },
        { ...options, richMessages: true, maxLines: 3 },
      );
      expect(preview.text.split("\n")).toHaveLength(3);
      expect(preview.text).toContain("Confirm access");
      expect(preview.text).toContain("Repair (in progress)");
      expect(preview.text).toContain("1/4 done");
      expect(preview.text).not.toContain("Read files");
    },
  );

  it.each([true, false])(
    "keeps quiet non-zero exits visible above a full plan (rich=%s)",
    (richMessages) => {
      const preview = renderTelegramProgressDraftPreview(
        {
          lines: [{ kind: "command-output", label: "Exec", text: "🛠️ exit 1", status: "exit 1" }],
          plan: [
            { step: "Inspect", status: "completed" },
            { step: "Repair", status: "in_progress" },
            { step: "Verify", status: "pending" },
          ],
        },
        { ...options, richMessages, toolProgress: false, maxLines: 3 },
      );
      const text = telegramHtmlToPlainTextFallback(preview.text);
      expect(text).toContain("exit 1");
      expect(text).toContain("Repair (in progress)");
      expect(text.split("\n")).toHaveLength(3);
    },
  );

  it("keeps the full plan when non-zero exits fill the activity window", () => {
    const preview = renderTelegramProgressDraftPreview(
      {
        lines: Array.from({ length: 8 }, (_, index) => ({
          id: `command:${index}`,
          kind: "command-output" as const,
          label: "Exec",
          text: `🛠️ exit ${index + 1}`,
          status: `exit ${index + 1}`,
        })),
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Repair", status: "in_progress" },
          { step: "Verify", status: "pending" },
          { step: "Audit", status: "pending" },
          { step: "Ship", status: "pending" },
        ],
      },
      { ...options, maxLines: 8 },
    );
    const text = telegramHtmlToPlainTextFallback(preview.text);
    for (const step of ["Inspect", "Repair", "Verify", "Audit", "Ship"]) {
      expect(text).toContain(step);
    }
    expect(text).toContain("exit 8");
    expect(text).not.toContain("exit 1");
  });
  it.each([true, false])(
    "renders retained edit totals without a plan (rich=%s)",
    (richMessages) => {
      const preview = renderTelegramProgressDraftPreview(
        { lines: [], diffStat: { files: 1, added: 2, removed: 1 } },
        { ...options, richMessages },
      );
      expect(telegramHtmlToPlainTextFallback(preview.text)).toBe("📝 1 files +2 −1");
      expect(preview.text).not.toContain("<code>");
    },
  );
});
