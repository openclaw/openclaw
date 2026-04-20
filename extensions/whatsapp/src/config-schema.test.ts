import { describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "../config-api.js";

function expectWhatsAppConfigValid(config: unknown) {
  const res = WhatsAppConfigSchema.safeParse(config);
  expect(res.success).toBe(true);
  return res;
}

describe("whatsapp config schema", () => {
  it("accepts textChunkLimit", () => {
    const res = expectWhatsAppConfigValid({
      allowFrom: ["+15555550123"],
      textChunkLimit: 4444,
    });

    if (res.success) {
      expect(res.data.textChunkLimit).toBe(4444);
    }
  });

  it("accepts enabled", () => {
    expectWhatsAppConfigValid({
      enabled: true,
    });
  });

  it("keeps inherited account defaults unset at account scope", () => {
    const res = expectWhatsAppConfigValid({
      dmPolicy: "allowlist",
      groupPolicy: "open",
      debounceMs: 250,
      allowFrom: ["+15550001111"],
      accounts: {
        work: {
          allowFrom: ["+15550002222"],
        },
      },
    });

    if (!res.success) {
      return;
    }
    expect(res.data.dmPolicy).toBe("allowlist");
    expect(res.data.groupPolicy).toBe("open");
    expect(res.data.debounceMs).toBe(250);
    expect(res.data.accounts?.work?.dmPolicy).toBeUndefined();
    expect(res.data.accounts?.work?.groupPolicy).toBeUndefined();
    expect(res.data.accounts?.work?.debounceMs).toBeUndefined();
  });

  it("accepts allowlist accounts inheriting allowFrom from accounts.default", () => {
    expectWhatsAppConfigValid({
      accounts: {
        default: {
          allowFrom: ["+15550001111"],
        },
        work: {
          dmPolicy: "allowlist",
        },
      },
    });
  });

  it("accepts allowlist accounts inheriting allowFrom from mixed-case accounts.Default", () => {
    expectWhatsAppConfigValid({
      accounts: {
        Default: {
          allowFrom: ["+15550001111"],
        },
        work: {
          dmPolicy: "allowlist",
        },
      },
    });
  });
});
