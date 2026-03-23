import { describe, expect, it } from "vitest";
import {
  escapeNextcloudTalkMarkdown,
  formatNextcloudTalkCodeBlock,
  formatNextcloudTalkInlineCode,
  formatNextcloudTalkMention,
  markdownToNextcloudTalk,
  stripNextcloudTalkFormatting,
  truncateNextcloudTalkText,
} from "./format.js";

describe("nextcloud talk format helpers", () => {
  it("keeps markdown mostly intact while trimming outer whitespace", () => {
    expect(markdownToNextcloudTalk("  **hello**  ")).toBe("**hello**");
  });

  it("escapes markdown-sensitive characters", () => {
    expect(escapeNextcloudTalkMarkdown("*hello* [x](y)")).toBe("\\*hello\\* \\[x\\]\\(y\\)");
  });

  it("formats mentions and code consistently", () => {
    expect(formatNextcloudTalkMention("@alice")).toBe("@alice");
    expect(formatNextcloudTalkMention("bob")).toBe("@bob");
    expect(formatNextcloudTalkCodeBlock("const x = 1;", "ts")).toBe("```ts\nconst x = 1;\n```");
    expect(formatNextcloudTalkInlineCode("x")).toBe("`x`");
    expect(formatNextcloudTalkInlineCode("x ` y")).toBe("`` x ` y ``");
  });

  it("strips markdown formatting and truncates on word boundaries", () => {
    expect(stripNextcloudTalkFormatting("**bold** [link](https://example.com) `code`")).toBe(
      "bold link",
    );
    expect(truncateNextcloudTalkText("alpha beta gamma delta", 14)).toBe("alpha beta...");
    expect(truncateNextcloudTalkText("short", 14)).toBe("short");
  });
});
