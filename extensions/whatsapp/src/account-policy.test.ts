import {
  createAccountPolicyInheritanceCases,
  validateTestChannelConfig,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "../config-api.js";
import { resolveMergedWhatsAppAccountConfig } from "./account-config.js";

describe("whatsapp account policy inheritance after validation", () => {
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
