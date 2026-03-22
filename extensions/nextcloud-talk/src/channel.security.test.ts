import { describe, expect, it } from "vitest";
import { nextcloudTalkPlugin } from "./channel.js";
import type { CoreConfig } from "./types.js";

describe("nextcloudTalkPlugin security", () => {
  it("normalizes trimmed dm allowlist prefixes to lowercase ids", () => {
    const resolveDmPolicy = nextcloudTalkPlugin.security?.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const cfg = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "secret",
          dmPolicy: "allowlist",
          allowFrom: ["  nc:User-Id  "],
        },
      },
    } as CoreConfig;

    const result = resolveDmPolicy({
      cfg,
      account: nextcloudTalkPlugin.config.resolveAccount(cfg, "default"),
    });
    if (!result) {
      throw new Error("nextcloud-talk resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  nc:User-Id  "]);
    expect(result.normalizeEntry?.("  nc:User-Id  ")).toBe("user-id");
    expect(nextcloudTalkPlugin.pairing?.normalizeAllowEntry?.("  nextcloud-talk:User-Id  ")).toBe(
      "user-id",
    );
  });
});
