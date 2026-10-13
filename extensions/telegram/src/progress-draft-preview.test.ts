import { buildChannelProgressDraftLineForEntry } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { renderTelegramProgressDraftPreview } from "./progress-draft-preview.js";

describe("progress draft item labels", () => {
  it.each([false, true])(
    "renders authored preambles without internal titles (rich=%s)",
    (richMessages) => {
      const line = buildChannelProgressDraftLineForEntry(undefined, {
        event: "item",
        itemKind: "preamble",
        itemId: "preamble-1",
        title: "Preamble",
        progressText: "I'll list the **workspace** first.",
      })!;
      const preview = renderTelegramProgressDraftPreview(
        { lines: [line] },
        { richMessages, toolProgress: true, maxLines: 8, maxLineChars: 120 },
      );
      expect(preview.text).toBe(
        richMessages ? "I'll list the workspace first." : "I'll list the <b>workspace</b> first.",
      );
    },
  );

  it.each([false, true])("budgets the complete raw command row (rich=%s)", (richMessages) => {
    for (const status of ["running", "completed"]) {
      const line = buildChannelProgressDraftLineForEntry(
        { streaming: { mode: "progress", progress: { commandText: "raw" } } },
        {
          event: "item",
          name: "exec",
          itemId: "command-1",
          summary: "run sleep 3 → print text, sleep 3 && echo a long command suffix",
          status,
        },
        { toolIcons: true, detailMode: "raw" },
      )!;
      const preview = renderTelegramProgressDraftPreview(
        { lines: [line] },
        { richMessages, toolProgress: true, maxLines: 8, maxLineChars: 40 },
      );
      const text = preview.text.replace(/<[^>]*>/g, "");
      expect(Array.from(text).length).toBeLessThanOrEqual(40);
      expect(text).toContain("🛠️ Exec ");
      expect(text).toContain("…");
      if (status === "running") {
        expect(text).toMatch(/ running$/);
      }
    }
  });

  it.each([false, true])("budgets oversized prepared labels (rich=%s)", (richMessages) => {
    const line = buildChannelProgressDraftLineForEntry(undefined, {
      event: "item",
      name: "read",
      title: "Read /workspace/a-very-long-directory-name/another-directory/file.txt",
      status: "running",
    })!;
    const preview = renderTelegramProgressDraftPreview(
      { lines: [line] },
      { richMessages, toolProgress: true, maxLines: 8, maxLineChars: 40 },
    );
    expect(Array.from(preview.text.replace(/<[^>]*>/g, "")).length).toBeLessThanOrEqual(40);
  });

  it.each([false, true])("preserves already fitting Read rows (rich=%s)", (richMessages) => {
    const line = buildChannelProgressDraftLineForEntry(
      undefined,
      {
        event: "item",
        name: "read",
        summary: "from…p/deep/file.txt",
        status: "failed",
      },
      { toolIcons: true, detailMode: "raw" },
    )!;
    const preview = renderTelegramProgressDraftPreview(
      { lines: [line] },
      { richMessages, toolProgress: true, maxLines: 8, maxLineChars: 40 },
    );
    expect(preview.text).toBe(
      richMessages
        ? "📖 Read from…p/deep/file.txt failed"
        : "<b>📖 Read</b> from…p/deep/file.txt <i>failed</i>",
    );
  });
});
