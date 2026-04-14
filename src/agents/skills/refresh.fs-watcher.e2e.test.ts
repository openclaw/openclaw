import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/**
 * Real filesystem + chokidar integration for the skills watcher.
 * Confirms deleting an entire skill directory bumps the snapshot version (unlinkDir path),
 * which glob-only watches missed on macOS + chokidar 5.
 */
describe("skills watcher (real chokidar)", () => {
  let refreshMod: typeof import("./refresh.js");
  let tmpWorkspace: string | undefined;

  afterEach(async () => {
    if (refreshMod) {
      await refreshMod.resetSkillsRefreshForTest();
    }
    if (tmpWorkspace) {
      await rm(tmpWorkspace, { recursive: true, force: true }).catch(() => {});
      tmpWorkspace = undefined;
    }
  });

  it("bumps getSkillsSnapshotVersion after add then again after rm -rf skill directory", async () => {
    refreshMod = await import("./refresh.js");
    tmpWorkspace = await mkdtemp(path.join(os.tmpdir(), "openclaw-skills-watch-"));
    const skillsRoot = path.join(tmpWorkspace, "skills");
    await mkdir(skillsRoot, { recursive: true });

    const cfg = {
      skills: {
        load: {
          watch: true,
          watchDebounceMs: 50,
        },
      },
    } as OpenClawConfig;

    refreshMod.ensureSkillsWatcher({ workspaceDir: tmpWorkspace, config: cfg });

    const v0 = refreshMod.getSkillsSnapshotVersion(tmpWorkspace);
    expect(v0).toBe(0);

    const skillDir = path.join(skillsRoot, `unlinkdir-e2e-${Date.now()}`);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: unlinkdir-e2e", "description: fs watcher e2e", "---", "# x"].join("\n"),
      "utf8",
    );

    const afterAdd = await waitForVersionAbove(
      tmpWorkspace,
      v0,
      refreshMod.getSkillsSnapshotVersion,
    );
    expect(afterAdd).toBeGreaterThan(v0);

    await rm(skillDir, { recursive: true, force: true });

    const afterDelete = await waitForVersionAbove(
      tmpWorkspace,
      afterAdd,
      refreshMod.getSkillsSnapshotVersion,
    );
    expect(afterDelete).toBeGreaterThan(afterAdd);
  }, 30_000);
});

async function waitForVersionAbove(
  workspaceDir: string,
  baseline: number,
  readVersion: (dir: string) => number,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<number> {
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const intervalMs = opts?.intervalMs ?? 30;
  const deadline = Date.now() + timeoutMs;
  let last = readVersion(workspaceDir);
  while (last <= baseline) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for skills snapshot version > ${baseline} (last=${last})`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    last = readVersion(workspaceDir);
  }
  return last;
}
