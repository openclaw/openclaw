import { describe, expect, it } from "vitest";
import { zalouserDoctor } from "./doctor.js";

function config(groups: Record<string, unknown>, accounts?: Record<string, unknown>) {
  return { channels: { zalouser: { groups, ...(accounts ? { accounts } : {}) } } } as never;
}

describe("zalouser doctor", () => {
  it("warns when mutable group names rely on disabled name matching", async () => {
    const warnings = await Promise.resolve(
      zalouserDoctor.collectMutableAllowlistWarnings?.({
        cfg: config({ "group:trusted": { enabled: true } }),
      }) ?? [],
    );

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mutable allowlist entry across zalouser"),
        expect.stringContaining("channels.zalouser.groups: group:trusted"),
      ]),
    );
  });

  it("normalizes legacy group allow aliases to enabled", () => {
    const normalize = zalouserDoctor.normalizeCompatibilityConfig;
    if (!normalize) {
      throw new Error("Expected zalouser doctor to expose normalizeCompatibilityConfig");
    }

    const result = normalize({
      cfg: config(
        {
          "group:trusted": { allow: true },
          "group:disabled": { allow: true, enabled: false },
          "group:invalid-enabled": { allow: false, enabled: "invalid" },
          "group:invalid-allow": { allow: "true" },
        },
        { work: { groups: { "group:legacy": { allow: false } } } },
      ),
    });

    expect(result.config.channels?.zalouser?.groups).toEqual({
      "group:trusted": { enabled: true },
      "group:disabled": { enabled: false },
      "group:invalid-enabled": { enabled: false },
      "group:invalid-allow": { allow: "true" },
    });
    expect(result.config.channels?.zalouser?.accounts?.work).toEqual({
      groups: { "group:legacy": { enabled: false } },
    });
    expect(result.changes).toEqual([
      "Moved channels.zalouser.groups.group:trusted.allow → channels.zalouser.groups.group:trusted.enabled (true).",
      "Moved channels.zalouser.groups.group:disabled.allow → channels.zalouser.groups.group:disabled.enabled (false).",
      "Moved channels.zalouser.groups.group:invalid-enabled.allow → channels.zalouser.groups.group:invalid-enabled.enabled (false).",
      "Moved channels.zalouser.accounts.work.groups.group:legacy.allow → channels.zalouser.accounts.work.groups.group:legacy.enabled (false).",
    ]);
    expect(normalize({ cfg: result.config })).toEqual({ config: result.config, changes: [] });
  });
});
