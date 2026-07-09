import { describe, expect, it } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  sessionRouteStateOwners,
} from "./doctor-contract-api.js";

describe("glm-bridge doctor contract (GLM review G6)", () => {
  it("starts with no legacy config rules (no retired keys yet)", () => {
    expect(legacyConfigRules).toEqual([]);
  });

  it("normalizeCompatibilityConfig is a no-op until glm-bridge accumulates retired keys", () => {
    const original = {
      plugins: {
        entries: {
          "glm-bridge": {
            enabled: true,
            config: { appServer: { modelProvider: "zai" } },
          },
        },
      },
    };
    const result = normalizeCompatibilityConfig({ cfg: original });
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(original);
  });

  it("claims the zai provider and 'zai:' auth-profile prefix, distinct from Claude", () => {
    expect(sessionRouteStateOwners).toHaveLength(1);
    const owner = sessionRouteStateOwners[0];
    if (!owner) {
      throw new Error("expected sessionRouteStateOwners[0]");
    }
    expect(owner.id).toBe("glm-bridge");
    expect(owner.providerIds).toEqual(["zai"]);
    expect(owner.authProfilePrefixes).toEqual(["zai:"]);
  });

  it("does NOT claim the shared claude-bridge runtimeId (would double-attribute)", () => {
    const owner = sessionRouteStateOwners[0];
    // runtimeIds is intentionally omitted so a claude-bridge-runtime session is
    // attributed to exactly one owner. Attribution is via provider/auth only.
    expect(owner?.runtimeIds ?? []).not.toContain("claude-bridge");
  });

  // The doctor-contract registry validator (isDoctorSessionRouteStateOwner)
  // rejects any owner carrying an EMPTY-ARRAY field, silently dropping the whole
  // owner. Empty fields must be omitted (left undefined), not set to [].
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
