import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSessionEntry } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import {
  createDoctorContext,
  resetDoctorPluginState,
  type RawLegacyDoctorConfig,
} from "./doctor-contract-api.test-support.js";
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
    const config: RawLegacyDoctorConfig = {
      agents: { list: [{ id: "main", workspace: workspaceDir }] },
    };
    return {
      config,
      env,
      stateDir,
      oauthDir: path.join(rootDir, "oauth"),
      context: createDoctorContext(env),
    };
  }

  const statePath = (relative: string) => path.join(stateDir, relative);
  const lockPayload = (pid: number) =>
    `${JSON.stringify({ pid, createdAt: new Date().toISOString() })}\n`;
  async function writeFiles(paths: string[], contents = "derived") {
    for (const filePath of paths) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents, "utf8");
    }
  }
  async function expectNoop(migration: ReturnType<typeof getMigration>) {
    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  }
  const lockPreview = (paths: string[]) => ({
    preview: paths.map(
      (filePath) =>
        `- Retired Memory Core QMD file lock: ${filePath} -> remove only if definitely stale (coordination now uses SQLite leases)`,
    ),
  });

  it("preserves nonempty QMD homes and does not schedule them for migration", async () => {
    const qmdHome = statePath("agents/main/qmd");
    const canonicalAgentFile = statePath("agents/main/agent/openclaw-agent.sqlite");
    const retainedResetTranscript = statePath(
      "agents/main/sessions/session-1.jsonl.reset.2026-08-23T07-10-59.000Z",
    );
    const invalidAgentQmdHome = statePath("agents/main!/qmd");
    const externalModels = path.join(rootDir, "shared-qmd-models");
    const symlinkHomeTarget = path.join(rootDir, "symlink-qmd-home-target");
    const symlinkHome = statePath("agents/other/qmd");
    const derivedPaths = [
      "xdg-cache/qmd/index.sqlite",
      "xdg-config/qmd/index.yml",
      "sessions/session.md",
    ];
    await writeFiles([
      ...derivedPaths.map((relative) => path.join(qmdHome, relative)),
      canonicalAgentFile,
      retainedResetTranscript,
      path.join(invalidAgentQmdHome, "index.sqlite"),
      path.join(externalModels, "model.bin"),
      path.join(symlinkHomeTarget, "index.sqlite"),
    ]);
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
    await expectNoop(migration);

    for (const relativePath of derivedPaths) {
      await expect(fs.readFile(path.join(qmdHome, relativePath), "utf8")).resolves.toBe("derived");
    }
    await fs.access(canonicalAgentFile);
    await expect(fs.readFile(retainedResetTranscript, "utf8")).resolves.toContain(
      "Retained reset transcript recall fact",
    );
    expect((await buildSessionEntry(retainedResetTranscript))?.content).toBe(
      "User: Retained reset transcript recall fact",
    );
    await fs.access(invalidAgentQmdHome);
    await fs.access(path.join(externalModels, "model.bin"));
    expect((await fs.lstat(symlinkHome)).isSymbolicLink()).toBe(true);
    await fs.access(path.join(symlinkHomeTarget, "index.sqlite"));
    await expectNoop(migration);
  });

  it("retires an empty QMD home", async () => {
    const qmdHome = statePath("agents/main/qmd");
    await fs.mkdir(qmdHome, { recursive: true });
    const migration = qmdWorkspaceMigration();
    expect(await migration.detectLegacyState(migrationParams())).not.toBeNull();
    const result = await migration.migrateLegacyState(migrationParams());
    expect(result.warnings).toEqual([]);
    await expect(fs.access(qmdHome)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
  });

  it("preserves QMD files created between inspection and removal without blocking Doctor", async () => {
    const qmdHome = statePath("agents/main/qmd");
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
    const globalLockPath = statePath("qmd/embed.lock.lock");
    const agentLockPath = statePath("agents/main/qmd-write.lock.lock");
    const ignoredPaths = [
      "qmd/other.lock.lock",
      "agents/main/nested/qmd-write.lock.lock",
      "agents/main!/qmd-write.lock.lock",
      "agents/main/qmd-write.lock.lock.extra",
    ].map(statePath);
    await writeFiles([globalLockPath, agentLockPath, ...ignoredPaths], lockPayload(2 ** 30));

    const migration = qmdFileLockMigration();
    await expect(migration.detectLegacyState(migrationParams())).resolves.toEqual(
      lockPreview([globalLockPath, agentLockPath]),
    );

    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [
        `Removed retired Memory Core QMD file lock: ${globalLockPath}`,
        `Removed retired Memory Core QMD file lock: ${agentLockPath}`,
      ],
      warnings: [],
    });
    for (const filePath of [
      globalLockPath,
      agentLockPath,
      statePath("openclaw.sqlite"),
      statePath("agents/main/agent/openclaw-agent.sqlite"),
    ]) {
      await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const filePath of ignoredPaths) {
      await fs.access(filePath);
    }
    await expectNoop(migration);
  });

  it("retains live and ambiguous QMD locks and ignores symlink candidates", async () => {
    const globalLockPath = statePath("qmd/embed.lock.lock");
    const malformedLockPath = statePath("agents/main/qmd-write.lock.lock");
    const symlinkLockPath = statePath("agents/other/qmd-write.lock.lock");
    const symlinkTargetPath = path.join(rootDir, "stale-lock-target");
    await fs.mkdir(path.dirname(symlinkLockPath), { recursive: true });
    await writeFiles([globalLockPath], lockPayload(process.pid));
    await writeFiles([malformedLockPath], "{");
    await writeFiles([symlinkTargetPath], lockPayload(2 ** 30));
    await fs.symlink(symlinkTargetPath, symlinkLockPath);

    const migration = qmdFileLockMigration();
    await expect(migration.detectLegacyState(migrationParams())).resolves.toEqual(
      lockPreview([globalLockPath, malformedLockPath]),
    );
    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [globalLockPath, malformedLockPath].map(
        (filePath) =>
          `Retained retired Memory Core QMD file lock because its owner is live or ambiguous: ${filePath}`,
      ),
    });
    await fs.access(globalLockPath);
    await expect(fs.readFile(malformedLockPath, "utf8")).resolves.toBe("{");
    expect((await fs.lstat(symlinkLockPath)).isSymbolicLink()).toBe(true);
    await fs.access(symlinkTargetPath);
  });
});
