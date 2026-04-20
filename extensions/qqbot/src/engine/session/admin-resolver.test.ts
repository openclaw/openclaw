import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAdminMarkerFile,
  getLegacyAdminMarkerFile,
  getUpgradeGreetingTargetFile,
} from "../utils/data-paths.js";
import {
  clearUpgradeGreetingTargetOpenId,
  loadAdminOpenId,
  loadUpgradeGreetingTargetOpenId,
  saveAdminOpenId,
} from "./admin-resolver.js";

/**
 * These tests operate on `~/.openclaw/qqbot/data` directly, using a
 * pid-scoped accountId so they do not collide with the user's real
 * QQBot state. A `beforeEach` / `afterEach` pair cleans up.
 */
describe("engine/session/admin-resolver", () => {
  const acct = `test-admin-${process.pid}-${Date.now()}`;
  const otherAcct = `test-admin-other-${process.pid}-${Date.now()}`;

  function cleanup() {
    const files = [
      getAdminMarkerFile(acct, "app-1"),
      getAdminMarkerFile(acct, "app-2"),
      getAdminMarkerFile(otherAcct, "app-1"),
      getLegacyAdminMarkerFile(acct),
      getUpgradeGreetingTargetFile(acct, "app-1"),
      getUpgradeGreetingTargetFile(acct, "app-other"),
    ];
    for (const f of files) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }

  beforeEach(cleanup);
  afterEach(cleanup);

  describe("loadAdminOpenId / saveAdminOpenId", () => {
    it("round-trips the admin openid using the new (accountId, appId) path", () => {
      saveAdminOpenId(acct, "app-1", "openid-abc");
      expect(loadAdminOpenId(acct, "app-1")).toBe("openid-abc");
      expect(fs.existsSync(getAdminMarkerFile(acct, "app-1"))).toBe(true);
    });

    it("returns undefined when no file exists", () => {
      expect(loadAdminOpenId(acct, "app-1")).toBeUndefined();
    });

    it("migrates legacy per-account file to the new (accountId, appId) path", () => {
      const legacyPath = getLegacyAdminMarkerFile(acct);
      fs.writeFileSync(legacyPath, JSON.stringify({ openid: "legacy-openid" }));

      expect(loadAdminOpenId(acct, "app-1")).toBe("legacy-openid");
      expect(fs.existsSync(legacyPath)).toBe(false);
      expect(fs.existsSync(getAdminMarkerFile(acct, "app-1"))).toBe(true);
    });

    it("isolates different appIds under the same account", () => {
      saveAdminOpenId(acct, "app-1", "openid-a");
      saveAdminOpenId(acct, "app-2", "openid-b");
      expect(loadAdminOpenId(acct, "app-1")).toBe("openid-a");
      expect(loadAdminOpenId(acct, "app-2")).toBe("openid-b");
    });

    it("returns undefined when the file is corrupt", () => {
      fs.writeFileSync(getAdminMarkerFile(acct, "app-1"), "not json");
      expect(loadAdminOpenId(acct, "app-1")).toBeUndefined();
    });
  });

  describe("upgrade-greeting-target", () => {
    function writeTarget(accountId: string, appId: string, data: Record<string, unknown>): void {
      fs.writeFileSync(getUpgradeGreetingTargetFile(accountId, appId), JSON.stringify(data));
    }

    it("returns openid when file matches", () => {
      writeTarget(acct, "app-1", {
        accountId: acct,
        appId: "app-1",
        openid: "user-1",
      });
      expect(loadUpgradeGreetingTargetOpenId(acct, "app-1")).toBe("user-1");
    });

    it("returns undefined when appId does not match", () => {
      writeTarget(acct, "app-1", {
        accountId: acct,
        appId: "app-other",
        openid: "user-1",
      });
      expect(loadUpgradeGreetingTargetOpenId(acct, "app-1")).toBeUndefined();
    });

    it("returns undefined when accountId does not match", () => {
      writeTarget(acct, "app-1", {
        accountId: "acct-other",
        appId: "app-1",
        openid: "user-1",
      });
      expect(loadUpgradeGreetingTargetOpenId(acct, "app-1")).toBeUndefined();
    });

    it("returns undefined when file is missing", () => {
      expect(loadUpgradeGreetingTargetOpenId(acct, "app-1")).toBeUndefined();
    });

    it("clear removes the file", () => {
      writeTarget(acct, "app-1", { accountId: acct, appId: "app-1", openid: "x" });
      clearUpgradeGreetingTargetOpenId(acct, "app-1");
      expect(fs.existsSync(getUpgradeGreetingTargetFile(acct, "app-1"))).toBe(false);
    });
  });
});
