import fsSync from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSessionTest,
  createTempAuthDir,
  resetSessionTestMocks,
} from "./session-test-helpers.js";
import { baileys } from "./test-helpers.js";

const useMultiFileAuthStateMock = vi.mocked(baileys.useMultiFileAuthState);
let session!: typeof import("./session.js");

describe("web session auth-path guards", () => {
  beforeAll(async () => {
    session = await import("./session.js");
  });

  beforeEach(() => {
    resetSessionTestMocks();
  });

  afterEach(async () => {
    await cleanupSessionTest(session.waitForCredsSaveQueue);
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinked creds before Baileys auth state reads",
    async () => {
      const authDir = createTempAuthDir("openclaw-wa-creds-symlink-runtime");
      const targetPath = path.join(authDir, "target-creds.json");
      const credsPath = path.join(authDir, "creds.json");
      fsSync.writeFileSync(
        targetPath,
        JSON.stringify({ me: { id: "15551234567@s.whatsapp.net" } }),
        "utf-8",
      );
      fsSync.symlinkSync(targetPath, credsPath);

      await expect(session.createWaSocket(false, false, { authDir })).rejects.toThrow(
        "creds.json must be a regular file or missing",
      );

      expect(useMultiFileAuthStateMock).not.toHaveBeenCalled();
      expect(fsSync.lstatSync(credsPath).isSymbolicLink()).toBe(true);
      expect(fsSync.readFileSync(targetPath, "utf-8")).toContain("15551234567");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked auth directories before Baileys auth state reads",
    async () => {
      const rootDir = createTempAuthDir("openclaw-wa-authdir-symlink-runtime");
      const targetAuthDir = path.join(rootDir, "target-auth");
      const authDir = path.join(rootDir, "linked-auth");
      fsSync.mkdirSync(targetAuthDir);
      fsSync.writeFileSync(
        path.join(targetAuthDir, "creds.json"),
        JSON.stringify({ me: { id: "15551234567@s.whatsapp.net" } }),
        "utf-8",
      );
      fsSync.symlinkSync(targetAuthDir, authDir, "dir");

      await expect(session.createWaSocket(false, false, { authDir })).rejects.toThrow(
        "creds.json must be a regular file or missing",
      );

      expect(useMultiFileAuthStateMock).not.toHaveBeenCalled();
      expect(fsSync.lstatSync(authDir).isSymbolicLink()).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked auth directory parents before creating the auth directory",
    async () => {
      const rootDir = createTempAuthDir("openclaw-wa-auth-parent-symlink-runtime");
      const targetBaseDir = path.join(rootDir, "target-base");
      const linkedBaseDir = path.join(rootDir, "linked-base");
      const authDir = path.join(linkedBaseDir, "default");
      fsSync.mkdirSync(targetBaseDir);
      fsSync.symlinkSync(targetBaseDir, linkedBaseDir, "dir");

      await expect(session.createWaSocket(false, false, { authDir })).rejects.toThrow(
        "creds.json must be a regular file or missing",
      );

      expect(useMultiFileAuthStateMock).not.toHaveBeenCalled();
      expect(fsSync.existsSync(path.join(targetBaseDir, "default"))).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked creds before atomic credential saves",
    async () => {
      const authDir = createTempAuthDir("openclaw-wa-creds-symlink-save");
      const targetPath = path.join(authDir, "target-creds.json");
      const credsPath = path.join(authDir, "creds.json");
      fsSync.writeFileSync(targetPath, "keep", "utf-8");
      fsSync.symlinkSync(targetPath, credsPath);

      await expect(
        session.writeCredsJsonAtomically(authDir, { me: { id: "15551234567@s.whatsapp.net" } }),
      ).rejects.toThrow("creds.json must be a regular file or missing");

      expect(fsSync.lstatSync(credsPath).isSymbolicLink()).toBe(true);
      expect(fsSync.readFileSync(targetPath, "utf-8")).toBe("keep");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked credential parents before atomic credential saves",
    async () => {
      const rootDir = createTempAuthDir("openclaw-wa-creds-parent-symlink-save");
      const targetBaseDir = path.join(rootDir, "target-base");
      const linkedBaseDir = path.join(rootDir, "linked-base");
      const authDir = path.join(linkedBaseDir, "default");
      fsSync.mkdirSync(targetBaseDir);
      fsSync.symlinkSync(targetBaseDir, linkedBaseDir, "dir");

      await expect(
        session.writeCredsJsonAtomically(authDir, { me: { id: "15551234567@s.whatsapp.net" } }),
      ).rejects.toThrow("creds.json must be a regular file or missing");

      expect(fsSync.existsSync(path.join(targetBaseDir, "default"))).toBe(false);
    },
  );
});
