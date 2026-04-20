import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPluginVersion } from "../commands/slash-commands-impl.js";
import { getLegacyStartupMarkerFile, getStartupMarkerFile } from "../utils/data-paths.js";
import {
  getStartupGreetingPlan,
  markStartupGreetingFailed,
  markStartupGreetingSent,
  readStartupMarker,
  writeStartupMarker,
} from "./startup-greeting.js";

/**
 * Operates on the real `~/.openclaw/qqbot/data` dir under a pid-scoped
 * accountId to avoid colliding with user state. The legacy global
 * `startup-marker.json` is preserved across tests so we do not clobber
 * a user's real deployment state.
 */
describe("engine/session/startup-greeting", () => {
  const acct = `test-sg-${process.pid}-${Date.now()}`;
  const TEST_VERSION = "9.9.9-test";
  const legacyPath = getLegacyStartupMarkerFile();
  let legacyBackup: string | null = null;

  function cleanup() {
    try {
      fs.unlinkSync(getStartupMarkerFile(acct, "app-1"));
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(getStartupMarkerFile(acct, "app-2"));
    } catch {
      /* ignore */
    }
  }

  beforeEach(() => {
    cleanup();
    legacyBackup = null;
    if (fs.existsSync(legacyPath)) {
      legacyBackup = fs.readFileSync(legacyPath, "utf8");
      fs.unlinkSync(legacyPath);
    }
    registerPluginVersion(TEST_VERSION);
  });

  afterEach(() => {
    cleanup();
    if (fs.existsSync(legacyPath)) {
      fs.unlinkSync(legacyPath);
    }
    if (legacyBackup != null) {
      fs.writeFileSync(legacyPath, legacyBackup);
    }
  });

  it("returns shouldSend=true with first-launch greeting when marker is missing", () => {
    const plan = getStartupGreetingPlan(acct, "app-1");
    expect(plan.shouldSend).toBe(true);
    expect(plan.version).toBe(TEST_VERSION);
    expect(plan.greeting).toMatch(/soul|online/i);
  });

  it("returns shouldSend=true with upgrade greeting when version changed", () => {
    writeStartupMarker(acct, "app-1", { version: "0.0.1" });
    const plan = getStartupGreetingPlan(acct, "app-1");
    expect(plan.shouldSend).toBe(true);
    expect(plan.greeting).toContain(TEST_VERSION);
  });

  it("returns shouldSend=false when same version was already greeted", () => {
    markStartupGreetingSent(acct, "app-1", TEST_VERSION);
    const plan = getStartupGreetingPlan(acct, "app-1");
    expect(plan.shouldSend).toBe(false);
    expect(plan.reason).toBe("same-version");
  });

  it("respects the failure cooldown window", () => {
    markStartupGreetingFailed(acct, "app-1", TEST_VERSION, "boom");
    const plan = getStartupGreetingPlan(acct, "app-1");
    expect(plan.shouldSend).toBe(false);
    expect(plan.reason).toBe("cooldown");
  });

  it("permits a retry after the cooldown has elapsed", () => {
    const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    writeStartupMarker(acct, "app-1", {
      lastFailureVersion: TEST_VERSION,
      lastFailureAt: elevenMinAgo,
      lastFailureReason: "boom",
    });
    const plan = getStartupGreetingPlan(acct, "app-1");
    expect(plan.shouldSend).toBe(true);
  });

  it("preserves lastFailureAt across retries within the cooldown window", () => {
    markStartupGreetingFailed(acct, "app-1", TEST_VERSION, "first");
    const first = readStartupMarker(acct, "app-1").lastFailureAt;
    expect(first).toBeTruthy();
    markStartupGreetingFailed(acct, "app-1", TEST_VERSION, "second");
    const second = readStartupMarker(acct, "app-1").lastFailureAt;
    expect(second).toBe(first);
  });

  it("migrates legacy global startup marker to the per-(accountId, appId) path", () => {
    fs.writeFileSync(legacyPath, JSON.stringify({ version: "0.0.1" }));

    const marker = readStartupMarker(acct, "app-1");
    expect(marker.version).toBe("0.0.1");
    expect(fs.existsSync(getStartupMarkerFile(acct, "app-1"))).toBe(true);
  });

  it("isolates markers between different appIds under the same account", () => {
    markStartupGreetingSent(acct, "app-1", TEST_VERSION);
    const planOther = getStartupGreetingPlan(acct, "app-2");
    expect(planOther.shouldSend).toBe(true);
  });
});
