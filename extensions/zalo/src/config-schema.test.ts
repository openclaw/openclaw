// Zalo tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { ZaloConfigSchema } from "./config-schema.js";
import type { ZaloConfig } from "./types.js";

describe("ZaloConfigSchema SecretInput", () => {
  it("accepts SecretRef botToken and webhookSecret at top-level", () => {
    const result = ZaloConfigSchema.safeParse({
      botToken: { source: "env", provider: "default", id: "ZALO_BOT_TOKEN" },
      webhookUrl: "https://example.com/zalo",
      webhookSecret: { source: "env", provider: "default", id: "ZALO_WEBHOOK_SECRET" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef botToken and webhookSecret on account", () => {
    const input = {
      defaultAccount: "work",
      accounts: {
        work: {
          markdown: { tables: "off" },
          botToken: { source: "env", provider: "default", id: "ZALO_WORK_BOT_TOKEN" },
          webhookUrl: "https://example.com/zalo/work",
          webhookSecret: {
            source: "env",
            provider: "default",
            id: "ZALO_WORK_WEBHOOK_SECRET",
          },
        },
      },
    } satisfies ZaloConfig;
    const result = ZaloConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe("ZaloConfigSchema groups", () => {
  it("accepts groups at top level and per account", () => {
    const input = {
      groups: { "zgr-top": { enabled: true, tools: { deny: ["exec"] } } },
      accounts: { work: { groups: { "zgr-work": {}, "*": { enabled: false } } } },
    } satisfies ZaloConfig;
    expect(ZaloConfigSchema.safeParse(input).success).toBe(true);
  });

  it("rejects requireMention because Zalo only delivers mentioned group messages", () => {
    const result = ZaloConfigSchema.safeParse({
      groups: { "zgr-top": { requireMention: false } },
    });
    expect(result.success).toBe(false);
  });
});
