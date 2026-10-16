import { beforeEach, describe, expect, it } from "vitest";
import { rememberDiscordDirectoryUser } from "./directory-cache.js";
import { clearDiscordDirectoryCacheForTest } from "./directory-cache.test-support.js";
import {
  discordTextHasBroadcastMention,
  formatMention,
  rewriteDiscordKnownMentions,
} from "./mentions.js";

describe("formatMention", () => {
  it("formats channel mentions from ids", () => {
    expect(formatMention({ channelId: "777555333" })).toBe("<#777555333>");
  });

  it("throws when more than one mention id is provided", () => {
    expect(() => formatMention({ userId: "1", roleId: "2" })).toThrow(/exactly one/i);
  });
});

describe("rewriteDiscordKnownMentions", () => {
  beforeEach(() => {
    clearDiscordDirectoryCacheForTest();
  });

  it("rewrites @name mentions when a cached user id exists", () => {
    rememberDiscordDirectoryUser({
      accountId: "default",
      userId: "123456789",
      handles: ["Alice", "@alice_user", "alice#1234"],
    });
    const rewritten = rewriteDiscordKnownMentions("ping @Alice and @alice_user", {
      accountId: "default",
    });
    expect(rewritten).toBe("ping <@123456789> and <@123456789>");
  });

  it("rewrites configured mention aliases before the cache", () => {
    rememberDiscordDirectoryUser({
      accountId: "default",
      userId: "111111111",
      handles: ["vladislava"],
    });
    const rewritten = rewriteDiscordKnownMentions("ping @Vladislava and @BuildBot#1234", {
      accountId: "default",
      mentionAliases: {
        BuildBot: "222222222",
        Vladislava: "333333333",
      },
    });
    expect(rewritten).toBe("ping <@333333333> and <@222222222>");
  });

  it.each([".", "...", ",", "!", "?", ":", ";", ")"])(
    "preserves %s after known mentions",
    (suffix) => {
      expect(
        rewriteDiscordKnownMentions(`@alice${suffix} @alice.dev${suffix} @alice#1234${suffix}`, {
          mentionAliases: { alice: "111111111", "alice.dev": "222222222" },
        }),
      ).toBe(`<@111111111>${suffix} <@222222222>${suffix} <@111111111>${suffix}`);
    },
  );

  it("prefers the longest known handle before treating trailing dots as punctuation", () => {
    rememberDiscordDirectoryUser({
      accountId: "default",
      userId: "333333333",
      handles: ["alice.."],
    });
    expect(
      rewriteDiscordKnownMentions("@alice. @alice.. @alice...", {
        accountId: "default",
        mentionAliases: { alice: "111111111", "alice.": "222222222" },
      }),
    ).toBe("<@222222222> <@333333333> <@333333333>.");
  });

  it("preserves unknown mentions and reserved mentions", () => {
    rememberDiscordDirectoryUser({
      accountId: "default",
      userId: "123456789",
      handles: ["alice"],
    });
    const text = "hello @unknown. @everyone. @here... @alice.dev. @a.";
    const rewritten = rewriteDiscordKnownMentions(text, {
      accountId: "default",
      mentionAliases: { everyone: "111111111", here: "222222222", a: "333333333" },
    });
    expect(rewritten).toBe(text);
  });

  it.each([
    ["user@host.com mail@alice. \\@alice.", "user@host.com mail@alice. \\@alice."],
    [
      "https://example.com/@alice. https://example.com/?@alice https://example.com/!@alice...",
      "https://example.com/@alice. https://example.com/?@alice https://example.com/!@alice...",
    ],
    [
      "www.example.com/?@alice. //example.com/?@alice. [link](//example.com/?@alice.)",
      "www.example.com/?@alice. //example.com/?@alice. [link](//example.com/?@alice.)",
    ],
    ["mailto:user@host.com?subject=@alice.", "mailto:user@host.com?subject=@alice."],
    ["See [docs](https://example.com),@alice", "See [docs](https://example.com),<@123456789>"],
    ["(https://example.com/a_(b)) @alice.", "(https://example.com/a_(b)) <@123456789>."],
    [
      "See [docs](https://example.com/a_(@alice)),@alice.",
      "See [docs](https://example.com/a_(@alice)),<@123456789>.",
    ],
    ["https://example.com/@alice", "https://example.com/@alice"],
    ["user@alice.com", "user@alice.com"],
  ])("resolves prose mentions while preserving URLs and emails: %s", (text, expected) => {
    expect(
      rewriteDiscordKnownMentions(`${text} @alice.`, {
        mentionAliases: { alice: "123456789", "alice.com": "987654321", "host.com": "111111111" },
      }),
    ).toBe(`${expected} <@123456789>.`);
  });

  it.each([
    {
      name: "balanced inline and fenced code",
      input: "inline `@alice.` fence ```\n@alice.\n``` text @alice.",
      expected: "inline `@alice.` fence ```\n@alice.\n``` text <@123456789>.",
    },
    {
      name: "closed multiline code containing a longer backtick run",
      input: "Example: ``first ``` literal\nsecond``\nPlease review @alice",
      expected: "Example: ``first ``` literal\nsecond``\nPlease review <@123456789>",
    },
    {
      name: "unterminated single-backtick code",
      input: "outside @alice then `inside @alice",
      expected: "outside <@123456789> then `inside @alice",
    },
    {
      name: "escaped backticks before real unterminated code",
      input: "literal \\` outside @alice then `inside @alice",
      expected: "literal \\` outside <@123456789> then `inside @alice",
    },
  ])("does not rewrite mentions inside $name", ({ input, expected }) => {
    rememberDiscordDirectoryUser({
      accountId: "default",
      userId: "123456789",
      handles: ["alice"],
    });
    expect(rewriteDiscordKnownMentions(input, { accountId: "default" })).toBe(expected);
  });

  it("does not end longer code fences at triple-backtick literals inside the body", () => {
    rememberDiscordDirectoryUser({
      accountId: "default",
      userId: "123456789",
      handles: ["alice"],
    });
    const text = '````ts\nconst fence = "```";\n@alice\n```` text @alice';
    const rewritten = rewriteDiscordKnownMentions(text, {
      accountId: "default",
    });
    expect(rewritten).toBe('````ts\nconst fence = "```";\n@alice\n```` text <@123456789>');
  });

  it("is account-scoped", () => {
    rememberDiscordDirectoryUser({
      accountId: "ops",
      userId: "999888777",
      handles: ["alice"],
    });
    const defaultRewrite = rewriteDiscordKnownMentions("@alice", { accountId: "default" });
    const opsRewrite = rewriteDiscordKnownMentions("@alice", { accountId: "ops" });
    expect(defaultRewrite).toBe("@alice");
    expect(opsRewrite).toBe("<@999888777>");
  });
});

describe("discordTextHasBroadcastMention", () => {
  it("ignores targeted mentions and lookalikes", () => {
    expect(discordTextHasBroadcastMention("ping <@123>")).toBe(false);
    expect(discordTextHasBroadcastMention("mail me at a@everyones")).toBe(false);
  });
});
