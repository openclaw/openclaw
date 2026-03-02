import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "./session-store.js";

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs = [];
});

describe("SessionStore", () => {
  describe("getSessionPath", () => {
    it("returns correct path format for various account IDs", () => {
      const store = new SessionStore("/tmp/creds");
      expect(store.getSessionPath("12345")).toBe("/tmp/creds/telegram-userbot-12345.session");
      expect(store.getSessionPath("my-account")).toBe(
        "/tmp/creds/telegram-userbot-my-account.session",
      );
      expect(store.getSessionPath("user_99")).toBe("/tmp/creds/telegram-userbot-user_99.session");
    });
  });

  describe("save + load", () => {
    it("round-trips a session string", async () => {
      const dir = await makeTmpDir();
      const store = new SessionStore(dir);
      const session = "1BQANOTaFAKESESSIONSTRING==";

      await store.save("acct1", session);
      const loaded = await store.load("acct1");

      expect(loaded).toBe(session);
    });
  });

  describe("load", () => {
    it("returns null for a non-existent account", async () => {
      const dir = await makeTmpDir();
      const store = new SessionStore(dir);

      const result = await store.load("no-such-account");

      expect(result).toBeNull();
    });

    it("trims whitespace from loaded sessions", async () => {
      const dir = await makeTmpDir();
      const store = new SessionStore(dir);
      // Write directly with extra whitespace
      const sessionPath = store.getSessionPath("trimtest");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(sessionPath, "  session-data-here  \n", "utf8");

      const loaded = await store.load("trimtest");

      expect(loaded).toBe("session-data-here");
    });
  });

  describe("save", () => {
    it("auto-creates a non-existent credentials directory", async () => {
      const dir = await makeTmpDir();
      const nested = path.join(dir, "deeply", "nested", "creds");
      const store = new SessionStore(nested);

      await store.save("acct1", "sess");

      const stat = await fs.stat(nested);
      expect(stat.isDirectory()).toBe(true);
    });

    it("creates the credentials directory with mode 0o700", async () => {
      const dir = await makeTmpDir();
      const credsDir = path.join(dir, "fresh-creds");
      const store = new SessionStore(credsDir);

      await store.save("acct1", "sess");

      const stat = await fs.stat(credsDir);
      // Mask to owner bits only (ignore umask effects on group/other)
      expect(stat.mode & 0o700).toBe(0o700);
    });

    it("sets file permissions to 0o600", async () => {
      const dir = await makeTmpDir();
      const store = new SessionStore(dir);

      await store.save("acct1", "sess");

      const stat = await fs.stat(store.getSessionPath("acct1"));
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("does not leave behind a .tmp file (atomic write)", async () => {
      const dir = await makeTmpDir();
      const store = new SessionStore(dir);

      await store.save("acct1", "sess");

      const files = await fs.readdir(dir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe("clear", () => {
    it("removes an existing session file", async () => {
      const dir = await makeTmpDir();
      const store = new SessionStore(dir);
      await store.save("acct1", "sess");

      await store.clear("acct1");

      const result = await store.load("acct1");
      expect(result).toBeNull();
    });

    it("does not throw for a non-existent account", async () => {
      const dir = await makeTmpDir();
      const store = new SessionStore(dir);

      // Should not throw
      await expect(store.clear("no-such-account")).resolves.toBeUndefined();
    });
  });

  describe("exists", () => {
    it("returns true when a session file exists", async () => {
      const dir = await makeTmpDir();
      const store = new SessionStore(dir);
      await store.save("acct1", "sess");

      expect(await store.exists("acct1")).toBe(true);
    });

    it("returns false when no session file exists", async () => {
      const dir = await makeTmpDir();
      const store = new SessionStore(dir);

      expect(await store.exists("no-such-account")).toBe(false);
    });
  });
});
