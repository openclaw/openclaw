// Telegram tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { TelegramConfigSchema } from "../config-api.js";

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

  it('rejects dmPolicy="allowlist" without allowFrom', () => {
    expectTelegramConfigIssue({ dmPolicy: "allowlist", botToken: "fake" }, "allowFrom");
  });

  it("rejects account allowlist without account or channel allowFrom", () => {
    expectTelegramConfigIssue(
      { accounts: { bot1: { dmPolicy: "allowlist", botToken: "fake" } } },
      "accounts.bot1.allowFrom",
    );
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

describe("telegram webhook schema", () => {
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
