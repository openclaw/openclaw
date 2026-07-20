import { describe, expect, it } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  sessionRouteStateOwners,
} from "./doctor-contract-api.js";

describe("claude doctor contract", () => {
  it("starts with no legacy config rules (no retired keys yet)", () => {
    expect(legacyConfigRules).toEqual([]);
  });

  it("normalizeCompatibilityConfig is a no-op until claude accumulates retired keys", () => {
    const original = {
      plugins: {
        entries: {
          claude: {
            enabled: true,
            config: {
              appServer: { mode: "managed" },
            },
          },
        },
      },
    };
    const result = normalizeCompatibilityConfig({ cfg: original });
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(original);
  });

  it("claims anthropic and claude provider/auth-profile prefixes", () => {
    expect(sessionRouteStateOwners).toHaveLength(1);
    const owner = sessionRouteStateOwners[0];
    if (!owner) {
      throw new Error("expected sessionRouteStateOwners[0]");
    }
    expect(owner.id).toBe("claude");
    expect(owner.providerIds).toEqual(expect.arrayContaining(["anthropic", "claude"]));
    expect(owner.runtimeIds).toEqual(expect.arrayContaining(["claude", "claude-bridge"]));
    expect(owner.authProfilePrefixes).toEqual(expect.arrayContaining(["anthropic:", "claude:"]));
  });

  // Regression guard for GLM review G6: the doctor-contract registry validator
  // (isDoctorSessionRouteStateOwner) rejects any owner carrying an EMPTY-ARRAY
  // field — `[]` is not `undefined` and normalizes to length 0, failing the
  // "=== undefined || length > 0" guard — which silently drops the whole owner
  // from the scan. A previous `cliSessionKeys: []` made this owner never load.
  it("declares no empty-array fields (they would be dropped by the registry validator)", () => {
    for (const owner of sessionRouteStateOwners) {
      for (const field of [
        "providerIds",
        "runtimeIds",
        "cliSessionKeys",
        "authProfilePrefixes",
      ] as const) {
        const value = owner[field];
        if (value !== undefined) {
          expect(value.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
