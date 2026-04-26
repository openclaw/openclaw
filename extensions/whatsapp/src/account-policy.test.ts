import { describe, expect, it } from "vitest";
import {
  resolveWhatsAppAccountPolicy,
  resolveWhatsAppDirectTargetAuthorization,
} from "./account-policy.js";

describe("resolveWhatsAppAccountPolicy", () => {
  it("prefers explicit accountId over configured defaultAccount", () => {
    const policy = resolveWhatsAppAccountPolicy({
      cfg: {
        channels: {
          whatsapp: {
            defaultAccount: "work",
            accounts: {
              personal: { allowFrom: ["+15550000001"] },
              work: { allowFrom: ["+15550000002"] },
            },
          },
        },
      } as Parameters<typeof resolveWhatsAppAccountPolicy>[0]["cfg"],
      accountId: "personal",
    });

    expect(policy.accountId).toBe("personal");
    expect(policy.configuredAllowFrom).toEqual(["+15550000001"]);
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const policy = resolveWhatsAppAccountPolicy({
      cfg: {
        channels: {
          whatsapp: {
            defaultAccount: "work",
            accounts: {
              work: { allowFrom: ["+15550000002"] },
            },
          },
        },
      } as Parameters<typeof resolveWhatsAppAccountPolicy>[0]["cfg"],
    });

    expect(policy.accountId).toBe("work");
    expect(policy.configuredAllowFrom).toEqual(["+15550000002"]);
  });

  it("falls back to the default account when no preferred account is configured", () => {
    const policy = resolveWhatsAppAccountPolicy({
      cfg: {
        channels: {
          whatsapp: {},
        },
      } as Parameters<typeof resolveWhatsAppAccountPolicy>[0]["cfg"],
    });

    expect(policy.accountId).toBe("default");
  });

  it("inherits shared defaults from accounts.default for named accounts", () => {
    const policy = resolveWhatsAppAccountPolicy({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              default: {
                dmPolicy: "allowlist",
                allowFrom: [" +15550001111 "],
                groupPolicy: "open",
                groupAllowFrom: [" +15550002222 "],
              },
              work: {},
            },
          },
        },
      } as Parameters<typeof resolveWhatsAppAccountPolicy>[0]["cfg"],
      accountId: "work",
    });

    expect(policy.dmPolicy).toBe("allowlist");
    expect(policy.groupPolicy).toBe("open");
    expect(policy.configuredAllowFrom).toEqual(["+15550001111"]);
    expect(policy.groupAllowFrom).toEqual(["+15550002222"]);
  });

  it("does not inherit default-only authDir or selfChatMode for named accounts", () => {
    const policy = resolveWhatsAppAccountPolicy({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              default: {
                authDir: "/tmp/default-auth",
                selfChatMode: true,
              },
              work: {},
            },
          },
        },
      } as Parameters<typeof resolveWhatsAppAccountPolicy>[0]["cfg"],
      accountId: "work",
      selfE164: "+15550009999",
    });

    expect(policy.account.authDir).toMatch(/whatsapp[/\\]work$/);
    expect(policy.account.selfChatMode).toBeUndefined();
    expect(policy.isSelfChat).toBe(false);
  });

  it("falls back groupAllowFrom to allowFrom when unset", () => {
    const policy = resolveWhatsAppAccountPolicy({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: [" +15550001111 ", "+15550002222"],
          },
        },
      } as Parameters<typeof resolveWhatsAppAccountPolicy>[0]["cfg"],
    });

    expect(policy.configuredAllowFrom).toEqual(["+15550001111", "+15550002222"]);
    expect(policy.groupAllowFrom).toEqual(["+15550001111", "+15550002222"]);
  });

  it("keeps self-chat classification inputs aligned with allowFrom and selfE164", () => {
    const policy = resolveWhatsAppAccountPolicy({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+15550009999"],
          },
        },
      } as Parameters<typeof resolveWhatsAppAccountPolicy>[0]["cfg"],
      selfE164: "+15550009999",
    });

    expect(policy.dmAllowFrom).toEqual(["+15550009999"]);
    expect(policy.isSamePhone("+15550009999")).toBe(true);
    expect(policy.isDmSenderAllowed(policy.dmAllowFrom, "+15550009999")).toBe(true);
    expect(policy.isSelfChat).toBe(true);
  });
});

describe("resolveWhatsAppDirectTargetAuthorization", () => {
  it("allows wildcard direct targets", () => {
    const authorized = resolveWhatsAppDirectTargetAuthorization({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["*"],
          },
        },
      } as Parameters<typeof resolveWhatsAppDirectTargetAuthorization>[0]["cfg"],
      to: "+15550007777",
    });

    expect(authorized.accountId).toBe("default");
    expect(authorized.resolution).toEqual({ ok: true, to: "+15550007777" });
  });

  it("allows direct targets when allowFrom is empty", () => {
    const authorized = resolveWhatsAppDirectTargetAuthorization({
      cfg: {
        channels: {
          whatsapp: {},
        },
      } as Parameters<typeof resolveWhatsAppDirectTargetAuthorization>[0]["cfg"],
      to: "+15550007777",
    });

    expect(authorized.resolution).toEqual({ ok: true, to: "+15550007777" });
  });

  it("blocks non-allowlisted direct targets", () => {
    const authorized = resolveWhatsAppDirectTargetAuthorization({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+15550001111"],
          },
        },
      } as Parameters<typeof resolveWhatsAppDirectTargetAuthorization>[0]["cfg"],
      to: "+15550007777",
    });

    expect(authorized.resolution.ok).toBe(false);
  });

  it("always allows group JIDs", () => {
    const authorized = resolveWhatsAppDirectTargetAuthorization({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+15550001111"],
          },
        },
      } as Parameters<typeof resolveWhatsAppDirectTargetAuthorization>[0]["cfg"],
      to: "12345@g.us",
    });

    expect(authorized.resolution).toEqual({ ok: true, to: "12345@g.us" });
  });
});
