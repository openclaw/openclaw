import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveTwitchToken } from "./token.js";

describe("token", () => {
  const originalAccessToken = process.env.OPENCLAW_TWITCH_ACCESS_TOKEN;

  // Simplified single-account config
  const mockSimplifiedConfig = {
    channels: {
      twitch: {
        username: "testbot",
        accessToken: "oauth:config-token",
      },
    },
  } as unknown as OpenClawConfig;

  afterEach(() => {
    if (originalAccessToken === undefined) {
      delete process.env.OPENCLAW_TWITCH_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_TWITCH_ACCESS_TOKEN = originalAccessToken;
    }
  });

  describe("resolveTwitchToken", () => {
    it("should prioritize config token over env var (simplified config)", () => {
      process.env.OPENCLAW_TWITCH_ACCESS_TOKEN = "oauth:env-token";

      const result = resolveTwitchToken(mockSimplifiedConfig, { accountId: "default" });

      // Config token should be used even if env var exists
      expect(result.token).toBe("oauth:config-token");
    });

    it("should use env var when config token is empty (simplified config)", () => {
      process.env.OPENCLAW_TWITCH_ACCESS_TOKEN = "oauth:env-token";

      const configWithEmptyToken = {
        channels: {
          twitch: {
            username: "testbot",
            accessToken: "",
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveTwitchToken(configWithEmptyToken, { accountId: "default" });

      expect(result.token).toBe("oauth:env-token");
    });

    it("should not use env var for non-default accounts (multi-account)", () => {
      process.env.OPENCLAW_TWITCH_ACCESS_TOKEN = "oauth:env-token";

      const configWithoutToken = {
        channels: {
          twitch: {
            accounts: {
              secondary: {
                username: "secondary",
                accessToken: "",
              },
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveTwitchToken(configWithoutToken, { accountId: "secondary" });

      // Non-default accounts shouldn't use env var
      expect(result.token).toBe("");
    });
  });
});
