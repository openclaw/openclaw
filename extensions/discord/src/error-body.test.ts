// Discord tests cover error body summary behavior.
import { describe, expect, it } from "vitest";
import { summarizeDiscordResponseBody } from "./error-body.js";

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("summarizeDiscordResponseBody", () => {
  it("keeps truncated summaries on a UTF-16 boundary", () => {
    const summary = summarizeDiscordResponseBody(`${"a".repeat(239)}😀tail`);

    expect(summary).toHaveLength(239);
    expect(hasLoneSurrogate(summary ?? "")).toBe(false);
  });
});
