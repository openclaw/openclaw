import { describe, expect, it } from "vitest";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
import {
  resolveWhatsAppInboundPolicy,
  resolveWhatsAppCommandAuthorized,
} from "./inbound-policy.js";
import type { OpenClawConfig } from "./runtime-api.js";

describe("whatsapp group policy", () => {
  it("uses generic channel group policy helpers", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "1203630@g.us": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveWhatsAppGroupRequireMention({ cfg, groupId: "1203630@g.us" })).toBe(false);
    expect(resolveWhatsAppGroupRequireMention({ cfg, groupId: "other@g.us" })).toBe(true);
    expect(resolveWhatsAppGroupToolPolicy({ cfg, groupId: "1203630@g.us" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveWhatsAppGroupToolPolicy({ cfg, groupId: "other@g.us" })).toEqual({
      allow: ["message.send"],
    });
  });

  it("admins bypass mention requirements", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "1203630@g.us": {
              requireMention: true,
              admin: "+15550001111", // Admin number
            },
          },
        },
      },
    } as OpenClawConfig;

    const policy = resolveWhatsAppInboundPolicy({
      cfg,
      accountId: "default",
      selfE164: "+15550009999",
    });

    // Admin doesn't need to be mentioned
    expect(policy.resolveConversationRequireMention("1203630@g.us", "+15550001111")).toBe(false);
    // Non-admin needs to be mentioned
    expect(policy.resolveConversationRequireMention("1203630@g.us", "+15550002222")).toBe(true);
  });

  it("command authorization restricts non-admins in groups", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "open",
          groups: {
            "1203630@g.us": {
              admin: "+15550001111", // Admin number
            },
          },
        },
      },
    } as OpenClawConfig;

    const msg = {
      accountId: "default",
      chatType: "group",
      from: "1203630@g.us",
      senderE164: "+15550002222", // Non-admin
      selfE164: "+15550009999",
      body: "/status",
      to: "+15550009999",
    } as const;

    const isAuthorized = await resolveWhatsAppCommandAuthorized({
      cfg,
      msg: msg as any,
    });

    // Non-admin should not be authorized to run commands in groups
    expect(isAuthorized).toBe(false);
  });

  it("allows the configured group admin to run group commands", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "open",
          groups: {
            "1203630@g.us": {
              admin: "+15550001111",
            },
          },
        },
      },
    } as OpenClawConfig;

    const isAuthorized = await resolveWhatsAppCommandAuthorized({
      cfg,
      msg: {
        accountId: "default",
        chatType: "group",
        from: "1203630@g.us",
        senderE164: "+15550001111",
        selfE164: "+15550009999",
        body: "/status",
        to: "+15550009999",
      } as any,
    });

    expect(isAuthorized).toBe(true);
  });

  it("preserves existing allowlist-based command access when no admin is configured", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15550002222"],
        },
      },
    } as OpenClawConfig;

    const isAuthorized = await resolveWhatsAppCommandAuthorized({
      cfg,
      msg: {
        accountId: "default",
        chatType: "group",
        from: "1203630@g.us",
        senderE164: "+15550002222",
        selfE164: "+15550009999",
        body: "/status",
        to: "+15550009999",
      } as any,
    });

    expect(isAuthorized).toBe(true);
  });

  it("supports wildcard admin config for mention bypass and commands", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "open",
          groups: {
            "*": {
              requireMention: true,
              admin: "+15550001111",
            },
          },
        },
      },
    } as OpenClawConfig;

    const policy = resolveWhatsAppInboundPolicy({
      cfg,
      accountId: "default",
      selfE164: "+15550009999",
    });

    expect(policy.resolveConversationRequireMention("1203630@g.us", "+15550001111")).toBe(false);

    const isAuthorized = await resolveWhatsAppCommandAuthorized({
      cfg,
      msg: {
        accountId: "default",
        chatType: "group",
        from: "1203630@g.us",
        senderE164: "+15550001111",
        selfE164: "+15550009999",
        body: "/status",
        to: "+15550009999",
      } as any,
    });

    expect(isAuthorized).toBe(true);
  });
});
