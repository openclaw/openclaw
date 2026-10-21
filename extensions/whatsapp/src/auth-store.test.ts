import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import {
  getWebAuthAgeMs,
  hasWebCredsSync,
  logoutWeb,
  pickWebChannel,
  readCredsJsonRaw,
  readWebAuthSnapshot,
  readWebAuthState,
  readWebSelfId,
  readWebSelfIdentity,
  restoreCredsFromBackupIfNeeded,
  webAuthExists,
  WhatsAppAuthUnstableError,
} from "./auth-store.js";
import type { CredsQueueWaitResult } from "./creds-persistence.js";

const hoisted = vi.hoisted(() => ({
  waitForCredsSaveQueueWithTimeout: vi.fn<() => Promise<CredsQueueWaitResult>>(),
  oauthDir: "/tmp/openclaw-wa-auth-store-test-oauth",
}));

vi.mock("./creds-persistence.js", async () => {
  const actual =
    await vi.importActual<typeof import("./creds-persistence.js")>("./creds-persistence.js");
  return {
    ...actual,
    waitForCredsSaveQueueWithTimeout: hoisted.waitForCredsSaveQueueWithTimeout,
  };
});

vi.mock("./auth-store.runtime.js", () => ({
  resolveOAuthDir: () => hoisted.oauthDir,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const backupCreds = JSON.stringify({ me: { id: "123@s.whatsapp.net" } });
const selfCreds = JSON.stringify({ me: { id: "15551234567@s.whatsapp.net" } });
const emptyIdentity = { e164: null, jid: null, lid: null };
const originalOAuthDir = hoisted.oauthDir;
const supportsSymlinks = process.platform !== "win32";
let authDir: string;
let credsPath: string;

function writeAuthFiles(files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    fsSync.writeFileSync(path.join(authDir, name), contents, "utf-8");
  }
}

describe("auth-store", () => {
  beforeEach(() => {
    hoisted.waitForCredsSaveQueueWithTimeout.mockReset().mockResolvedValue("drained");
    hoisted.oauthDir = tempDirs.make("openclaw-wa-auth-");
    authDir = path.join(hoisted.oauthDir, "whatsapp", "default");
    credsPath = path.join(authDir, "creds.json");
    fsSync.mkdirSync(authDir, { recursive: true });
  });
  afterEach(() => {
    hoisted.oauthDir = originalOAuthDir;
  });

  it("does not restore creds from backup on ordinary reads", async () => {
    const backupPath = path.join(authDir, "creds.json.bak");
    fsSync.writeFileSync(backupPath, JSON.stringify({ me: { id: "123@s.whatsapp.net" } }), "utf-8");

    await expect(webAuthExists(authDir)).resolves.toBe(false);
    expect(fsSync.existsSync(credsPath)).toBe(false);
  });

  it("restores malformed creds from a valid backup", async () => {
    writeAuthFiles({ "creds.json": "{x", "creds.json.bak": backupCreds });

    await expect(restoreCredsFromBackupIfNeeded(authDir)).resolves.toBe(true);
    expect(JSON.parse(fsSync.readFileSync(credsPath, "utf-8"))).toEqual({
      me: { id: "123@s.whatsapp.net" },
    });
  });

  it.each([
    ["restore", "{x"],
    ["logout", "{}"],
  ] as const)(
    "%s revalidates ownership immediately before credential persistence",
    async (action, contents) => {
      writeAuthFiles({ "creds.json": contents });
      if (action === "restore") {
        writeAuthFiles({ "creds.json.bak": backupCreds });
      }
      const guardError = new Error("verified inference route changed");
      const beforeCredentialPersistence = async () => {
        throw guardError;
      };
      const operation =
        action === "restore"
          ? restoreCredsFromBackupIfNeeded(authDir, { beforeCredentialPersistence })
          : logoutWeb({ authDir, beforeCredentialPersistence });
      await expect(operation).rejects.toBe(guardError);
      expect(fsSync.readFileSync(credsPath, "utf-8")).toBe(contents);
    },
  );

  it("leaves malformed creds unchanged when the backup is malformed", async () => {
    fsSync.writeFileSync(credsPath, "{x", "utf-8");
    fsSync.writeFileSync(path.join(authDir, "creds.json.bak"), "{y", "utf-8");

    await expect(restoreCredsFromBackupIfNeeded(authDir)).resolves.toBe(false);
    expect(fsSync.readFileSync(credsPath, "utf-8")).toBe("{x");
  });

  it("preserves valid large creds instead of treating them as corrupt", async () => {
    const largeCreds = JSON.stringify({
      me: { id: "15551234567@s.whatsapp.net" },
      additionalData: "x".repeat(1024 * 1024 + 512),
    });
    writeAuthFiles({
      "creds.json": largeCreds,
      "creds.json.bak": JSON.stringify({ me: { id: "19990000000@s.whatsapp.net" } }),
    });

    await expect(webAuthExists(authDir)).resolves.toBe(true);
    await expect(restoreCredsFromBackupIfNeeded(authDir)).resolves.toBe(false);
    expect(fsSync.readFileSync(credsPath, "utf-8")).toBe(largeCreds);
    expect(readWebSelfId(authDir)).toMatchObject({
      e164: "+15551234567",
      jid: "15551234567@s.whatsapp.net",
    });
  });

  it("refuses to restore creds from a symlinked backup path", async () => {
    writeAuthFiles({ "backup-target.json": backupCreds, "creds.json": "{" });
    const targetPath = path.join(authDir, "backup-target.json");
    const backupPath = path.join(authDir, "creds.json.bak");
    fsSync.symlinkSync(targetPath, backupPath);

    await expect(restoreCredsFromBackupIfNeeded(authDir)).resolves.toBe(false);
    expect(fsSync.readFileSync(credsPath, "utf-8")).toBe("{");
  });

  it.runIf(supportsSymlinks)("does not restore over symlinked creds", async () => {
    writeAuthFiles({ "target-creds.json": "{", "creds.json.bak": backupCreds });
    const targetPath = path.join(authDir, "target-creds.json");
    fsSync.symlinkSync(targetPath, credsPath);

    await expect(restoreCredsFromBackupIfNeeded(authDir)).resolves.toBe(false);
    expect(fsSync.lstatSync(credsPath).isSymbolicLink()).toBe(true);
    expect(fsSync.readFileSync(targetPath, "utf-8")).toBe("{");
  });

  it("reports linked auth state and snapshot from the shared read helper", async () => {
    writeAuthFiles({ "creds.json": selfCreds });

    await expect(readWebAuthState(authDir)).resolves.toBe("linked");
    const snapshot = await readWebAuthSnapshot(authDir);
    expect(snapshot.authAgeMs).toBeGreaterThanOrEqual(-1);
    expect(snapshot).toEqual({
      state: "linked",
      authAgeMs: expect.any(Number),
      selfId: {
        e164: "+15551234567",
        jid: "15551234567@s.whatsapp.net",
        lid: null,
      },
    });
  });

  it.runIf(supportsSymlinks)("treats symlinked creds as missing across readers", async () => {
    writeAuthFiles({ "target-creds.json": selfCreds });
    const targetPath = path.join(authDir, "target-creds.json");
    fsSync.symlinkSync(targetPath, credsPath);

    expect(fsSync.lstatSync(credsPath).isSymbolicLink()).toBe(true);
    expect(fsSync.statSync(credsPath).isFile()).toBe(true);
    expect(hasWebCredsSync(authDir)).toBe(false);
    expect(readCredsJsonRaw(credsPath)).toBeNull();
    expect(getWebAuthAgeMs(authDir)).toBeNull();
    expect(readWebSelfId(authDir)).toEqual(emptyIdentity);
    await expect(readWebSelfIdentity(authDir)).resolves.toEqual(emptyIdentity);
    await expect(webAuthExists(authDir)).resolves.toBe(false);
    await expect(readWebAuthState(authDir)).resolves.toBe("not-linked");
    await expect(readWebAuthSnapshot(authDir)).resolves.toEqual({
      state: "not-linked",
      authAgeMs: null,
      selfId: emptyIdentity,
    });
  });

  it.runIf(supportsSymlinks)("treats symlinked auth directories as missing", async () => {
    const rootDir = tempDirs.make("openclaw-wa-auth-symlink-parent-");
    const targetAuthDir = path.join(rootDir, "target-auth");
    authDir = path.join(rootDir, "linked-auth");
    fsSync.mkdirSync(targetAuthDir);
    fsSync.writeFileSync(path.join(targetAuthDir, "creds.json"), selfCreds, "utf-8");
    fsSync.symlinkSync(targetAuthDir, authDir, "dir");
    credsPath = path.join(authDir, "creds.json");

    expect(fsSync.lstatSync(authDir).isSymbolicLink()).toBe(true);
    expect(fsSync.lstatSync(credsPath).isFile()).toBe(true);
    expect(hasWebCredsSync(authDir)).toBe(false);
    expect(readCredsJsonRaw(credsPath)).toBeNull();
    await expect(webAuthExists(authDir)).resolves.toBe(false);
    await expect(readWebAuthState(authDir)).resolves.toBe("not-linked");
  });

  it("reports unstable auth state when the shared barrier read times out", async () => {
    fsSync.writeFileSync(
      path.join(authDir, "creds.json"),
      JSON.stringify({ me: { id: "15551234567@s.whatsapp.net" } }),
      "utf-8",
    );
    hoisted.waitForCredsSaveQueueWithTimeout
      .mockResolvedValueOnce("timed_out")
      .mockResolvedValueOnce("timed_out");

    await expect(readWebAuthState(authDir)).resolves.toBe("unstable");
    await expect(readWebAuthSnapshot(authDir)).resolves.toEqual({
      state: "unstable",
      authAgeMs: null,
      selfId: { e164: null, jid: null, lid: null },
    });
  });

  it("clears unreadable auth state on explicit logout", async () => {
    writeAuthFiles({ "creds.json": "{", "creds.json.bak": backupCreds });
    await expect(logoutWeb({ authDir, runtime: createRuntimeSpies() })).resolves.toBe(true);
    expect(fsSync.existsSync(authDir)).toBe(false);
  });

  it("does not delete the whole legacy auth root when targeted cleanup fails", async () => {
    writeAuthFiles({
      "creds.json": "{}",
      "oauth.json": '{"token":true}',
      "session-abc.json": "{}",
    });
    const originalRm = fs.rm;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target).endsWith("creds.json")) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      return await originalRm.call(fs, target, options as never);
    });
    const runtime = createRuntimeSpies();

    try {
      hoisted.oauthDir = authDir;
      await expect(logoutWeb({ authDir, isLegacyAuthDir: true, runtime })).rejects.toThrow(
        "EACCES",
      );
      expect(fsSync.existsSync(authDir)).toBe(true);
      expect(fsSync.existsSync(path.join(authDir, "oauth.json"))).toBe(true);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("clears every Baileys auth category from the shared legacy root without touching other files", async () => {
    const authFiles = [
      "creds.json",
      "creds.json.bak",
      "pre-key-1.json",
      "session-contact.json",
      "sender-key-group.json",
      "sender-key-memory-group.json",
      "app-state-sync-key-contact.json",
      "app-state-sync-version-contact.json",
      "lid-mapping-15551234567.json",
      "device-list-15551234567.json",
      "tctoken-15551234567.json",
      "identity-key-15551234567.json",
    ];
    const unrelatedFiles = ["oauth.json", "google-oauth.json", "notes.txt"];
    const nestedAuthFile = path.join(authDir, "nested", "session-keep.json");
    hoisted.oauthDir = authDir;

    for (const file of [...authFiles, ...unrelatedFiles]) {
      fsSync.writeFileSync(path.join(authDir, file), "{}", "utf-8");
    }
    fsSync.mkdirSync(path.dirname(nestedAuthFile));
    fsSync.writeFileSync(nestedAuthFile, "keep", "utf-8");
    fsSync.symlinkSync(path.join(authDir, "notes.txt"), path.join(authDir, "session-linked.json"));

    await expect(logoutWeb({ authDir, isLegacyAuthDir: true })).resolves.toBe(true);

    for (const file of authFiles) {
      expect(fsSync.existsSync(path.join(authDir, file)), file).toBe(false);
    }
    for (const file of unrelatedFiles) {
      expect(fsSync.existsSync(path.join(authDir, file)), file).toBe(true);
    }
    expect(fsSync.readFileSync(nestedAuthFile, "utf-8")).toBe("keep");
    expect(fsSync.lstatSync(path.join(authDir, "session-linked.json")).isSymbolicLink()).toBe(true);
  });

  it("does not delete unrelated non-empty directories on logout", async () => {
    writeAuthFiles({ "notes.txt": "keep me" });
    const runtime = createRuntimeSpies();

    await expect(logoutWeb({ authDir, runtime })).resolves.toBe(false);
    expect(fsSync.existsSync(authDir)).toBe(true);
    expect(fsSync.existsSync(path.join(authDir, "notes.txt"))).toBe(true);
  });

  it("throws a typed unstable-auth error when channel selection times out", async () => {
    hoisted.waitForCredsSaveQueueWithTimeout.mockResolvedValueOnce("timed_out");

    const error = await pickWebChannel("auto", authDir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WhatsAppAuthUnstableError);
    expect(error).toEqual(new WhatsAppAuthUnstableError());
  });
});
