import { buildChannelProgressDraftLineForEntry as lineFor } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { renderTelegramProgressDraftPreview as renderPreview } from "./progress-draft-preview.js";

describe.each([false, true])("progress draft item labels (rich=%s)", (richMessages) => {
  function render(snapshot: Parameters<typeof renderPreview>[0], maxLineChars = 40) {
    return renderPreview(snapshot, { richMessages, toolProgress: true, maxLines: 8, maxLineChars });
  }

  it("renders plain notes as literal prose", () => {
    for (const label of [undefined, "Working"]) {
      const note = "**Check** <queue> & `jobs` https://example.test";
      const preview = render(
        { label, statusHeadline: note, statusHeadlineFormat: "plain", lines: [] },
        120,
      );
      expect(preview.linkPreview).toBe(false);
      if (richMessages) {
        expect(preview.richMessage).toMatchObject({
          skip_entity_detection: true,
          blocks: [
            ...(label ? [{ type: "paragraph", text: { type: "bold", text: label } }] : []),
            { type: "paragraph", text: label ? note : { type: "bold", text: note } },
          ],
        });
      } else {
        const escaped = "**Check** &lt;queue&gt; &amp; `jobs` https://example.test";
        expect(preview.text).toBe(label ? `<b>Working</b><br>${escaped}` : `<b>${escaped}</b>`);
      }
    }
  });

  // Item input, raw tool formatting, HTML/rich text (undefined = length bound).
  it.each([
    [{ itemKind: "preamble", title: "Preamble", progressText: "**p**" }, false, ["<b>p</b>", "p"]],
    [
      { name: "read", title: "Read " + "/directory".repeat(8), status: "running" },
      false,
      undefined,
    ],
    [
      { name: "read", summary: "from…f", status: "failed" },
      true,
      ["<b>📖 Read</b> from…f <i>failed</i>", "📖 Read from…f failed"],
    ],
  ] as const)("renders item %j", (input, raw, expected) => {
    const line = lineFor(
      undefined,
      { event: "item", ...input },
      raw ? { toolIcons: true, detailMode: "raw" } : undefined,
    )!;
    const text = render({ lines: [line] }).text;
    if (expected === undefined) {
      expect(Array.from(text.replace(/<[^>]*>/g, "")).length).toBeLessThanOrEqual(40);
    } else {
      expect(text).toBe(expected[Number(richMessages)]);
    }
  });

  it("budgets the complete raw command row", () => {
    for (const status of ["running", "completed"]) {
      const line = lineFor(
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
      const text = render({ lines: [line] }).text.replace(/<[^>]*>/g, "");
      expect(Array.from(text).length).toBeLessThanOrEqual(40);
      expect(text).toContain("🛠️ Exec ");
      expect(text).toContain("…");
      if (status === "running") {
        expect(text).toMatch(/ running$/);
      }
    }
  });
});
