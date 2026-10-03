import { moveSingleAccountChannelSectionToDefaultAccount } from "openclaw/plugin-sdk/setup";
import { describe, expect, it } from "vitest";
import { resolveMergedWhatsAppAccountConfig } from "./account-config.js";
import { listWhatsAppAccountIds, resolveDefaultWhatsAppAccountId } from "./account-ids.js";
import { whatsappSetupAdapter, whatsappSetupContract } from "./setup-core.js";

describe("WhatsApp shared root policy", () => {
  const config = {
    channels: {
      whatsapp: {
        dmPolicy: "allowlist" as const,
        allowFrom: ["+15550001111"],
        groupPolicy: "disabled" as const,
        accounts: { work: { authDir: "/synthetic/work" } },
      },
    },
  };

  it("preserves shared defaults and the named default during setup promotion", () => {
    const before = structuredClone(config);
    const migrated = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: config,
      channelKey: "whatsapp",
      setupSurface: whatsappSetupContract,
    });
    expect(migrated).toEqual(before);
    expect(config).toEqual(before);
    expect(listWhatsAppAccountIds(migrated)).toEqual(["work"]);
    expect(resolveDefaultWhatsAppAccountId(migrated)).toBe("work");
    expect(resolveMergedWhatsAppAccountConfig({ cfg: migrated, accountId: "work" })).toMatchObject({
      dmPolicy: "allowlist",
      allowFrom: ["+15550001111"],
      groupPolicy: "disabled",
      authDir: "/synthetic/work",
    });
  });

  it.each(["default", "another"])("still writes an explicitly added %s account", (accountId) => {
    const migrated = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: config,
      channelKey: "whatsapp",
      setupSurface: whatsappSetupContract,
    });
    const updated = whatsappSetupAdapter.applyAccountConfig({
      cfg: migrated,
      accountId,
      input: { authDir: "/synthetic/new-account" },
    });
    expect(updated.channels?.whatsapp).toMatchObject(config.channels.whatsapp);
    expect(updated.channels?.whatsapp?.accounts?.[accountId]).toMatchObject({
      enabled: true,
      authDir: "/synthetic/new-account",
    });
    expect(updated.channels?.whatsapp).not.toHaveProperty("authDir");
  });
});
