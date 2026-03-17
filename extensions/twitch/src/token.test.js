import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTwitchToken } from "./token.js";
describe("token", () => {
  const mockMultiAccountConfig = {
    channels: {
      twitch: {
        accounts: {
          default: {
            username: "testbot",
            accessToken: "oauth:config-token"
          },
          other: {
            username: "otherbot",
            accessToken: "oauth:other-token"
          }
        }
      }
    }
  };
  const mockSimplifiedConfig = {
    channels: {
      twitch: {
        username: "testbot",
        accessToken: "oauth:config-token"
      }
    }
  };
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENCLAW_TWITCH_ACCESS_TOKEN;
  });
  describe("resolveTwitchToken", () => {
    it("should resolve token from simplified config for default account", () => {
      const result = resolveTwitchToken(mockSimplifiedConfig, { accountId: "default" });
      expect(result.token).toBe("oauth:config-token");
      expect(result.source).toBe("config");
    });
    it("should resolve token from config for non-default account (multi-account)", () => {
      const result = resolveTwitchToken(mockMultiAccountConfig, { accountId: "other" });
      expect(result.token).toBe("oauth:other-token");
      expect(result.source).toBe("config");
    });
    it("should prioritize config token over env var (simplified config)", () => {
      process.env.OPENCLAW_TWITCH_ACCESS_TOKEN = "oauth:env-token";
      const result = resolveTwitchToken(mockSimplifiedConfig, { accountId: "default" });
      expect(result.token).toBe("oauth:config-token");
      expect(result.source).toBe("config");
    });
    it("should use env var when config token is empty (simplified config)", () => {
      process.env.OPENCLAW_TWITCH_ACCESS_TOKEN = "oauth:env-token";
      const configWithEmptyToken = {
        channels: {
          twitch: {
            username: "testbot",
            accessToken: ""
          }
        }
      };
      const result = resolveTwitchToken(configWithEmptyToken, { accountId: "default" });
      expect(result.token).toBe("oauth:env-token");
      expect(result.source).toBe("env");
    });
    it("should return empty token when neither config nor env has token (simplified config)", () => {
      const configWithoutToken = {
        channels: {
          twitch: {
            username: "testbot",
            accessToken: ""
          }
        }
      };
      const result = resolveTwitchToken(configWithoutToken, { accountId: "default" });
      expect(result.token).toBe("");
      expect(result.source).toBe("none");
    });
    it("should not use env var for non-default accounts (multi-account)", () => {
      process.env.OPENCLAW_TWITCH_ACCESS_TOKEN = "oauth:env-token";
      const configWithoutToken = {
        channels: {
          twitch: {
            accounts: {
              secondary: {
                username: "secondary",
                accessToken: ""
              }
            }
          }
        }
      };
      const result = resolveTwitchToken(configWithoutToken, { accountId: "secondary" });
      expect(result.token).toBe("");
      expect(result.source).toBe("none");
    });
    it("should handle missing account gracefully", () => {
      const configWithoutAccount = {
        channels: {
          twitch: {
            accounts: {}
          }
        }
      };
      const result = resolveTwitchToken(configWithoutAccount, { accountId: "nonexistent" });
      expect(result.token).toBe("");
      expect(result.source).toBe("none");
    });
    it("should handle missing Twitch config section", () => {
      const configWithoutSection = {
        channels: {}
      };
      const result = resolveTwitchToken(configWithoutSection, { accountId: "default" });
      expect(result.token).toBe("");
      expect(result.source).toBe("none");
    });
  });
  describe("TwitchTokenSource type", () => {
    it("should have correct values", () => {
      const sources = ["env", "config", "none"];
      expect(sources).toContain("env");
      expect(sources).toContain("config");
      expect(sources).toContain("none");
    });
  });
});
