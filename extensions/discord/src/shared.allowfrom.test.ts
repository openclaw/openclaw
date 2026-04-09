import { describe, expect, it } from "vitest";
import type { ResolvedDiscordAccount } from "./accounts.js";

/**
 * Extracted from discordConfigAdapter.resolveAllowFrom in shared.ts.
 * Tests the resolution logic directly without requiring the full adapter
 * wiring and its heavy module dependencies.
 */
function resolveAllowFrom(account: ResolvedDiscordAccount) {
  return account.config.allowFrom ?? account.config.dm?.allowFrom;
}

function makeAccount(config: Partial<ResolvedDiscordAccount["config"]>): ResolvedDiscordAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "test-token",
    tokenSource: "config",
    config: config as ResolvedDiscordAccount["config"],
  };
}

describe("discord resolveAllowFrom", () => {
  it("reads top-level allowFrom after dm.allowFrom was promoted by normalization", () => {
    const account = makeAccount({ allowFrom: ["123456789"] });
    expect(resolveAllowFrom(account)).toEqual(["123456789"]);
  });

  it("prefers top-level allowFrom over dm.allowFrom when both are present", () => {
    const account = makeAccount({
      allowFrom: ["111111111"],
      dm: { allowFrom: ["222222222"] },
    });
    expect(resolveAllowFrom(account)).toEqual(["111111111"]);
  });

  it("falls back to dm.allowFrom when top-level is absent", () => {
    const account = makeAccount({ dm: { allowFrom: ["987654321"] } });
    expect(resolveAllowFrom(account)).toEqual(["987654321"]);
  });

  it("returns undefined when neither is set", () => {
    const account = makeAccount({});
    expect(resolveAllowFrom(account)).toBeUndefined();
  });

  it("returns empty array without falling back when top-level is empty", () => {
    const account = makeAccount({
      allowFrom: [],
      dm: { allowFrom: ["fallback"] },
    });
    // Nullish coalescing: [] is not nullish, so no fallback.
    expect(resolveAllowFrom(account)).toEqual([]);
  });
});
