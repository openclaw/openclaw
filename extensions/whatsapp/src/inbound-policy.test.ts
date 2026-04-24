import { describe, expect, it } from "vitest";
import { resolveWhatsAppInboundPolicy } from "./inbound-policy.js";
import type { OpenClawConfig } from "./runtime-api.js";

describe("resolveWhatsAppInboundPolicy", () => {
  it("does not let DM allowFrom entries bypass the group allowlist gate", () => {
    // Regression for the senderFilterBypass path: when DM allowFrom is set,
    // groupAllowFrom is absent, groupPolicy is allowlist, and no groups are
    // configured, a random group sender must still be denied. Previously,
    // resolveGroupAllowFromSources silently fell back from an empty
    // groupAllowFrom to allowFrom, which promoted the DM entries into
    // effectiveGroupAllowFrom and flipped senderFilterBypass on for every
    // group.
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          allowFrom: ["+15551234567"],
        },
      },
    } as OpenClawConfig;

    const policy = resolveWhatsAppInboundPolicy({ cfg, selfE164: "+19995551212" });

    // DM allowFrom must not leak into the resolved groupAllowFrom.
    expect(policy.groupAllowFrom).toEqual([]);

    // A random group that is NOT in the (empty) groupAllowFrom and has no
    // explicit groups entry must not be allowed through via senderFilterBypass.
    const groupPolicy = policy.resolveConversationGroupPolicy("120363000000000000@g.us");
    expect(groupPolicy.allowlistEnabled).toBe(true);
    expect(groupPolicy.allowed).toBe(false);
  });

  it("keeps explicit groupAllowFrom working independently of DM allowFrom", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          allowFrom: ["+15551234567"],
          groupAllowFrom: ["+19998887777"],
        },
      },
    } as OpenClawConfig;

    const policy = resolveWhatsAppInboundPolicy({ cfg, selfE164: "+19995551212" });

    expect(policy.groupAllowFrom).toEqual(["+19998887777"]);

    // With an explicit groupAllowFrom and no explicit group entries, senderFilterBypass
    // legitimately allows the group through; sender-level filtering handles the rest.
    const groupPolicy = policy.resolveConversationGroupPolicy("120363000000000000@g.us");
    expect(groupPolicy.allowed).toBe(true);
  });
});
