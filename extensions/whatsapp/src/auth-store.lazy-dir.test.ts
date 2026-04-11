import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { captureEnv } from "openclaw/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("WA_WEB_AUTH_DIR lazy resolution", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_OAUTH_DIR"]);
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.resetModules();
  });

  it("stringifies to credentials under OPENCLAW_STATE_DIR after import", async () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-profile-"));
    try {
      process.env.OPENCLAW_STATE_DIR = isolated;
      delete process.env.OPENCLAW_OAUTH_DIR;

      vi.resetModules();
      const { WA_WEB_AUTH_DIR } = await import("./auth-store.js");
      const expected = path.join(isolated, "credentials", "whatsapp", DEFAULT_ACCOUNT_ID);
      const rawDir = WA_WEB_AUTH_DIR as unknown;
      expect(String(rawDir)).toBe(expected);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("listWhatsAppAuthDirs stays aligned with the lazy default web auth dir", async () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-list-"));
    try {
      process.env.OPENCLAW_STATE_DIR = isolated;
      delete process.env.OPENCLAW_OAUTH_DIR;

      vi.resetModules();
      const { WA_WEB_AUTH_DIR } = await import("./auth-store.js");
      const { listWhatsAppAuthDirs } = await import("./accounts.js");
      const dirs = listWhatsAppAuthDirs({});
      expect(dirs).toContain(String(WA_WEB_AUTH_DIR as unknown));
      expect(dirs).toContain(path.join(isolated, "credentials"));
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});
