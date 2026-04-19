import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maybeRestoreCredsFromBackup } from "./auth-store.js";

const tempDirs: string[] = [];

function makeAuthDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-auth-store-"));
  tempDirs.push(dir);
  return dir;
}

function writeCredsFixture(authDir: string, creds: string, backup: string) {
  fs.writeFileSync(path.join(authDir, "creds.json"), creds);
  fs.writeFileSync(path.join(authDir, "creds.json.bak"), backup);
}

describe("WhatsApp auth-store backup restore", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not restore backup over a recently touched empty creds.json", () => {
    const authDir = makeAuthDir();
    writeCredsFixture(authDir, "", JSON.stringify({ me: { id: "backup@s.whatsapp.net" } }));

    maybeRestoreCredsFromBackup(authDir);

    expect(fs.readFileSync(path.join(authDir, "creds.json"), "utf-8")).toBe("");
  });

  it("restores backup when creds.json is stale and empty", () => {
    const authDir = makeAuthDir();
    const backup = JSON.stringify({ me: { id: "backup@s.whatsapp.net" } });
    writeCredsFixture(authDir, "", backup);
    const stale = new Date(Date.now() - 30_000);
    fs.utimesSync(path.join(authDir, "creds.json"), stale, stale);
    fs.utimesSync(authDir, stale, stale);

    maybeRestoreCredsFromBackup(authDir);

    expect(fs.readFileSync(path.join(authDir, "creds.json"), "utf-8")).toBe(backup);
  });
});
