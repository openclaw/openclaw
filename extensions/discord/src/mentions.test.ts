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

  it.each([".", "...", ",", "!", "?", ":", ";", ")"])(
    "preserves %s after known mentions",
    (suffix) => {
      expectRewrite(
        `@alice${suffix} @alice.dev${suffix} @alice#1234${suffix}`,
        `<@111111111>${suffix} <@222222222>${suffix} <@111111111>${suffix}`,
        { mentionAliases: { alice: "111111111", "alice.dev": "222222222" } },
      );
    },
  );

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

  it.each<[string, string?]>([
    ["user@host.com mail@alice. \\@alice."],
    ["https://example.com/@alice. https://example.com/?@alice https://example.com/!@alice..."],
    ["www.example.com/?@alice. //example.com/?@alice. [link](//example.com/?@alice.)"],
    ["mailto:user@host.com?subject=@alice."],
    ["See [docs](https://example.com),@alice", "See [docs](https://example.com),<@123456789>"],
    ["(https://example.com/a_(b)) @alice.", "(https://example.com/a_(b)) <@123456789>."],
    [
      "See [docs](https://example.com/a_(@alice)),@alice.",
      "See [docs](https://example.com/a_(@alice)),<@123456789>.",
    ],
    ["https://example.com/@alice"],
    ["user@alice.com"],
  ])("resolves prose mentions while preserving URLs and emails: %s", (text, expected) => {
    expectRewrite(`${text} @alice.`, `${expected ?? text} <@123456789>.`, {
      mentionAliases: { alice: "123456789", "alice.com": "987654321", "host.com": "111111111" },
    });
  });

  it.each([
    [
      "inline `@alice.` fence ```\n@alice.\n``` text @alice.",
      "inline `@alice.` fence ```\n@alice.\n``` text <@123456789>.",
    ],
    [
      "Example: ``first ``` literal\nsecond``\nPlease review @alice",
      "Example: ``first ``` literal\nsecond``\nPlease review <@123456789>",
    ],
    ["outside @alice then `inside @alice", "outside <@123456789> then `inside @alice"],
    [
      "literal \\` outside @alice then `inside @alice",
      "literal \\` outside <@123456789> then `inside @alice",
    ],
  ])("does not rewrite mentions inside code: %s", (input, expected) => {
    remember(["alice"]);
    expectRewrite(input, expected);
  });

  it("does not end longer code fences at triple-backtick literals inside the body", () => {
    remember(["alice"]);
    const text = '````ts\nconst fence = "```";\n@alice\n```` text @alice';
    expectRewrite(text, '````ts\nconst fence = "```";\n@alice\n```` text <@123456789>');
  });

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
