import { describe, expect, it } from "vitest";
import { messengerPlugin } from "./channel.js";

describe("messengerPlugin", () => {
  describe("config.deleteAccount", () => {
    it("removes all credential keys for the default account", () => {
      const cfg = {
        channels: {
          messenger: {
            enabled: true,
            pageAccessToken: "tok-123",
            appSecret: "sec-456",
            verifyToken: "vtk-789",
            tokenFile: "/path/to/token",
            secretFile: "/path/to/secret",
            name: "My Page",
          },
        },
      };

      const result = messengerPlugin.config.deleteAccount({
        cfg,
        accountId: "default",
      });

      const messenger = result.channels?.messenger as Record<string, unknown>;
      expect(messenger).toBeDefined();
      // Credentials must be removed
      expect(messenger.pageAccessToken).toBeUndefined();
      expect(messenger.appSecret).toBeUndefined();
      expect(messenger.verifyToken).toBeUndefined();
      expect(messenger.tokenFile).toBeUndefined();
      expect(messenger.secretFile).toBeUndefined();
      // Non-credential keys must be preserved
      expect(messenger.enabled).toBe(true);
      expect(messenger.name).toBe("My Page");
    });
  });

  describe("status.collectStatusIssues", () => {
    const collect = messengerPlugin.status.collectStatusIssues;

    it("reports missing pageAccessToken", () => {
      const issues = collect([
        { accountId: "default", pageAccessToken: "", appSecret: "s", verifyToken: "v" },
      ] as never);
      expect(issues.some((i) => i.message.includes("page access token"))).toBe(true);
    });

    it("reports missing appSecret", () => {
      const issues = collect([
        { accountId: "default", pageAccessToken: "t", appSecret: "", verifyToken: "v" },
      ] as never);
      expect(issues.some((i) => i.message.includes("app secret"))).toBe(true);
    });

    it("reports missing verifyToken", () => {
      const issues = collect([
        { accountId: "default", pageAccessToken: "t", appSecret: "s", verifyToken: "" },
      ] as never);
      expect(issues.some((i) => i.message.includes("verify token"))).toBe(true);
    });

    it("returns no issues when all credentials are present", () => {
      const issues = collect([
        { accountId: "default", pageAccessToken: "t", appSecret: "s", verifyToken: "v" },
      ] as never);
      expect(issues).toHaveLength(0);
    });
  });
});
