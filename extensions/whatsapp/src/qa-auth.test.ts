import fs from "node:fs/promises";
import path from "node:path";
import { useMultiFileAuthState } from "baileys";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWebAuthState, readWebSelfId } from "./auth-store.js";
import { writeCredsJsonAtomically } from "./creds-persistence.js";
import { createWhatsAppQaAuthState } from "./qa-auth.js";

vi.mock("./creds-persistence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./creds-persistence.js")>();
  return { ...actual, writeCredsJsonAtomically: vi.fn(actual.writeCredsJsonAtomically) };
});

afterEach(() => vi.clearAllMocks());

describe("synthetic WhatsApp QA auth", () => {
  it("persists real Baileys credentials privately without touching an existing account", async () => {
    await withTempDir("whatsapp-qa-auth-test-", async (parentDir) => {
      const existing = path.join(parentDir, "creds.json");
      await fs.writeFile(existing, "existing operator fixture");
      const params = { parentDir, selfJid: "15550000000:7@s.whatsapp.net", name: "QA fixture" };
      const authDir = await createWhatsAppQaAuthState(params);
      const second = await createWhatsAppQaAuthState(params);
      const { state } = await useMultiFileAuthState(authDir);
      const other = await useMultiFileAuthState(second);
      expect(state.creds.me).toEqual({ id: params.selfJid, name: params.name });
      expect(state.creds.registered).toBe(false);
      expect(Buffer.isBuffer(state.creds.noiseKey.private)).toBe(true);
      expect(state.creds.noiseKey.private).toHaveLength(32);
      expect(state.creds.signedIdentityKey.public).toHaveLength(32);
      expect(state.creds.signedPreKey.signature).toHaveLength(64);
      expect(state.creds.noiseKey.public).not.toEqual(other.state.creds.noiseKey.public);
      expect(await readWebAuthState(authDir)).toBe("linked");
      expect(readWebSelfId(authDir).jid).toBe("15550000000@s.whatsapp.net");
      expect((await fs.stat(authDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(authDir, "creds.json"))).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(existing, "utf8")).toBe("existing operator fixture");
    });
  });

  it("rejects a non-user identity before allocating auth state", async () => {
    await withTempDir("whatsapp-qa-auth-test-", async (parentDir) => {
      await expect(
        createWhatsAppQaAuthState({ parentDir, selfJid: "15550000000@g.us", name: "QA fixture" }),
      ).rejects.toThrow("native user JID");
      expect(await fs.readdir(parentDir)).toEqual([]);
    });
  });

  it("removes only its fresh directory when credential persistence fails", async () => {
    await withTempDir("whatsapp-qa-auth-test-", async (parentDir) => {
      await fs.writeFile(path.join(parentDir, "retained"), "untouched");
      vi.mocked(writeCredsJsonAtomically).mockRejectedValueOnce(
        new Error("fixture persistence failed"),
      );
      await expect(
        createWhatsAppQaAuthState({
          parentDir,
          selfJid: "15550000000@s.whatsapp.net",
          name: "QA fixture",
        }),
      ).rejects.toThrow("fixture persistence failed");
      expect(await fs.readdir(parentDir)).toEqual(["retained"]);
    });
  });
});
