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
});
