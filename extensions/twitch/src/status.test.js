import { describe, expect, it } from "vitest";
import { collectTwitchStatusIssues } from "./status.js";
function createSnapshot(overrides = {}) {
  return {
    accountId: "default",
    configured: true,
    enabled: true,
    running: false,
    ...overrides
  };
}
function createSimpleTwitchConfig(overrides) {
  return {
    channels: {
      twitch: overrides
    }
  };
}
describe("status", () => {
  describe("collectTwitchStatusIssues", () => {
    it("should detect unconfigured accounts", () => {
      const snapshots = [createSnapshot({ configured: false })];
      const issues = collectTwitchStatusIssues(snapshots);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]?.kind).toBe("config");
      expect(issues[0]?.message).toContain("not properly configured");
    });
    it("should detect disabled accounts", () => {
      const snapshots = [createSnapshot({ enabled: false })];
      const issues = collectTwitchStatusIssues(snapshots);
      expect(issues.length).toBeGreaterThan(0);
      const disabledIssue = issues.find((i) => i.message.includes("disabled"));
      expect(disabledIssue).toBeDefined();
    });
    it("should detect missing clientId when account configured (simplified config)", () => {
      const snapshots = [createSnapshot()];
      const mockCfg = createSimpleTwitchConfig({
        username: "testbot",
        accessToken: "oauth:test123"
        // clientId missing
      });
      const issues = collectTwitchStatusIssues(snapshots, () => mockCfg);
      const clientIdIssue = issues.find((i) => i.message.includes("client ID"));
      expect(clientIdIssue).toBeDefined();
    });
    it("should warn about oauth: prefix in token (simplified config)", () => {
      const snapshots = [createSnapshot()];
      const mockCfg = createSimpleTwitchConfig({
        username: "testbot",
        accessToken: "oauth:test123",
        // has prefix
        clientId: "test-id"
      });
      const issues = collectTwitchStatusIssues(snapshots, () => mockCfg);
      const prefixIssue = issues.find((i) => i.message.includes("oauth:"));
      expect(prefixIssue).toBeDefined();
      expect(prefixIssue?.kind).toBe("config");
    });
    it("should detect clientSecret without refreshToken (simplified config)", () => {
      const snapshots = [createSnapshot()];
      const mockCfg = createSimpleTwitchConfig({
        username: "testbot",
        accessToken: "oauth:test123",
        clientId: "test-id",
        clientSecret: "secret123"
        // refreshToken missing
      });
      const issues = collectTwitchStatusIssues(snapshots, () => mockCfg);
      const secretIssue = issues.find((i) => i.message.includes("clientSecret"));
      expect(secretIssue).toBeDefined();
    });
    it("should detect empty allowFrom array (simplified config)", () => {
      const snapshots = [createSnapshot()];
      const mockCfg = createSimpleTwitchConfig({
        username: "testbot",
        accessToken: "test123",
        clientId: "test-id",
        allowFrom: []
        // empty array
      });
      const issues = collectTwitchStatusIssues(snapshots, () => mockCfg);
      const allowFromIssue = issues.find((i) => i.message.includes("allowFrom"));
      expect(allowFromIssue).toBeDefined();
    });
    it("should detect allowedRoles 'all' with allowFrom conflict (simplified config)", () => {
      const snapshots = [createSnapshot()];
      const mockCfg = createSimpleTwitchConfig({
        username: "testbot",
        accessToken: "test123",
        clientId: "test-id",
        allowedRoles: ["all"],
        allowFrom: ["123456"]
        // conflict!
      });
      const issues = collectTwitchStatusIssues(snapshots, () => mockCfg);
      const conflictIssue = issues.find((i) => i.kind === "intent");
      expect(conflictIssue).toBeDefined();
      expect(conflictIssue?.message).toContain("allowedRoles is set to 'all'");
    });
    it("should detect runtime errors", () => {
      const snapshots = [
        createSnapshot({ lastError: "Connection timeout" })
      ];
      const issues = collectTwitchStatusIssues(snapshots);
      const runtimeIssue = issues.find((i) => i.kind === "runtime");
      expect(runtimeIssue).toBeDefined();
      expect(runtimeIssue?.message).toContain("Connection timeout");
    });
    it("should detect accounts that never connected", () => {
      const snapshots = [
        createSnapshot({
          lastStartAt: void 0,
          lastInboundAt: void 0,
          lastOutboundAt: void 0
        })
      ];
      const issues = collectTwitchStatusIssues(snapshots);
      const neverConnectedIssue = issues.find(
        (i) => i.message.includes("never connected successfully")
      );
      expect(neverConnectedIssue).toBeDefined();
    });
    it("should detect long-running connections", () => {
      const oldDate = Date.now() - 8 * 24 * 60 * 60 * 1e3;
      const snapshots = [
        createSnapshot({
          running: true,
          lastStartAt: oldDate
        })
      ];
      const issues = collectTwitchStatusIssues(snapshots);
      const uptimeIssue = issues.find((i) => i.message.includes("running for"));
      expect(uptimeIssue).toBeDefined();
    });
    it("should handle empty snapshots array", () => {
      const issues = collectTwitchStatusIssues([]);
      expect(issues).toEqual([]);
    });
    it("should skip non-Twitch accounts gracefully", () => {
      const snapshots = [
        {
          accountId: "unknown",
          configured: false,
          enabled: true,
          running: false
        }
      ];
      const issues = collectTwitchStatusIssues(snapshots);
      expect(Array.isArray(issues)).toBe(true);
    });
  });
});
