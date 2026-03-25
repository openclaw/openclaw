import { describe, expect, it } from "vitest";
import { NextcloudTalkConfigSchema } from "./config-schema.js";
import {
  escapeNextcloudTalkMarkdown,
  formatNextcloudTalkCodeBlock,
  formatNextcloudTalkInlineCode,
  formatNextcloudTalkMention,
  markdownToNextcloudTalk,
  stripNextcloudTalkFormatting,
  truncateNextcloudTalkText,
} from "./format.js";
import { resolveNextcloudTalkOutboundSessionRoute } from "./session-route.js";

describe("nextcloud talk core", () => {
  it("accepts SecretRef botSecret and apiPassword at top-level", () => {
    const result = NextcloudTalkConfigSchema.safeParse({
      baseUrl: "https://cloud.example.com",
      botSecret: { source: "env", provider: "default", id: "NEXTCLOUD_TALK_BOT_SECRET" },
      apiUser: "bot",
      apiPassword: { source: "env", provider: "default", id: "NEXTCLOUD_TALK_API_PASSWORD" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef botSecret and apiPassword on account", () => {
    const result = NextcloudTalkConfigSchema.safeParse({
      accounts: {
        main: {
          baseUrl: "https://cloud.example.com",
          botSecret: {
            source: "env",
            provider: "default",
            id: "NEXTCLOUD_TALK_MAIN_BOT_SECRET",
          },
          apiUser: "bot",
          apiPassword: {
            source: "env",
            provider: "default",
            id: "NEXTCLOUD_TALK_MAIN_API_PASSWORD",
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

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

  it("builds an outbound session route for normalized room targets", () => {
    const route = resolveNextcloudTalkOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "nextcloud-talk:room-123",
    });

    expect(route).toMatchObject({
      peer: {
        kind: "group",
        id: "room-123",
      },
      from: "nextcloud-talk:room:room-123",
      to: "nextcloud-talk:room-123",
    });
  });

  it("returns null when the target cannot be normalized to a room id", () => {
    expect(
      resolveNextcloudTalkOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "acct-1",
        target: "",
      }),
    ).toBeNull();
  });
});
