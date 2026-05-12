import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autoMigrateLegacyMatrixCredentials } from "../doctor-legacy-credentials.js";
import { installMatrixTestRuntime } from "../test-runtime.js";
import {
  credentialsMatchConfig,
  loadMatrixCredentials,
  clearMatrixCredentials,
  resolveMatrixCredentialsPath,
  saveBackfilledMatrixDeviceId,
  saveMatrixCredentials,
  touchMatrixCredentials,
} from "./credentials.js";

const DEFAULT_LEGACY_CREDENTIALS = {
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "legacy-token",
  createdAt: "2026-03-01T10:00:00.000Z",
};

type MatrixCredentials = NonNullable<ReturnType<typeof loadMatrixCredentials>>;

function expectMatrixCredentials(
  credentials: ReturnType<typeof loadMatrixCredentials>,
): MatrixCredentials {
  if (credentials === null) {
    throw new Error("Expected Matrix credentials");
  }
  expect(typeof credentials.createdAt).toBe("string");
  return credentials;
}

describe("matrix credentials storage", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
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

  function setupLegacyCredentialsFile(params: {
    cfg: Record<string, unknown>;
    accountId: string;
    credentials?: Record<string, unknown>;
  }) {
    const stateDir = setupStateDir(params.cfg);
    const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
    const currentPath = resolveMatrixCredentialsPath({}, params.accountId);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify(params.credentials ?? DEFAULT_LEGACY_CREDENTIALS));
    return { stateDir, legacyPath, currentPath };
  }

  it("writes credentials into SQLite state", async () => {
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
    expect(credPath).toBe(path.join(stateDir, "credentials", "matrix", "credentials-ops.json"));
    expect(fs.existsSync(credPath)).toBe(false);
    expect(loadMatrixCredentials({}, "ops")).toMatchObject({
      accessToken: "secret-token",
      deviceId: "DEVICE123",
    });
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
      const initialCredentials = expectMatrixCredentials(initial);

      vi.setSystemTime(new Date("2026-03-01T10:05:00.000Z"));
      await touchMatrixCredentials({}, "default");
      const touched = loadMatrixCredentials({}, "default");
      const touchedCredentials = expectMatrixCredentials(touched);

      expect(touchedCredentials.createdAt).toBe(initialCredentials.createdAt);
      expect(touchedCredentials.lastUsedAt).toBe("2026-03-01T10:05:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("backfill updates deviceId when credentials still match the same auth lineage", async () => {
    setupStateDir();
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      },
      {},
      "default",
    );

    await expect(
      saveBackfilledMatrixDeviceId(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
          deviceId: "DEVICE123",
        },
        {},
        "default",
      ),
    ).resolves.toBe("saved");

    const credentials = expectMatrixCredentials(loadMatrixCredentials({}, "default"));
    expect(credentials.accessToken).toBe("tok-123");
    expect(credentials.deviceId).toBe("DEVICE123");
  });

  it("backfill skips when newer credentials already changed the token", async () => {
    setupStateDir();
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-new",
        deviceId: "DEVICE999",
      },
      {},
      "default",
    );

    await expect(
      saveBackfilledMatrixDeviceId(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-old",
          deviceId: "DEVICE123",
        },
        {},
        "default",
      ),
    ).resolves.toBe("skipped");

    const credentials = expectMatrixCredentials(loadMatrixCredentials({}, "default"));
    expect(credentials.accessToken).toBe("tok-new");
    expect(credentials.deviceId).toBe("DEVICE999");
  });

  it("does not migrate legacy matrix credential files during runtime reads", () => {
    const { legacyPath, currentPath } = setupLegacyCredentialsFile({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              ops: {},
            },
          },
        },
      },
      accountId: "ops",
    });

    const loaded = loadMatrixCredentials({}, "ops");

    expect(loaded).toBeNull();
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.existsSync(currentPath)).toBe(false);
  });

  it("migrates legacy matrix credential files from doctor", () => {
    const { legacyPath, currentPath } = setupLegacyCredentialsFile({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              ops: {},
            },
          },
        },
      },
      accountId: "ops",
    });

    const result = autoMigrateLegacyMatrixCredentials({
      cfg: { channels: { matrix: { accounts: { ops: {} } } } },
      env: {},
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(currentPath)).toBe(false);
    expect(loadMatrixCredentials({}, "ops")?.accessToken).toBe("legacy-token");
  });

  it("clears only the current account credentials row", async () => {
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
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, "{}");
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@ops:example.org",
        accessToken: "ops-token",
      },
      {},
      "ops",
    );
    await saveMatrixCredentials(
      {
        homeserver: "https://matrix.example.org",
        userId: "@default:example.org",
        accessToken: "default-token",
      },
      {},
      "default",
    );

    clearMatrixCredentials({}, "ops");

    expect(loadMatrixCredentials({}, "ops")).toBeNull();
    expect(loadMatrixCredentials({}, "default")?.accessToken).toBe("default-token");
    expect(fs.existsSync(legacyPath)).toBe(true);
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
