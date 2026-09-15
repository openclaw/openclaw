import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  acquireWorkspaceSkills,
  type PublishedWorkspaceSkills,
} from "../../../skills/loading/workspace-skill-sync.runtime.js";
import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";
import { attachPublishedSandboxSkills } from "../../sandbox/published-skills-handoff.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];
beforeAll(preloadRunEmbeddedAttemptForTests);
beforeEach(resetEmbeddedAttemptHarness);
afterEach(async () => {
  await cleanupTempPaths(tempPaths);
  tempPaths.length = 0;
});

it("retains the embedded catalog through descendants of completed registered cleanup", async () => {
  const held = createDeferredCore();
  const work = new AsyncWorkScope();
  const log = { warn: vi.fn() };
  let publication: PublishedWorkspaceSkills | undefined;
  let skillPath = "";
  let descendantRead = "";
  // Keep the real attempt owner/materializer; replace only external sandbox provisioning.
  hoisted.resolveSandboxContextMock.mockImplementation(async (input: unknown) => {
    const { workspaceDir, skillsOwner } = input as { workspaceDir: string; skillsOwner: object };
    const skill = path.join(workspaceDir, "skills", "demo");
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      "---\nname: demo\ndescription: retained\n---\nA catalog\n",
    );
    publication = await acquireWorkspaceSkills({
      sourceWorkspaceDir: workspaceDir,
      targetWorkspaceDir: path.join(workspaceDir, "published"),
      bundledSkillsDir: path.join(workspaceDir, "no-bundled"),
      managedSkillsDir: path.join(workspaceDir, "no-managed"),
    });
    attachPublishedSandboxSkills(skillsOwner, publication, publication);
    skillPath = publication.skillUsagePaths.find((entry) => entry.skillName === "demo")!.readPath;
    return null;
  });
  hoisted.createOpenClawCodingToolsMock.mockImplementation((input: unknown) => {
    const { registerRunCleanup } = input as {
      registerRunCleanup: (cleanup: () => Promise<void>) => void;
    };
    registerRunCleanup(() =>
      runAgentCleanupStep({
        runId: "embedded-catalog",
        sessionId: "embedded-catalog",
        step: "nested-consumer",
        timeoutMs: 1,
        log,
        cleanup: async () => {
          await held.promise;
          descendantRead = await fs.readFile(skillPath, "utf8");
        },
      }),
    );
    return [];
  });
  const attempt = work.run(() =>
    createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:catalog",
      tempPaths,
      sessionPrompt: async () => {},
      attemptOverrides: { disableTools: false },
    }),
  );
  try {
    expect((await attempt).terminal).toEqual({ kind: "ok" });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    expect(await fs.readFile(skillPath, "utf8")).toContain("A catalog");
    held.resolve();
    await work.drain();
    expect(descendantRead).toContain("A catalog");
    await expect(fs.access(skillPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    held.resolve();
    await attempt.catch(() => undefined);
    await work.drain();
    await publication?.release();
  }
});
