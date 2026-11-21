import { beforeEach, describe, expect, it } from "vitest";
import { rememberDiscordDirectoryUser } from "./directory-cache.js";
import { clearDiscordDirectoryCacheForTest } from "./directory-cache.test-support.js";
import {
  discordTextHasBroadcastMention,
  formatMention,
  rewriteDiscordKnownMentions,
} from "./mentions.js";

function remember(handles: string[], userId = "123456789", accountId = "default") {
  rememberDiscordDirectoryUser({ accountId, userId, handles });
}

function expectRewrite(
  text: string,
  expected: string,
  options: Parameters<typeof rewriteDiscordKnownMentions>[1] = {},
) {
  expect(rewriteDiscordKnownMentions(text, { accountId: "default", ...options })).toBe(expected);
}

// Only the fixture marker is rewritten; literal mentions must survive unchanged.
function expectMarkedRewrite(template: string) {
  const text = template.replaceAll("{mention}", "@alice");
  const expected = template.replaceAll("{mention}", "<@123>");
  expectRewrite(text, expected, {
    mentionAliases: { alice: "123", "alice.com": "456", "host.com": "789" },
  });
}

it("formatMention formats channel mentions from ids", () => {
  expect(formatMention({ channelId: "777555333" })).toBe("<#777555333>");
});

it("formatMention throws when more than one mention id is provided", () => {
  expect(() => formatMention({ userId: "1", channelId: "2" })).toThrow(/exactly one/i);
});

describe("rewriteDiscordKnownMentions", () => {
  beforeEach(clearDiscordDirectoryCacheForTest);

  it("rewrites @name mentions when a cached user id exists", () => {
    remember(["Alice", "@alice_user", "alice#1234"]);
    expectRewrite("ping @Alice and @alice_user", "ping <@123456789> and <@123456789>");
  });

  it("rewrites configured mention aliases before the cache", () => {
    remember(["vladislava"], "111111111");
    expectRewrite("ping @Vladislava and @BuildBot#1234", "ping <@333333333> and <@222222222>", {
      mentionAliases: { BuildBot: "222222222", Vladislava: "333333333" },
    });
  });

  it("preserves punctuation after handles, dotted aliases, and discriminators", () => {
    expectRewrite(
      "@alice... @alice.dev. @alice#1234!",
      "<@111111111>... <@222222222>. <@111111111>!",
      { mentionAliases: { alice: "111111111", "alice.dev": "222222222" } },
    );
  });

  it("prefers the longest known handle before treating trailing dots as punctuation", () => {
    remember(["alice.."], "333333333");
    expectRewrite("@alice. @alice.. @alice...", "<@222222222> <@333333333> <@333333333>.", {
      mentionAliases: { alice: "111111111", "alice.": "222222222" },
    });
  });

  it("preserves unknown mentions and reserved mentions", () => {
    remember(["alice"]);
    const text = "hello @unknown. @everyone. @here... @alice.dev. @a.";
    expectRewrite(text, text, {
      mentionAliases: { everyone: "111111111", here: "222222222", a: "333333333" },
    });
  });

  it.each([
    "user@host.com mail@alice. \\@alice.",
    "https://example.com/@alice. https://example.com/?@alice https://example.com/!@alice...",
    "www.example.com/?@alice. //example.com/?@alice. [link](//example.com/?@alice.)",
    "mailto:user@host.com?subject=@alice.",
    "See [docs](https://example.com),{mention}",
    "(https://example.com/a_(b)) {mention}.",
    "See [docs](https://example.com/a_(@alice)),{mention}.",
  ])("preserves URLs and emails: %s", (text) => {
    expectMarkedRewrite(`${text} {mention}.`);
  });

  it.each([
    "inline `@alice.` fence ```\n@alice.\n``` text {mention}.",
    "Example: ``first ``` literal\nsecond``\nPlease review {mention}",
    "outside {mention} then `inside @alice",
    "literal \\` outside {mention} then `inside @alice",
    '````ts\nconst fence = "```";\n@alice\n```` text {mention}',
  ])("preserves code mentions: %s", expectMarkedRewrite);

  it("is account-scoped", () => {
    remember(["alice"], "999888777", "ops");
    expectRewrite("@alice", "@alice");
    expectRewrite("@alice", "<@999888777>", { accountId: "ops" });
  });
});

it("discordTextHasBroadcastMention ignores targeted mentions and lookalikes", () => {
  expect(discordTextHasBroadcastMention("ping <@123>")).toBe(false);
  expect(discordTextHasBroadcastMention("mail me at a@everyones")).toBe(false);
});
