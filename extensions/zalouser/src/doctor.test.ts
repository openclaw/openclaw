import { describe, expect, it } from "vitest";
import { zalouserDoctor } from "./doctor.js";

describe("zalouser doctor", () => {
  it("normalizes legacy group allow aliases to enabled", () => {
    const normalize = zalouserDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
        channels: {
          zalouser: {
            groups: {
              "group:trusted": {
                allow: true,
              },
            },
            accounts: {
              work: {
                groups: {
                  "group:legacy": {
                    allow: false,
                  },
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.zalouser?.groups?.["group:trusted"]).toEqual({
      enabled: true,
    });
    expect(result.config.channels?.zalouser?.accounts?.work?.groups?.["group:legacy"]).toEqual({
      enabled: false,
    });
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.zalouser.groups.group:trusted.allow → channels.zalouser.groups.group:trusted.enabled (true).",
        "Moved channels.zalouser.accounts.work.groups.group:legacy.allow → channels.zalouser.accounts.work.groups.group:legacy.enabled (false).",
      ]),
    );
  });
});
