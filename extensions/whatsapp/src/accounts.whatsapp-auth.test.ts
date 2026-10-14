// Whatsapp tests cover accounts.whatsapp auth plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasAnyWhatsAppAuth as hasPackagedWhatsAppAuth } from "../auth-presence.js";
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

  it("leaves implicit shared-root credentials for Doctor", () => {
    fs.writeFileSync(path.join(tempOauthDir ?? "", "creds.json"), JSON.stringify({ me: {} }));
    expect(hasAnyWhatsAppAuth({})).toBe(false);
    expect(hasPackagedWhatsAppAuth({})).toBe(false);
  });

  it.runIf(process.platform !== "win32")("ignores symlinked legacy creds", () => {
    const targetPath = path.join(tempOauthDir ?? "", "target-creds.json");
    const credsPath = path.join(tempOauthDir ?? "", "creds.json");
    fs.writeFileSync(targetPath, JSON.stringify({ me: {} }));
    fs.symlinkSync(targetPath, credsPath);

    expect(hasAnyWhatsAppAuth({})).toBe(false);
    expect(resolveWhatsAppAuthDir({ cfg: {}, accountId: "default" })).toEqual({
      authDir: path.join(tempOauthDir ?? "", "whatsapp", "default"),
      isLegacy: false,
    });
  });

  it("keeps truncated legacy credentials out of the runtime account resolver", () => {
    fs.writeFileSync(path.join(tempOauthDir ?? "", "creds.json"), "{");

    expect(resolveWhatsAppAuthDir({ cfg: {}, accountId: "default" })).toEqual({
      authDir: path.join(tempOauthDir ?? "", "whatsapp", "default"),
      isLegacy: false,
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

  it("preserves an explicitly configured shared root", () => {
    writeCreds(tempOauthDir!);
    const cfg = { channels: { whatsapp: { accounts: { default: { authDir: tempOauthDir } } } } };
    expect(resolveWhatsAppAuthDir({ cfg, accountId: "default" }).authDir).toBe(tempOauthDir);
    expect(hasAnyWhatsAppAuth(cfg)).toBe(true);
    expect(hasPackagedWhatsAppAuth(cfg)).toBe(true);
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
