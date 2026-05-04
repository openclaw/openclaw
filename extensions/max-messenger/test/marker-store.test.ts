/**
 * Unit tests for the marker store (Phase 1B.2). Each test gets its own
 * temp dir so file-system side effects stay isolated.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMarkerStore, hashToken } from "../src/polling/marker-store.js";

const HASH_ALICE = hashToken("token-alice");
const HASH_BOB = hashToken("token-bob");

let stateDir: string;
let dirs: string[] = [];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "max-marker-store-"));
  dirs.push(stateDir);
});

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  dirs = [];
});

describe("hashToken", () => {
  it("returns a hex digest that differs across token strings", () => {
    expect(HASH_ALICE).toMatch(/^[0-9a-f]{64}$/u);
    expect(HASH_ALICE).not.toBe(HASH_BOB);
  });

  it("is deterministic for the same input", () => {
    expect(hashToken("token-alice")).toBe(HASH_ALICE);
  });
});

describe("marker-store", () => {
  it("returns { invalidated: false, marker: undefined } when the file does not exist", async () => {
    const store = createMarkerStore({ accountId: "default", stateDir });
    expect(await store.load(HASH_ALICE)).toEqual({ invalidated: false });
  });

  it("round-trips a marker when the token hash matches", async () => {
    const store = createMarkerStore({ accountId: "default", stateDir });
    await store.set(42, HASH_ALICE);
    expect(await store.load(HASH_ALICE)).toEqual({ marker: 42, invalidated: false });
  });

  it("flags `invalidated: true` when stored token hash differs", async () => {
    const store = createMarkerStore({ accountId: "default", stateDir });
    await store.set(7, HASH_ALICE);
    expect(await store.load(HASH_BOB)).toEqual({ invalidated: true });
  });

  it("rejects non-integer or negative markers on write", async () => {
    const store = createMarkerStore({ accountId: "default", stateDir });
    await expect(store.set(-1, HASH_ALICE)).rejects.toThrow(/non-negative safe integer/iu);
    await expect(store.set(1.5, HASH_ALICE)).rejects.toThrow(/non-negative safe integer/iu);
  });

  it("clear() removes the file and is idempotent on missing files", async () => {
    const store = createMarkerStore({ accountId: "default", stateDir });
    await store.set(99, HASH_ALICE);
    await store.clear();
    expect(await store.load(HASH_ALICE)).toEqual({ invalidated: false });
    // Calling clear again must not throw.
    await store.clear();
  });

  it("treats corrupt JSON as 'no marker' (does not throw)", async () => {
    const store = createMarkerStore({ accountId: "default", stateDir });
    // Manually write a garbage payload to the resolved file path.
    const filePath = join(stateDir, "channels", "max-messenger", "default.json");
    mkdirSync(join(stateDir, "channels", "max-messenger"), { recursive: true });
    writeFileSync(filePath, "{not valid json}", "utf8");
    expect(await store.load(HASH_ALICE)).toEqual({ invalidated: false });
  });

  it("treats schema-mismatched JSON (missing marker) as 'no marker'", async () => {
    const store = createMarkerStore({ accountId: "default", stateDir });
    const filePath = join(stateDir, "channels", "max-messenger", "default.json");
    mkdirSync(join(stateDir, "channels", "max-messenger"), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ version: 1, tokenHash: HASH_ALICE }), "utf8");
    expect(await store.load(HASH_ALICE)).toEqual({ invalidated: false });
  });

  it("scopes file paths per accountId so multi-account state cannot collide", async () => {
    const alice = createMarkerStore({ accountId: "alice", stateDir });
    const bob = createMarkerStore({ accountId: "bob", stateDir });
    await alice.set(1, HASH_ALICE);
    await bob.set(2, HASH_BOB);
    expect(await alice.load(HASH_ALICE)).toEqual({ marker: 1, invalidated: false });
    expect(await bob.load(HASH_BOB)).toEqual({ marker: 2, invalidated: false });
  });

  it("normalizes unsafe characters in accountId for the on-disk filename", async () => {
    const store = createMarkerStore({ accountId: "weird/name with spaces", stateDir });
    await store.set(5, HASH_ALICE);
    // The exact filename normalization isn't part of the public contract, but
    // we check that load() round-trips through whatever name the writer chose.
    expect(await store.load(HASH_ALICE)).toEqual({ marker: 5, invalidated: false });
  });

  it("writes JSON containing { version, marker, tokenHash } so on-disk format stays auditable", async () => {
    const store = createMarkerStore({ accountId: "default", stateDir });
    await store.set(123, HASH_ALICE);
    const filePath = join(stateDir, "channels", "max-messenger", "default.json");
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as { version: number; marker: number; tokenHash: string };
    expect(parsed.version).toBe(1);
    expect(parsed.marker).toBe(123);
    expect(parsed.tokenHash).toBe(HASH_ALICE);
  });
});
