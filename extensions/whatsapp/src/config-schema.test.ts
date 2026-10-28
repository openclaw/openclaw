import { describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "../config-api.js";

describe("whatsapp config schema", () => {
  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const res = WhatsAppConfigSchema.safeParse({
      dmPolicy: "open",
      allowFrom: ["+15555550123"],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("allowFrom");
    }
  });

  it('accepts dmPolicy="open" with allowFrom "*"', () => {
    expect(WhatsAppConfigSchema.parse({ dmPolicy: "open", allowFrom: ["*"] }).dmPolicy).toBe(
      "open",
    );
  });

  it("defaults dm/group policy", () => {
    expect(WhatsAppConfigSchema.parse({})).toMatchObject({
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    });
  });

  it("accepts historyLimit overrides per account", () => {
    expect(
      WhatsAppConfigSchema.parse({ historyLimit: 9, accounts: { work: { historyLimit: 4 } } }),
    ).toMatchObject({ historyLimit: 9, accounts: { work: { historyLimit: 4 } } });
  });

  it("accepts textChunkLimit", () => {
    expect(
      WhatsAppConfigSchema.parse({ allowFrom: ["+15555550123"], textChunkLimit: 4444 })
        .textChunkLimit,
    ).toBe(4444);
  });

  it("accepts enabled", () => {
    expect(WhatsAppConfigSchema.parse({ enabled: true }).enabled).toBe(true);
  });

  it("accepts the experimental call action opt-in", () => {
    expect(WhatsAppConfigSchema.parse({ actions: { calls: true } }).actions?.calls).toBe(true);
  });

  it("keeps inherited account defaults unset at account scope", () => {
    const channel = WhatsAppConfigSchema.parse({
      dmPolicy: "allowlist",
      groupPolicy: "open",
      allowFrom: ["+15550001111"],
      accounts: { work: { allowFrom: ["+15550002222"] } },
    });
    expect(channel.dmPolicy).toBe("allowlist");
    expect(channel.groupPolicy).toBe("open");
    expect(channel.accounts?.work?.dmPolicy).toBeUndefined();
    expect(channel.accounts?.work?.groupPolicy).toBeUndefined();
  });

  it("accepts allowlist accounts inheriting allowFrom from mixed-case accounts.Default", () => {
    expect(
      WhatsAppConfigSchema.safeParse({
        accounts: {
          Default: { allowFrom: ["+15550001111"] },
          work: { dmPolicy: "allowlist" },
        },
      }).success,
    ).toBe(true);
  });
});
