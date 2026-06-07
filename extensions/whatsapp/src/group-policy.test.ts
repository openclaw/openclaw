// Whatsapp tests cover group policy plugin behavior.
import { describe, expect, it } from "vitest";
import {
  resolveWhatsAppChannelGroupPolicy,
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
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

  it("matches exact group subjects for group allowlists and per-group settings", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groups: {
            "Family Chat": {
              requireMention: false,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveWhatsAppChannelGroupPolicy({
        cfg,
        groupId: "1203630@g.us",
        groupSubject: "Family Chat",
      }),
    ).toMatchObject({
      allowlistEnabled: true,
      allowed: true,
      groupConfig: {
        requireMention: false,
        tools: { allow: ["message.send"] },
      },
    });
    expect(
      resolveWhatsAppGroupRequireMention({
        cfg,
        groupId: "1203630@g.us",
        groupSubject: "Family Chat",
      }),
    ).toBe(false);
    expect(
      resolveWhatsAppGroupToolPolicy({
        cfg,
        groupId: "1203630@g.us",
        groupSubject: "Family Chat",
      }),
    ).toEqual({ allow: ["message.send"] });
  });

  it("prefers stable JID config over a group subject when both match", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "1203630@g.us": { requireMention: true, tools: { deny: ["exec"] } },
            "Family Chat": {
              requireMention: false,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveWhatsAppGroupRequireMention({
        cfg,
        groupId: "1203630@g.us",
        groupSubject: "Family Chat",
      }),
    ).toBe(true);
    expect(
      resolveWhatsAppGroupToolPolicy({
        cfg,
        groupId: "1203630@g.us",
        groupSubject: "Family Chat",
      }),
    ).toEqual({ deny: ["exec"] });
  });

  it("matches group names carried through the generic groupChannel tool-policy field", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "Family Chat": {
              tools: { deny: ["exec"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveWhatsAppGroupToolPolicy({
        cfg,
        groupId: "1203630@g.us",
        groupChannel: "Family Chat",
      }),
    ).toEqual({ deny: ["exec"] });
  });
});
