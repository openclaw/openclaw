// Telegram tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { TelegramConfigSchema } from "../config-api.js";

function expectTelegramConfigValid(config: unknown) {
  expect(TelegramConfigSchema.safeParse(config).success).toBe(true);
}

function expectTelegramConfigIssue(config: unknown, path: string) {
  const res = TelegramConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (!res.success) {
    expect(res.error.issues[0]?.path.join(".")).toBe(path);
  }
}

describe("telegram custom commands schema", () => {
  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    expectTelegramConfigIssue(
      { dmPolicy: "open", allowFrom: ["123456789"], botToken: "fake" },
      "allowFrom",
    );
  });

  it('accepts dmPolicy="open" with allowFrom "*"', () => {
    const res = TelegramConfigSchema.safeParse({ dmPolicy: "open", allowFrom: ["*"] });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.dmPolicy).toBe("open");
    }
  });

  it('rejects dmPolicy="allowlist" without allowFrom', () => {
    expectTelegramConfigIssue({ dmPolicy: "allowlist", botToken: "fake" }, "allowFrom");
  });

  it("accepts account allowlist policy inherited from the channel", () => {
    expectTelegramConfigValid({
      allowFrom: ["12345"],
      accounts: { bot1: { dmPolicy: "allowlist", botToken: "fake" } },
    });
  });

  it("rejects account allowlist without account or channel allowFrom", () => {
    expectTelegramConfigIssue(
      { accounts: { bot1: { dmPolicy: "allowlist", botToken: "fake" } } },
      "accounts.bot1.allowFrom",
    );
  });

  it("rejects retired group history context mode keys", () => {
    const res = TelegramConfigSchema.safeParse({ includeGroupHistoryContext: "mention-only" });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]).toMatchObject({
        code: "unrecognized_keys",
        keys: ["includeGroupHistoryContext"],
        path: [],
      });
    }
  });

  it("rejects removed DM thread reply policy keys", () => {
    expectTelegramConfigIssue({ dm: { threadReplies: "off" } }, "");
    expectTelegramConfigIssue(
      { accounts: { ops: { dm: { threadReplies: "always" } } } },
      ["accounts", "ops"].join("."),
    );
    expectTelegramConfigIssue(
      {
        direct: {
          "123456789": {
            threadReplies: "inbound",
          },
        },
      },
      "direct.123456789",
    );
  });

  it("preserves rich message inheritance for account overrides", () => {
    const res = TelegramConfigSchema.safeParse({
      richMessages: true,
      accounts: { ops: {} },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.richMessages).toBe(true);
      expect(res.data.accounts?.ops?.richMessages).toBeUndefined();
    }
  });

  it("normalizes custom commands", () => {
    const res = TelegramConfigSchema.safeParse({
      customCommands: [{ command: "/Backup", description: "  Git backup  " }],
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.customCommands).toEqual([{ command: "backup", description: "Git backup" }]);
  });

  it("normalizes hyphens in custom command names", () => {
    const res = TelegramConfigSchema.safeParse({
      customCommands: [{ command: "Bad-Name", description: "Override status" }],
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.customCommands).toEqual([
      { command: "bad_name", description: "Override status" },
    ]);
  });
});

describe("telegram topic agentId schema", () => {
  it("allows bot-thread mention policy only in forum group and topic scopes", () => {
    const topic = { requireMention: true, agentId: "main", disableAudioPreflight: true };
    const policies = {
      groups: {
        "*": {
          requireMentionInBotThreads: false,
          topics: { "42": { ...topic, requireMentionInBotThreads: true } },
        },
      },
      direct: { "123456789": { topics: { "42": topic } } },
    };
    expectTelegramConfigValid({ ...policies, accounts: { ops: policies } });
    const invalid = {
      direct: { "123456789": { topics: { "42": { requireMentionInBotThreads: false } } } },
    };
    expectTelegramConfigIssue(invalid, "direct.123456789.topics.42");
    expectTelegramConfigIssue(
      { accounts: { ops: invalid } },
      "accounts.ops.direct.123456789.topics.42",
    );
  });

  it("rejects non-boolean ingest", () => {
    expectTelegramConfigIssue(
      {
        groups: {
          "-1001234567890": {
            ingest: { enabled: true },
          },
        },
      },
      "groups.-1001234567890.ingest",
    );
  });

  it("accepts agentId in topic config", () => {
    expectTelegramConfigValid({
      groups: {
        "-1001234567890": {
          topics: { "42": { agentId: "main" } },
        },
      },
    });
  });

  it("rejects unknown fields in topic config", () => {
    const res = TelegramConfigSchema.safeParse({
      groups: {
        "-1001234567890": {
          topics: {
            "42": {
              agentId: "main",
              unknownField: "should fail",
            },
          },
        },
      },
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]).toMatchObject({
        code: "unrecognized_keys",
        keys: ["unknownField"],
        path: ["groups", "-1001234567890", "topics", "42"],
      });
    }
  });
});

describe("telegram disableAudioPreflight schema", () => {
  it.each([true, false])("accepts disableAudioPreflight=%s for groups and topics", (value) => {
    expectTelegramConfigValid({
      groups: {
        "*": {
          disableAudioPreflight: value,
          topics: { "42": { disableAudioPreflight: value } },
        },
      },
    });
  });

  it.each([
    {
      scope: "group",
      group: { disableAudioPreflight: "false" },
      path: "groups.*.disableAudioPreflight",
    },
    {
      scope: "topic",
      group: { topics: { "42": { disableAudioPreflight: "false" } } },
      path: "groups.*.topics.42.disableAudioPreflight",
    },
  ])("rejects non-boolean disableAudioPreflight in $scope config", ({ group, path }) => {
    expectTelegramConfigIssue({ groups: { "*": group } }, path);
  });
});

describe("telegram webhook schema", () => {
  it.each([undefined, false, { port: 0 }, { port: 65535 }])(
    "accepts canonical legacy webhook setting %j",
    (legacyWebhook) => {
      expectTelegramConfigValid({
        webhookUrl: "https://example.com/telegram-webhook",
        webhookSecret: "secret",
        legacyWebhook,
      });
    },
  );

  it.each([-1, 65536])("rejects an out-of-range legacy webhook port %s", (port) => {
    expectTelegramConfigIssue(
      {
        webhookUrl: "https://example.com/telegram-webhook",
        webhookSecret: "secret",
        legacyWebhook: { port },
      },
      "legacyWebhook.port",
    );
  });

  it.each([
    {
      name: "webhookUrl when webhookSecret is configured",
      config: {
        webhookUrl: "https://example.com/telegram-webhook",
        webhookSecret: "secret",
      },
    },
    {
      name: "webhookUrl when webhookSecret is configured as SecretRef",
      config: {
        webhookUrl: "https://example.com/telegram-webhook",
        webhookSecret: {
          source: "env",
          provider: "default",
          id: "TELEGRAM_WEBHOOK_SECRET",
        },
      },
    },
    {
      name: "account webhookUrl when base webhookSecret is configured",
      config: {
        webhookSecret: "secret",
        accounts: {
          ops: {
            webhookUrl: "https://example.com/telegram-webhook",
          },
        },
      },
    },
    {
      name: "account webhookUrl when account webhookSecret is configured as SecretRef",
      config: {
        accounts: {
          ops: {
            webhookUrl: "https://example.com/telegram-webhook",
            webhookSecret: {
              source: "env",
              provider: "default",
              id: "TELEGRAM_OPS_WEBHOOK_SECRET",
            },
          },
        },
      },
    },
  ] as const)("accepts $name", ({ config }) => {
    expectTelegramConfigValid(config);
  });

  it("rejects webhookUrl without webhookSecret", () => {
    expectTelegramConfigIssue(
      {
        webhookUrl: "https://example.com/telegram-webhook",
      },
      "webhookSecret",
    );
  });

  it("rejects account webhookUrl without webhookSecret", () => {
    expectTelegramConfigIssue(
      {
        accounts: {
          ops: {
            webhookUrl: "https://example.com/telegram-webhook",
          },
        },
      },
      "accounts.ops.webhookSecret",
    );
  });
});
