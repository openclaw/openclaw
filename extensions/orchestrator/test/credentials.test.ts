import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CredentialsError,
  generateToken,
  readCredentials,
  tryReadCredentials,
  writeCredentials,
} from "../src/credentials.js";

let tmpRoot: string;
let credPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "orchestrator-credentials-"));
  mkdirSync(join(tmpRoot, "credentials"), { recursive: true });
  credPath = join(tmpRoot, "credentials", "orchestrator-bearer.json");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("generateToken", () => {
  test("returns a 64-char hex string", () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  });

  test("produces unique tokens across calls", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateToken()));
    expect(tokens.size).toBe(50);
  });
});

describe("writeCredentials", () => {
  test("writes a 0o600 file with the supplied token", () => {
    const creds = writeCredentials({ path: credPath, token: "abc" });
    expect(creds.token).toBe("abc");
    expect(creds.version).toBe(1);
    const mode = statSync(credPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("generates a token when none is supplied", () => {
    const creds = writeCredentials({ path: credPath });
    expect(creds.token).toHaveLength(64);
  });

  test("createdAt reflects the injected clock", () => {
    const creds = writeCredentials({
      path: credPath,
      token: "x",
      now: () => Date.parse("2026-04-26T10:00:00.000Z"),
    });
    expect(creds.createdAt).toBe("2026-04-26T10:00:00.000Z");
  });

  test("overwrites an existing credentials file", () => {
    writeCredentials({ path: credPath, token: "first" });
    const next = writeCredentials({ path: credPath, token: "second" });
    expect(next.token).toBe("second");
  });
});

describe("readCredentials", () => {
  test("happy path", () => {
    writeCredentials({ path: credPath, token: "abc" });
    expect(readCredentials({ path: credPath }).token).toBe("abc");
  });

  test("missing file → CredentialsError code=missing", () => {
    try {
      readCredentials({ path: credPath });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialsError);
      expect((err as CredentialsError).code).toBe("missing");
    }
  });

  test("world-readable file → CredentialsError code=world_readable", () => {
    writeCredentials({ path: credPath, token: "abc" });
    chmodSync(credPath, 0o644);
    try {
      readCredentials({ path: credPath });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CredentialsError).code).toBe("world_readable");
    }
  });

  test("malformed JSON → CredentialsError code=schema_drift", () => {
    writeFileSync(credPath, "{ not json", { mode: 0o600 });
    try {
      readCredentials({ path: credPath });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CredentialsError).code).toBe("schema_drift");
    }
  });

  test("wrong shape (missing token) → schema_drift", () => {
    writeFileSync(credPath, JSON.stringify({ version: 1, createdAt: new Date().toISOString() }), {
      mode: 0o600,
    });
    expect(() => readCredentials({ path: credPath })).toThrow(/unexpected shape/);
  });

  test("wrong version → schema_drift", () => {
    writeFileSync(
      credPath,
      JSON.stringify({
        version: 99,
        token: "x",
        createdAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    expect(() => readCredentials({ path: credPath })).toThrow();
  });
});

describe("tryReadCredentials", () => {
  test("returns null when missing", () => {
    expect(tryReadCredentials({ path: credPath })).toBeNull();
  });

  test("returns the record when present", () => {
    writeCredentials({ path: credPath, token: "x" });
    expect(tryReadCredentials({ path: credPath })?.token).toBe("x");
  });

  test("rethrows non-missing errors", () => {
    writeCredentials({ path: credPath, token: "x" });
    chmodSync(credPath, 0o644);
    expect(() => tryReadCredentials({ path: credPath })).toThrow(/world.*readable/);
  });
});
