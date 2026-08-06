import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "../doctor-contract-api.js";

describe("FaceTime config migration", () => {
  it("removes only the retired duplex BlackHole audio object", () => {
    const cfg = {
      plugins: {
        entries: {
          facetime: {
            enabled: true,
            config: {
              audio: { blackholeDeviceUid: "BlackHole 16ch" },
              whitelistHandles: ["omar@example.com"],
            },
          },
        },
      },
    } as any;

    expect(legacyConfigRules[0]?.match(cfg.plugins.entries.facetime.config.audio)).toBe(true);
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config).not.toBe(cfg);
    expect((result.config.plugins?.entries?.facetime?.config as any).audio).toBeUndefined();
    expect((result.config.plugins?.entries?.facetime?.config as any).whitelistHandles).toEqual([
      "omar@example.com",
    ]);
    expect(result.changes).toHaveLength(1);
  });

  it("is idempotent after migration", () => {
    const cfg = { plugins: { entries: { facetime: { config: {} } } } } as any;
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
  });
});
