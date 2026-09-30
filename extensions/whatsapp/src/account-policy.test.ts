import {
  createAccountPolicyInheritanceCases,
  validateTestChannelConfig,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "../config-api.js";
import { resolveMergedWhatsAppAccountConfig } from "./account-config.js";

describe("whatsapp account policy inheritance after validation", () => {
  it("inherits partial reconnect settings through channel, default account and account", async () => {
    const channel = WhatsAppConfigSchema.parse({
      reconnect: { maxAttempts: 60, maxMs: 120_000 },
      accounts: {
        Default: { reconnect: { maxAttempts: 40 } },
        work: { reconnect: { maxMs: 90_000 } },
        other: {},
      },
    });
    const cfg = await validateTestChannelConfig("whatsapp", channel);
    expect(resolveMergedWhatsAppAccountConfig({ cfg, accountId: "work" }).reconnect).toEqual({
      maxAttempts: 40,
      maxMs: 90_000,
    });
    expect(resolveMergedWhatsAppAccountConfig({ cfg, accountId: "other" }).reconnect).toEqual({
      maxAttempts: 40,
      maxMs: 120_000,
    });
    expect(resolveMergedWhatsAppAccountConfig({ cfg, accountId: "default" }).reconnect).toEqual({
      maxAttempts: 40,
      maxMs: 120_000,
    });
  });

  it.each(createAccountPolicyInheritanceCases())("$name", async ({ root, account, expected }) => {
    const channel = WhatsAppConfigSchema.parse({ ...root, accounts: { work: account } });
    const cfg = await validateTestChannelConfig("whatsapp", channel);
    const resolved = resolveMergedWhatsAppAccountConfig({
      cfg,
      accountId: "work",
    });

    expect(resolved).toMatchObject(expected);
  });
});
