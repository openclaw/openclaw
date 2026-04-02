import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import {
  credentialsMatchConfig,
  loadMatrixCredentials,
  clearMatrixCredentials,
  resolveMatrixCredentialsPath,
  saveMatrixCredentials,
  touchMatrixCredentials,
} from "./credentials.js";

describe("matrix credentials storage", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupStateDir(
    cfg: Record<string, unknown> = {
      channels: {
        matrix: {},
      },
    },
  ): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-creds-"));
    tempDirs.push(dir);
    installMatrixTestRuntime({ cfg, stateDir: dir });
    return dir;
  }

  it("writes credentials atomically with secure file permissions", async () => {
    const stateDir = setupStateDir();
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "secret-token",
        deviceId: "DEVICE123",
      },
      {},
      "ops",
    );

    const credPath = resolveMatrixCredentialsPath({}, "ops");
    expect(fs.existsSync(credPath)).toBe(true);
    expect(credPath).toBe(path.join(stateDir, "credentials", "matrix", "credentials-ops.json"));
    const mode = fs.statSync(credPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("touch updates lastUsedAt while preserving createdAt", async () => {
    setupStateDir();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
      await saveMatrixCredentials(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "secret-token",
        },
        {},
        "default",
      );
      const initial = loadMatrixCredentials({}, "default");
      expect(initial).not.toBeNull();

      vi.setSystemTime(new Date("2026-03-01T10:05:00.000Z"));
      await touchMatrixCredentials({}, "default");
      const touched = loadMatrixCredentials({}, "default");
      expect(touched).not.toBeNull();

      expect(touched?.createdAt).toBe(initial?.createdAt);
      expect(touched?.lastUsedAt).toBe("2026-03-01T10:05:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("migrates legacy matrix credential files on read", async () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          accounts: {
            ops: {},
          },
        },
      },
    });
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    const currentPath = resolveMatrixCredentialsPath({}, "ops");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "legacy-token",
        createdAt: "2026-03-01T10:00:00.000Z",
      }),
    );

    const loaded = loadMatrixCredentials({}, "ops");

    expect(loaded?.accessToken).toBe("legacy-token");
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(currentPath)).toBe(true);
  });

  it("does not migrate legacy default credentials during a non-selected account read", () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          defaultAccount: "default",
          accounts: {
            default: {
              homeserver: "https://matrix.default.example.org",
              accessToken: "default-token",
            },
            ops: {},
          },
        },
      },
    });
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    const currentPath = resolveMatrixCredentialsPath({}, "ops");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        homeserver: "https://matrix.default.example.org",
        userId: "@default:example.org",
        accessToken: "default-token",
        createdAt: "2026-03-01T10:00:00.000Z",
      }),
    );

    const loaded = loadMatrixCredentials({}, "ops");

    expect(loaded).toBeNull();
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.existsSync(currentPath)).toBe(false);
  });

  it("migrates legacy credentials to the named account when top-level auth is only a shared default", () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          accessToken: "shared-token",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    });
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    const currentPath = resolveMatrixCredentialsPath({}, "ops");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        homeserver: "https://matrix.example.org",
        userId: "@ops:example.org",
        accessToken: "legacy-token",
        createdAt: "2026-03-01T10:00:00.000Z",
      }),
    );

    const loaded = loadMatrixCredentials({}, "ops");

    expect(loaded?.accessToken).toBe("legacy-token");
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(currentPath)).toBe(true);
  });

  it("clears both current and legacy credential paths", () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          accounts: {
            ops: {},
          },
        },
      },
    });
    const currentPath = resolveMatrixCredentialsPath({}, "ops");
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(currentPath, "{}");
    fs.writeFileSync(legacyPath, "{}");

    clearMatrixCredentials({}, "ops");

    expect(fs.existsSync(currentPath)).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("requires a token match when userId is absent", () => {
    expect(
      credentialsMatchConfig(
        {
          homeserver: "https://matrix.example.org",
          userId: "@old:example.org",
          accessToken: "tok-old",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          homeserver: "https://matrix.example.org",
          userId: "",
          accessToken: "tok-new",
        },
      ),
    ).toBe(false);

    expect(
      credentialsMatchConfig(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          homeserver: "https://matrix.example.org",
          userId: "",
          accessToken: "tok-123",
        },
      ),
    ).toBe(true);
  });
});
