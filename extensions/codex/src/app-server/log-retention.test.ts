import { access, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  CODEX_APP_SERVER_LOG_MAX_BYTES_ENV,
  CODEX_APP_SERVER_LOG_RETENTION_ENV,
  CODEX_APP_SERVER_RETIRED_LOG_SNAPSHOTS_ENV,
  applyCodexAppServerLogRetention,
  resolveCodexAppServerLogRetentionConfig,
} from "./log-retention.js";

const logMocks = vi.hoisted(() => ({
  embeddedAgentLog: { warn: vi.fn() },
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  embeddedAgentLog: logMocks.embeddedAgentLog,
}));

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-log-retention-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  logMocks.embeddedAgentLog.warn.mockClear();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function startOptions(codexHome: string): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
    env: { CODEX_HOME: codexHome },
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

describe("Codex app-server log retention", () => {
  it("rotates an oversized Codex log database before app-server startup", async () => {
    const codexHome = await createTempDir();
    await writeFile(path.join(codexHome, "logs_2.sqlite"), "123456", "utf8");
    await writeFile(path.join(codexHome, "logs_2.sqlite-wal"), "wal", "utf8");
    await writeFile(path.join(codexHome, "logs_2.sqlite-shm"), "shm", "utf8");

    const result = await applyCodexAppServerLogRetention({
      startOptions: startOptions(codexHome),
      env: { [CODEX_APP_SERVER_LOG_MAX_BYTES_ENV]: "4" },
      now: () => new Date("2026-05-24T22:00:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    expect(result.sizeBytes).toBe(12);
    expect(result.maxBytes).toBe(4);
    expect(result.rotatedFiles).toHaveLength(3);
    await expect(pathExists(path.join(codexHome, "logs_2.sqlite"))).resolves.toBe(false);
    await expect(
      pathExists(path.join(codexHome, "logs_2.sqlite.retired.2026-05-24T22-00-00-000Z")),
    ).resolves.toBe(true);
    await expect(
      pathExists(path.join(codexHome, "logs_2.sqlite.retired.2026-05-24T22-00-00-000Z-wal")),
    ).resolves.toBe(true);
    await expect(
      pathExists(path.join(codexHome, "logs_2.sqlite.retired.2026-05-24T22-00-00-000Z-shm")),
    ).resolves.toBe(true);
    expect(logMocks.embeddedAgentLog.warn).toHaveBeenCalledWith(
      "codex app-server log database rotated before startup",
      expect.objectContaining({ sizeBytes: 12, maxBytes: 4 }),
    );
  });

  it("leaves an under-limit Codex log database in place", async () => {
    const codexHome = await createTempDir();
    const dbPath = path.join(codexHome, "logs_2.sqlite");
    await writeFile(dbPath, "1234", "utf8");

    const result = await applyCodexAppServerLogRetention({
      startOptions: startOptions(codexHome),
      env: { [CODEX_APP_SERVER_LOG_MAX_BYTES_ENV]: "8" },
    });

    expect(result).toEqual(
      expect.objectContaining({
        rotated: false,
        reason: "under_limit",
        sizeBytes: 4,
        maxBytes: 8,
      }),
    );
    await expect(stat(dbPath)).resolves.toEqual(expect.objectContaining({ size: 4 }));
    expect(logMocks.embeddedAgentLog.warn).not.toHaveBeenCalled();
  });

  it("can be disabled by environment", async () => {
    const codexHome = await createTempDir();
    const dbPath = path.join(codexHome, "logs_2.sqlite");
    await writeFile(dbPath, "123456", "utf8");

    const result = await applyCodexAppServerLogRetention({
      startOptions: startOptions(codexHome),
      env: {
        [CODEX_APP_SERVER_LOG_RETENTION_ENV]: "off",
        [CODEX_APP_SERVER_LOG_MAX_BYTES_ENV]: "1",
      },
    });

    expect(result).toEqual({ rotated: false, reason: "disabled" });
    await expect(stat(dbPath)).resolves.toEqual(expect.objectContaining({ size: 6 }));
  });

  it("prunes older retired snapshots when rotating", async () => {
    const codexHome = await createTempDir();
    await writeFile(path.join(codexHome, "logs_2.sqlite"), "123456", "utf8");
    await writeFile(
      path.join(codexHome, "logs_2.sqlite.retired.2026-05-20T00-00-00-000Z"),
      "old-a",
      "utf8",
    );
    await writeFile(
      path.join(codexHome, "logs_2.sqlite.retired.2026-05-20T00-00-00-000Z-wal"),
      "old-a-wal",
      "utf8",
    );
    await writeFile(
      path.join(codexHome, "logs_2.sqlite.retired.2026-05-21T00-00-00-000Z"),
      "old-b",
      "utf8",
    );

    const result = await applyCodexAppServerLogRetention({
      startOptions: startOptions(codexHome),
      env: {
        [CODEX_APP_SERVER_LOG_MAX_BYTES_ENV]: "4",
        [CODEX_APP_SERVER_RETIRED_LOG_SNAPSHOTS_ENV]: "1",
      },
      now: () => new Date("2026-05-24T22:00:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    expect(result.prunedFiles).toBe(3);
    const entries = await readdir(codexHome);
    expect(entries.toSorted()).toEqual(["logs_2.sqlite.retired.2026-05-24T22-00-00-000Z"]);
  });

  it("normalizes retention config from environment", () => {
    expect(
      resolveCodexAppServerLogRetentionConfig({
        [CODEX_APP_SERVER_LOG_RETENTION_ENV]: "false",
        [CODEX_APP_SERVER_LOG_MAX_BYTES_ENV]: "2048",
        [CODEX_APP_SERVER_RETIRED_LOG_SNAPSHOTS_ENV]: "0",
      }),
    ).toEqual({
      enabled: false,
      maxBytes: 2048,
      retainedSnapshots: 0,
    });
  });
});
