import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSkill } from "./skills.e2e-test-helpers.js";

const { warnMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => {
  const makeLogger = () => ({
    subsystem: "skills",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => makeLogger(),
  });
  return { createSubsystemLogger: () => makeLogger() };
});

import { loadWorkspaceSkillEntries } from "./skills.js";

const tempDirs: string[] = [];

async function createTempWorkspaceDir() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

function escapedRootWarnings() {
  return warnMock.mock.calls.filter(([message]) =>
    String(message).includes("Skipping skill path that resolves outside its configured root."),
  );
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  warnMock.mockClear();
});

describe("skills roots across configured directories", () => {
  it.runIf(process.platform !== "win32")(
    "allows workspace skill symlinks that resolve into the project agents skills root without warning",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const projectAgentsSkillDir = path.join(workspaceDir, ".agents", "skills", "slidev");
      await writeSkill({
        dir: projectAgentsSkillDir,
        name: "slidev",
        description: "Project agents skill",
      });
      await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      await fs.symlink(
        path.join(workspaceDir, ".agents", "skills", "slidev"),
        path.join(workspaceDir, "skills", "slidev"),
        "dir",
      );

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      });

      expect(entries.map((entry) => entry.skill.name)).toContain("slidev");
      expect(escapedRootWarnings()).toHaveLength(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "allows managed skill symlinks that resolve into configured extraDirs without warning",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const managedDir = path.join(workspaceDir, ".managed");
      const extraDir = await createTempWorkspaceDir();
      const sharedSkillDir = path.join(extraDir, "shared-skill");
      await writeSkill({
        dir: sharedSkillDir,
        name: "shared-skill",
        description: "Shared extra-dir skill",
      });
      await fs.mkdir(managedDir, { recursive: true });
      await fs.symlink(sharedSkillDir, path.join(managedDir, "shared-skill"), "dir");

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        config: { skills: { load: { extraDirs: [extraDir] } } },
        managedSkillsDir: managedDir,
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      });

      expect(entries.map((entry) => entry.skill.name)).toContain("shared-skill");
      expect(escapedRootWarnings()).toHaveLength(0);
    },
  );
});
