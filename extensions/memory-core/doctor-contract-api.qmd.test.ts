import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSessionEntry } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { createDoctorContext, resetDoctorPluginState } from "./doctor-contract-api.test-support.js";
import { resetMemoryCoreDreamingStateForTests } from "./src/test-helpers.js";

function getMigration(id: string) {
  const entry = stateMigrations.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Missing migration: ${id}`);
  }
  return entry;
}

const qmdFileLockMigration = () => getMigration("memory-core-qmd-file-locks-to-sqlite-leases");
const qmdWorkspaceMigration = () => getMigration("memory-core-qmd-workspace-retired");

describe("memory-core doctor QMD migration", () => {
  let rootDir = "";
  let workspaceDir = "";
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    await resetDoctorPluginState();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-core-doctor-qmd-"));
    workspaceDir = path.join(rootDir, "workspace");
    stateDir = path.join(rootDir, "state");
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    await resetDoctorPluginState();
    resetMemoryCoreDreamingStateForTests();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function migrationParams() {
    return {
      config: { agents: { list: [{ id: "main", workspace: workspaceDir }] } },
      env,
      stateDir,
      oauthDir: path.join(rootDir, "oauth"),
      context: createDoctorContext(env),
    };
  }

  it("preserves nonempty QMD homes and does not schedule them for migration", async () => {
    const qmdHome = path.join(stateDir, "agents", "main", "qmd");
    const canonicalAgentFile = path.join(
      stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    const retainedResetTranscript = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "session-1.jsonl.reset.2026-08-23T07-10-59.000Z",
    );
    const invalidAgentQmdHome = path.join(stateDir, "agents", "main!", "qmd");
    const externalModels = path.join(rootDir, "shared-qmd-models");
    const symlinkHomeTarget = path.join(rootDir, "symlink-qmd-home-target");
    const symlinkHome = path.join(stateDir, "agents", "other", "qmd");
    for (const filePath of [
      path.join(qmdHome, "xdg-cache", "qmd", "index.sqlite"),
      path.join(qmdHome, "xdg-config", "qmd", "index.yml"),
      path.join(qmdHome, "sessions", "session.md"),
      canonicalAgentFile,
      retainedResetTranscript,
      path.join(invalidAgentQmdHome, "index.sqlite"),
      path.join(externalModels, "model.bin"),
      path.join(symlinkHomeTarget, "index.sqlite"),
    ]) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "derived", "utf8");
    }
    await fs.writeFile(
      retainedResetTranscript,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Retained reset transcript recall fact" },
      }),
      "utf8",
    );
    await fs.symlink(externalModels, path.join(qmdHome, "xdg-cache", "qmd", "models"));
    await fs.mkdir(path.dirname(symlinkHome), { recursive: true });
    await fs.symlink(symlinkHomeTarget, symlinkHome);

    const migration = qmdWorkspaceMigration();
    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [],
    });

    for (const relativePath of [
      "xdg-cache/qmd/index.sqlite",
      "xdg-config/qmd/index.yml",
      "sessions/session.md",
    ]) {
      await expect(fs.readFile(path.join(qmdHome, relativePath), "utf8")).resolves.toBe("derived");
    }
    await expect(fs.access(canonicalAgentFile)).resolves.toBeUndefined();
    await expect(fs.readFile(retainedResetTranscript, "utf8")).resolves.toContain(
      "Retained reset transcript recall fact",
    );
    expect((await buildSessionEntry(retainedResetTranscript))?.content).toBe(
      "User: Retained reset transcript recall fact",
    );
    await expect(fs.access(invalidAgentQmdHome)).resolves.toBeUndefined();
    await expect(fs.access(path.join(externalModels, "model.bin"))).resolves.toBeUndefined();
    expect((await fs.lstat(symlinkHome)).isSymbolicLink()).toBe(true);
    await expect(fs.access(path.join(symlinkHomeTarget, "index.sqlite"))).resolves.toBeUndefined();
    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("retires an empty QMD home", async () => {
    const qmdHome = path.join(stateDir, "agents", "main", "qmd");
    await fs.mkdir(qmdHome, { recursive: true });
    const migration = qmdWorkspaceMigration();
    expect(await migration.detectLegacyState(migrationParams())).not.toBeNull();
    const result = await migration.migrateLegacyState(migrationParams());
    expect(result.warnings).toEqual([]);
    await expect(fs.access(qmdHome)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
  });

  it("preserves QMD files created between inspection and removal without blocking Doctor", async () => {
    const qmdHome = path.join(rootDir, "state", "agents", "main", "qmd");
    const configPath = path.join(qmdHome, "index.yml");
    await fs.mkdir(qmdHome, { recursive: true });
    const remove = fs.rmdir;
    vi.spyOn(fs, "rmdir").mockImplementation(async (target) => {
      if (target === qmdHome) {
        await fs.writeFile(configPath, "standalone QMD configuration\n");
      }
      return remove(target);
    });

    const result = await qmdWorkspaceMigration().migrateLegacyState(migrationParams());

    await expect(fs.readFile(configPath, "utf8")).resolves.toBe("standalone QMD configuration\n");
    expect(result.warningDisposition).toBe("recoverable");
    expect(result.warnings).toContainEqual(expect.stringContaining(qmdHome));
    await expect(qmdWorkspaceMigration().detectLegacyState(migrationParams())).resolves.toBeNull();
  });

  it("removes only exact stale QMD lock sidecars and is idempotent", async () => {
    const globalLockPath = path.join(stateDir, "qmd", "embed.lock.lock");
    const agentLockPath = path.join(stateDir, "agents", "main", "qmd-write.lock.lock");
    const ignoredPaths = [
      path.join(stateDir, "qmd", "other.lock.lock"),
      path.join(stateDir, "agents", "main", "nested", "qmd-write.lock.lock"),
      path.join(stateDir, "agents", "main!", "qmd-write.lock.lock"),
      path.join(stateDir, "agents", "main", "qmd-write.lock.lock.extra"),
    ];
    const stalePayload = `${JSON.stringify({ pid: 2 ** 30, createdAt: new Date().toISOString() })}\n`;
    for (const filePath of [globalLockPath, agentLockPath, ...ignoredPaths]) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, stalePayload, "utf8");
    }

    const migration = qmdFileLockMigration();
    await expect(migration.detectLegacyState(migrationParams())).resolves.toEqual({
      preview: [
        `- Retired Memory Core QMD file lock: ${globalLockPath} -> remove only if definitely stale (coordination now uses SQLite leases)`,
        `- Retired Memory Core QMD file lock: ${agentLockPath} -> remove only if definitely stale (coordination now uses SQLite leases)`,
      ],
    });

    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [
        `Removed retired Memory Core QMD file lock: ${globalLockPath}`,
        `Removed retired Memory Core QMD file lock: ${agentLockPath}`,
      ],
      warnings: [],
    });
    await expect(fs.access(globalLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(agentLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(stateDir, "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.access(path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const filePath of ignoredPaths) {
      await fs.access(filePath);
    }
    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("retains live and ambiguous QMD locks and ignores symlink candidates", async () => {
    const globalLockPath = path.join(stateDir, "qmd", "embed.lock.lock");
    const malformedLockPath = path.join(stateDir, "agents", "main", "qmd-write.lock.lock");
    const symlinkLockPath = path.join(stateDir, "agents", "other", "qmd-write.lock.lock");
    const symlinkTargetPath = path.join(rootDir, "stale-lock-target");
    await fs.mkdir(path.dirname(globalLockPath), { recursive: true });
    await fs.mkdir(path.dirname(malformedLockPath), { recursive: true });
    await fs.mkdir(path.dirname(symlinkLockPath), { recursive: true });
    await fs.writeFile(
      globalLockPath,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await fs.writeFile(malformedLockPath, "{", "utf8");
    await fs.writeFile(
      symlinkTargetPath,
      `${JSON.stringify({ pid: 2 ** 30, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await fs.symlink(symlinkTargetPath, symlinkLockPath);

    const migration = qmdFileLockMigration();
    await expect(migration.detectLegacyState(migrationParams())).resolves.toEqual({
      preview: [
        `- Retired Memory Core QMD file lock: ${globalLockPath} -> remove only if definitely stale (coordination now uses SQLite leases)`,
        `- Retired Memory Core QMD file lock: ${malformedLockPath} -> remove only if definitely stale (coordination now uses SQLite leases)`,
      ],
    });
    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [
        `Retained retired Memory Core QMD file lock because its owner is live or ambiguous: ${globalLockPath}`,
        `Retained retired Memory Core QMD file lock because its owner is live or ambiguous: ${malformedLockPath}`,
      ],
    });
    await expect(fs.access(globalLockPath)).resolves.toBeUndefined();
    await expect(fs.readFile(malformedLockPath, "utf8")).resolves.toBe("{");
    expect((await fs.lstat(symlinkLockPath)).isSymbolicLink()).toBe(true);
    await expect(fs.access(symlinkTargetPath)).resolves.toBeUndefined();
  });
});
