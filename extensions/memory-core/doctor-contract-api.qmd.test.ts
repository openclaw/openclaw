import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { read, useDoctorWorkspace, writeFiles } from "./doctor-contract-api.test-support.js";

const { fixture, params } = useDoctorWorkspace("openclaw-memory-core-doctor-qmd-");

function migration(id: string) {
  const entry = stateMigrations.find((candidate) => candidate.id === `memory-core-${id}`);
  if (!entry) {
    throw new Error(`Missing migration: ${id}`);
  }
  return {
    detect: () => entry.detectLegacyState(params({})),
    run: () => entry.migrateLegacyState(params({})),
  };
}
const workspace = migration("qmd-workspace-retired");
const locks = migration("qmd-file-locks-to-sqlite-leases");

const statePath = (relative: string) => path.join(fixture.stateDir, relative);
const lockPayload = (pid: number) =>
  `${JSON.stringify({ pid, createdAt: new Date().toISOString() })}\n`;
async function expectNoop(subject: ReturnType<typeof migration>) {
  await expect(subject.detect()).resolves.toBeNull();
  await expect(subject.run()).resolves.toEqual({ changes: [], warnings: [] });
}
function expectPaths(messages: string[], paths: string[]) {
  expect(messages).toHaveLength(paths.length);
  paths.forEach((file, index) => expect(messages[index]).toContain(file));
}

it("preserves nonempty QMD homes and does not schedule them for migration", async () => {
  const qmdHome = statePath("agents/main/qmd");
  const transcript = statePath("agents/main/sessions/a.jsonl.reset.2026-08-23T07-10-59.000Z");
  const externalModels = path.join(fixture.rootDir, "shared-qmd-models");
  const symlinkHomeTarget = path.join(fixture.rootDir, "symlink-qmd-home-target");
  const symlinkHome = statePath("agents/other/qmd");
  const retainedFiles = [
    path.join(qmdHome, "xdg-cache/qmd/index.sqlite"),
    statePath("agents/main/agent/openclaw-agent.sqlite"),
    statePath("agents/main!/qmd/index.sqlite"),
    path.join(externalModels, "model.bin"),
    path.join(symlinkHomeTarget, "index.sqlite"),
    transcript,
  ];
  await writeFiles(retainedFiles, "retained");
  await fs.symlink(externalModels, path.join(qmdHome, "xdg-cache", "qmd", "models"));
  await fs.mkdir(path.dirname(symlinkHome), { recursive: true });
  await fs.symlink(symlinkHomeTarget, symlinkHome);

  await expectNoop(workspace);
  for (const file of retainedFiles) {
    await expect(read(file)).resolves.toBe("retained");
  }
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

  expectPaths((await locks.detect())!.preview, [globalLockPath, agentLockPath]);
  const result = await locks.run();
  expectPaths(result.changes, [globalLockPath, agentLockPath]);
  expect(result.warnings).toEqual([]);
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
  const symlinkTargetPath = path.join(fixture.rootDir, "stale-lock-target");
  await fs.mkdir(path.dirname(symlinkLockPath), { recursive: true });
  await writeFiles([globalLockPath], lockPayload(process.pid));
  await writeFiles([malformedLockPath], "{");
  await writeFiles([symlinkTargetPath], lockPayload(2 ** 30));
  await fs.symlink(symlinkTargetPath, symlinkLockPath);

  expectPaths((await locks.detect())!.preview, [globalLockPath, malformedLockPath]);
  const result = await locks.run();
  expect(result.changes).toEqual([]);
  expectPaths(result.warnings, [globalLockPath, malformedLockPath]);
  await fs.access(globalLockPath);
  await expect(read(malformedLockPath)).resolves.toBe("{");
  expect((await fs.lstat(symlinkLockPath)).isSymbolicLink()).toBe(true);
  await fs.access(symlinkTargetPath);
});
