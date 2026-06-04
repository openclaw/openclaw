import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const canCreateFileSymlinks = (() => {
  try {
    const tempLink = path.join(os.tmpdir(), `symlink-file-test-${Math.random().toString(36).substring(2)}`);
    const tempFile = path.join(os.tmpdir(), `symlink-file-target-${Math.random().toString(36).substring(2)}`);
    fs.writeFileSync(tempFile, "temp");
    fs.symlinkSync(tempFile, tempLink, "file");
    fs.unlinkSync(tempLink);
    fs.unlinkSync(tempFile);
    return true;
  } catch {
    return false;
  }
})();
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasAnyWhatsAppAuth, listWhatsAppAuthDirs, resolveWhatsAppAuthDir } from "./accounts.js";

describe("hasAnyWhatsAppAuth", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempOauthDir: string | undefined;

  const writeCreds = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ me: {} }));
  };

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_OAUTH_DIR"]);
    tempOauthDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oauth-"));
    process.env.OPENCLAW_OAUTH_DIR = tempOauthDir;
  });

  afterEach(() => {
    envSnapshot.restore();
    if (tempOauthDir) {
      fs.rmSync(tempOauthDir, { recursive: true, force: true });
      tempOauthDir = undefined;
    }
  });

  it("returns false when no auth exists", () => {
    expect(hasAnyWhatsAppAuth({})).toBe(false);
  });

  it("returns true when legacy auth exists", () => {
    fs.writeFileSync(path.join(tempOauthDir ?? "", "creds.json"), JSON.stringify({ me: {} }));
    expect(hasAnyWhatsAppAuth({})).toBe(true);
  });

  it.skipIf(!canCreateFileSymlinks)("ignores symlinked legacy creds", () => {
    const targetPath = path.join(tempOauthDir ?? "", "target-creds.json");
    const credsPath = path.join(tempOauthDir ?? "", "creds.json");
    fs.writeFileSync(targetPath, JSON.stringify({ me: {} }));
    fs.symlinkSync(targetPath, credsPath, "file");

    expect(hasAnyWhatsAppAuth({})).toBe(false);
    expect(resolveWhatsAppAuthDir({ cfg: {}, accountId: "default" })).toEqual({
      authDir: path.join(tempOauthDir ?? "", "whatsapp", "default"),
      isLegacy: false,
    });
  });

  it("selects legacy auth when legacy creds are truncated so backup recovery can run", () => {
    fs.writeFileSync(path.join(tempOauthDir ?? "", "creds.json"), "{");

    expect(resolveWhatsAppAuthDir({ cfg: {}, accountId: "default" })).toEqual({
      authDir: tempOauthDir,
      isLegacy: true,
    });
  });

  it("does not fall back to legacy auth when default creds are truncated", () => {
    const defaultAuthDir = path.join(tempOauthDir ?? "", "whatsapp", "default");
    fs.mkdirSync(defaultAuthDir, { recursive: true });
    fs.writeFileSync(path.join(tempOauthDir ?? "", "creds.json"), JSON.stringify({ me: {} }));
    fs.writeFileSync(path.join(defaultAuthDir, "creds.json"), "{");

    expect(resolveWhatsAppAuthDir({ cfg: {}, accountId: "default" })).toEqual({
      authDir: defaultAuthDir,
      isLegacy: false,
    });
  });

  it("returns true when non-default auth exists", () => {
    writeCreds(path.join(tempOauthDir ?? "", "whatsapp", "work"));
    expect(hasAnyWhatsAppAuth({})).toBe(true);
  });

  it("includes authDir overrides", () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-auth-"));
    try {
      writeCreds(customDir);
      const cfg = {
        channels: { whatsapp: { accounts: { work: { authDir: customDir } } } },
      };

      expect(listWhatsAppAuthDirs(cfg)).toContain(customDir);
      expect(hasAnyWhatsAppAuth(cfg)).toBe(true);
    } finally {
      fs.rmSync(customDir, { recursive: true, force: true });
    }
  });
});
