import { describe, expect, it } from "vitest";
import {
  matchesMattermostBotMention,
  normalizeMention,
  shouldDropEmptyMattermostBody,
} from "./monitor-helpers.js";

describe("Mattermost mention normalization", () => {
  it("preserves multiline Markdown while removing case-insensitive mentions", () => {
    expect(
      normalizeMention(
        "@EchoBot\n  - nested\n    - deep\n| aaa    | bbb |\nhey  @echobot  check\n",
        "echobot",
      ),
    ).toBe("  - nested\n    - deep\n| aaa    | bbb |\nhey check");
  });
  it.each(["@echobot:remote hello", "mail me at bob@echobot later"])(
    "preserves other handles: %j",
    (text) => {
      expect(matchesMattermostBotMention(text, "echobot")).toBe(false);
      expect(normalizeMention(text, "echobot")).toBe(text);
    },
  );
  it.each([{ bodyText: "\u0085", rawText: "@openclaw\u0085", botUsername: "openclaw" }])(
    "rejects invalid empty-body wake event $rawText",
    (input) => {
      expect(shouldDropEmptyMattermostBody(input)).toBe(true);
    },
  );
});
