import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../../../src/config/config.js";
import { resolveGroupPolicyFor } from "./group-activation.js";

describe("resolveGroupPolicyFor", () => {
  it("uses account-level groupAllowFrom when account overrides exist", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+1111111111"],
          accounts: {
            work: { groupAllowFrom: ["+2222222222"] },
          },
        },
      },
    };
    // Account "work" has its own groupAllowFrom, so hasGroupAllowFrom resolves
    // from the account-level list. senderFilterBypass allows the group through.
    const result = resolveGroupPolicyFor(cfg, "group@g.us", "work");
    expect(result.allowlistEnabled).toBe(true);
    expect(result.allowed).toBe(true);
  });

  it("falls back to root groupAllowFrom when account has no override", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+1111111111"],
          accounts: {
            work: {},
          },
        },
      },
    };
    // Account "work" has no override, so hasGroupAllowFrom falls back to the
    // root-level groupAllowFrom. senderFilterBypass allows the group through.
    const result = resolveGroupPolicyFor(cfg, "group@g.us", "work");
    expect(result.allowlistEnabled).toBe(true);
    expect(result.allowed).toBe(true);
  });

  it("treats explicit empty account allowFrom as intentional clear", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+1111111111"],
          accounts: {
            // Account explicitly sets allowFrom: [] to clear inherited root lists.
            work: { allowFrom: [] },
          },
        },
      },
    };
    // With explicit empty allowFrom and no groups config, the account has
    // hasGroupAllowFrom = false, so senderFilterBypass is disabled and the
    // group is rejected under allowlist policy.
    const result = resolveGroupPolicyFor(cfg, "group@g.us", "work");
    expect(result.allowlistEnabled).toBe(true);
    expect(result.allowed).toBe(false);
  });

  it("allows group when account has non-empty allowFrom under allowlist policy", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          accounts: {
            work: { allowFrom: ["+3333333333"] },
          },
        },
      },
    };
    // Account has allowFrom with entries, so senderFilterBypass applies.
    const result = resolveGroupPolicyFor(cfg, "group@g.us", "work");
    expect(result.allowlistEnabled).toBe(true);
    expect(result.allowed).toBe(true);
  });
});
