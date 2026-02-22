import { describe, expect, it } from "vitest";
import { resolveMattermostRequireMentionPolicy } from "./monitor.js";

describe("resolveMattermostRequireMentionPolicy", () => {
  it("always disables mention requirement for direct chats", () => {
    const result = resolveMattermostRequireMentionPolicy({
      kind: "direct",
      accountRequireMention: true,
      resolveGroupRequireMention: () => true,
    });
    expect(result).toBe(false);
  });

  it("uses explicit account-level requireMention override for channels", () => {
    const result = resolveMattermostRequireMentionPolicy({
      kind: "channel",
      accountRequireMention: false,
      resolveGroupRequireMention: () => true,
    });
    expect(result).toBe(false);
  });

  it("falls back to group resolver when account override is undefined", () => {
    const result = resolveMattermostRequireMentionPolicy({
      kind: "group",
      resolveGroupRequireMention: () => true,
    });
    expect(result).toBe(true);
  });
});
