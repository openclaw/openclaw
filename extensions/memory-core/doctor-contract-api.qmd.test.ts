import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSessionEntry } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { createDoctorContext } from "./doctor-contract-api.test-support.js";

let rootDir = "";
let stateDir = "";
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-core-doctor-qmd-"));
  stateDir = path.join(rootDir, "state");
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
});

afterEach(() => fs.rm(rootDir, { recursive: true, force: true }));

function migration(id: string) {
  const entry = stateMigrations.find((candidate) => candidate.id === `memory-core-${id}`);
  if (!entry) {
    throw new Error(`Missing migration: ${id}`);
  }
  const params = () => ({
    config: {},
    env,
    stateDir,
    oauthDir: path.join(rootDir, "oauth"),
    context: createDoctorContext(env),
  });
  return {
    detect: () => entry.detectLegacyState(params()),
    run: () => entry.migrateLegacyState(params()),
  };
}
const workspace = migration("qmd-workspace-retired");
const locks = migration("qmd-file-locks-to-sqlite-leases");

const statePath = (relative: string) => path.join(stateDir, relative);
const read = (file: string) => fs.readFile(file, "utf8");
const lockPayload = (pid: number) =>
  `${JSON.stringify({ pid, createdAt: new Date().toISOString() })}\n`;
async function writeFiles(paths: string[], contents = "derived") {
  for (const filePath of paths) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, "utf8");
  }
}
async function expectNoop(subject: ReturnType<typeof migration>) {
  await expect(subject.detect()).resolves.toBeNull();
  await expect(subject.run()).resolves.toEqual({
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
  const transcript = statePath("agents/main/sessions/a.jsonl.reset.2026-08-23T07-10-59.000Z");
  const externalModels = path.join(rootDir, "shared-qmd-models");
  const symlinkHomeTarget = path.join(rootDir, "symlink-qmd-home-target");
  const symlinkHome = statePath("agents/other/qmd");
  const protectedFiles = [
    statePath("agents/main/agent/openclaw-agent.sqlite"),
    statePath("agents/main!/qmd/index.sqlite"),
    path.join(externalModels, "model.bin"),
    path.join(symlinkHomeTarget, "index.sqlite"),
  ];
  const derivedPaths = [
    "xdg-cache/qmd/index.sqlite",
    "xdg-config/qmd/index.yml",
    "sessions/session.md",
  ];
  await writeFiles([
    ...derivedPaths.map((relative) => path.join(qmdHome, relative)),
    ...protectedFiles,
    transcript,
  ]);
  const message = { role: "user", content: "Retained recall fact" };
  await fs.writeFile(transcript, JSON.stringify({ type: "message", message }), "utf8");
  await fs.symlink(externalModels, path.join(qmdHome, "xdg-cache", "qmd", "models"));
  await fs.mkdir(path.dirname(symlinkHome), { recursive: true });
  await fs.symlink(symlinkHomeTarget, symlinkHome);

  await expectNoop(workspace);
  for (const relativePath of derivedPaths) {
    await expect(read(path.join(qmdHome, relativePath))).resolves.toBe("derived");
  }
  await expect(read(transcript)).resolves.toContain(message.content);
  expect((await buildSessionEntry(transcript))?.content).toBe("User: Retained recall fact");
  await Promise.all(protectedFiles.map((file) => fs.access(file)));
  expect((await fs.lstat(symlinkHome)).isSymbolicLink()).toBe(true);
});

it("retires an empty QMD home", async () => {
  const qmdHome = statePath("agents/main/qmd");
  await fs.mkdir(qmdHome, { recursive: true });
  expect(await workspace.detect()).not.toBeNull();
  const result = await workspace.run();
  expect(result.warnings).toEqual([]);
  await expect(fs.access(qmdHome)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(workspace.detect()).resolves.toBeNull();
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

  const result = await workspace.run();

  await expect(read(configPath)).resolves.toBe("standalone QMD configuration\n");
  expect(result).toMatchObject({
    warningDisposition: "recoverable",
    warnings: expect.arrayContaining([expect.stringContaining(qmdHome)]),
  });
  await expect(workspace.detect()).resolves.toBeNull();
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

  await expect(locks.detect()).resolves.toEqual(lockPreview([globalLockPath, agentLockPath]));
  await expect(locks.run()).resolves.toEqual({
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
  await expectNoop(locks);
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

  await expect(locks.detect()).resolves.toEqual(lockPreview([globalLockPath, malformedLockPath]));
  await expect(locks.run()).resolves.toEqual({
    changes: [],
    warnings: [globalLockPath, malformedLockPath].map(
      (filePath) =>
        `Retained retired Memory Core QMD file lock because its owner is live or ambiguous: ${filePath}`,
    ),
  });
  await fs.access(globalLockPath);
  await expect(read(malformedLockPath)).resolves.toBe("{");
  expect((await fs.lstat(symlinkLockPath)).isSymbolicLink()).toBe(true);
  await fs.access(symlinkTargetPath);
});
