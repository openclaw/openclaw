import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECOVERY_KEY_TTL_MS } from "./constants.js";
import { RecoveryKeyStore } from "./store.js";

describe("RecoveryKeyStore", () => {
  let tmpDir: string;
  let store: RecoveryKeyStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-store-test-"));
    store = new RecoveryKeyStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("initialize", () => {
    it("starts with default state when no file exists", async () => {
      await store.initialize();
      const state = store.getState();
      expect(state.verified).toBe(false);
      expect(state.deviceId).toBeNull();
      expect(state.verifiedAt).toBeNull();
      expect(state.usedKeyHashes).toEqual([]);
      expect(state.backupVersion).toBeNull();
    });

    it("loads existing state from disk", async () => {
      const stateData = {
        verified: true,
        deviceId: "ABCDEF",
        verifiedAt: "2026-01-15T12:00:00.000Z",
        usedKeyHashes: [{ hash: "abc123", usedAt: "2026-01-15T12:00:00.000Z" }],
        backupVersion: "5",
      };
      fs.writeFileSync(
        path.join(tmpDir, "recovery-key-verification-state.json"),
        JSON.stringify(stateData),
      );

      await store.initialize();
      const state = store.getState();
      expect(state.verified).toBe(true);
      expect(state.deviceId).toBe("ABCDEF");
      expect(state.verifiedAt).toBe("2026-01-15T12:00:00.000Z");
      expect(state.usedKeyHashes).toHaveLength(1);
      expect(state.backupVersion).toBe("5");
    });

    it("falls back to defaults on corrupt JSON", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "recovery-key-verification-state.json"),
        "not valid json {{{",
      );

      await store.initialize();
      expect(store.getState().verified).toBe(false);
    });

    it("handles partial/malformed state gracefully", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "recovery-key-verification-state.json"),
        JSON.stringify({ verified: "yes", deviceId: 123, usedKeyHashes: "nope" }),
      );

      await store.initialize();
      const state = store.getState();
      // "yes" is not === true, so verified is false
      expect(state.verified).toBe(false);
      // 123 is not a string, so deviceId falls back to null
      expect(state.deviceId).toBeNull();
      // "nope" is not an array, so usedKeyHashes falls back to []
      expect(state.usedKeyHashes).toEqual([]);
    });
  });

  describe("getState", () => {
    it("returns a copy, not a reference", async () => {
      await store.initialize();
      const state1 = store.getState();
      state1.verified = true;
      state1.deviceId = "TAMPERED";
      const state2 = store.getState();
      expect(state2.verified).toBe(false);
      expect(state2.deviceId).toBeNull();
    });
  });

  describe("isVerified", () => {
    it("returns false initially", async () => {
      await store.initialize();
      expect(store.isVerified).toBe(false);
    });

    it("returns true after markVerified", async () => {
      await store.initialize();
      await store.markVerified("DEV1", null);
      expect(store.isVerified).toBe(true);
    });
  });

  describe("computeKeyHash", () => {
    it("returns a hex string", () => {
      const key = crypto.randomBytes(32);
      const hash = store.computeKeyHash(key, "DEVICEID");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces consistent output for same inputs", () => {
      const key = new Uint8Array(32).fill(42);
      const h1 = store.computeKeyHash(key, "DEV1");
      const h2 = store.computeKeyHash(key, "DEV1");
      expect(h1).toBe(h2);
    });

    it("produces different output for different device IDs", () => {
      const key = new Uint8Array(32).fill(42);
      const h1 = store.computeKeyHash(key, "DEV1");
      const h2 = store.computeKeyHash(key, "DEV2");
      expect(h1).not.toBe(h2);
    });

    it("produces different output for different keys", () => {
      const k1 = new Uint8Array(32).fill(1);
      const k2 = new Uint8Array(32).fill(2);
      const h1 = store.computeKeyHash(k1, "DEV");
      const h2 = store.computeKeyHash(k2, "DEV");
      expect(h1).not.toBe(h2);
    });
  });

  describe("replay detection", () => {
    it("returns false for a new hash", async () => {
      await store.initialize();
      expect(store.isReplayDetected("newhash")).toBe(false);
    });

    it("returns true after the hash is used", async () => {
      await store.initialize();
      store.markKeyUsed("myhash");
      expect(store.isReplayDetected("myhash")).toBe(true);
    });

    it("prunes entries older than TTL", async () => {
      await store.initialize();
      // Manually inject an old entry
      const state = store.getState();
      state.usedKeyHashes.push({
        hash: "oldhash",
        usedAt: new Date(Date.now() - RECOVERY_KEY_TTL_MS - 1000).toISOString(),
      });
      // Re-initialize from that state by writing to disk and reloading
      fs.writeFileSync(
        path.join(tmpDir, "recovery-key-verification-state.json"),
        JSON.stringify(state),
      );
      await store.initialize();

      // The expired entry should be pruned during the check
      expect(store.isReplayDetected("oldhash")).toBe(false);
    });

    it("keeps entries within TTL", async () => {
      await store.initialize();
      store.markKeyUsed("recenthash");
      expect(store.isReplayDetected("recenthash")).toBe(true);
    });
  });

  describe("markVerified", () => {
    it("persists state to disk", async () => {
      await store.initialize();
      await store.markVerified("MYDEV", "3");

      // Read back from a fresh store
      const store2 = new RecoveryKeyStore(tmpDir);
      await store2.initialize();
      const state = store2.getState();
      expect(state.verified).toBe(true);
      expect(state.deviceId).toBe("MYDEV");
      expect(state.verifiedAt).toBeTruthy();
      expect(state.backupVersion).toBe("3");
    });

    it("persists null backup version", async () => {
      await store.initialize();
      await store.markVerified("DEV", null);

      const store2 = new RecoveryKeyStore(tmpDir);
      await store2.initialize();
      expect(store2.getState().backupVersion).toBeNull();
    });

    it("creates the directory if it does not exist", async () => {
      const nestedDir = path.join(tmpDir, "nested", "deep");
      const nestedStore = new RecoveryKeyStore(nestedDir);
      await nestedStore.initialize();
      await nestedStore.markVerified("DEV", null);

      expect(fs.existsSync(path.join(nestedDir, "recovery-key-verification-state.json"))).toBe(
        true,
      );
    });
  });
});
