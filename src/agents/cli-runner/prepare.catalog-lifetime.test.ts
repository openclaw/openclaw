import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  acquireWorkspaceSkills,
  type PublishedWorkspaceSkills,
} from "../../skills/loading/workspace-skill-sync.runtime.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import { runAgentCleanupStep } from "../run-cleanup-timeout.js";
import { attachPublishedSandboxSkills } from "../sandbox/published-skills-handoff.js";
import type { SandboxWorkspaceInfo } from "../sandbox/types.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

const sandbox = vi.hoisted(() =>
  vi.fn<
    (params: { workspaceDir: string; skillsOwner?: object }) => Promise<SandboxWorkspaceInfo | null>
  >(),
);
vi.mock("../sandbox.js", () => ({ ensureSandboxWorkspaceForSession: sandbox }));
vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  resetCliRunnerPrepareTestDeps();
  sandbox.mockReset();
});

it.each([false, true])(
  "retains CLI catalog through nested cleanup (preparation failure=%s)",
  async (fails) => {
    const held = createDeferredCore();
    const refusal = new Error("catalog handoff refused");
    const work = new AsyncWorkScope();
    const log = { warn: vi.fn() };
    const fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
    let publication: PublishedWorkspaceSkills | undefined;
    let skillPath = "";
    let descendantRead = "";
    let cleanup: (() => Promise<void>) | undefined;
    const backend = {
      ...buildDefaultTestCliBackend(),
      prepareExecution: async () => ({
        cleanup: () =>
          runAgentCleanupStep({
            runId: "cli-catalog",
            sessionId: "cli-catalog",
            step: "nested-consumer",
            timeoutMs: 1,
            log,
            cleanup: async () => {
              await held.promise;
              descendantRead = await fs.readFile(skillPath, "utf8");
            },
          }),
      }),
    };
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [backend],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      makeBootstrapWarn: () => () => undefined,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      getCliLiveSessionGeneration: () => undefined,
      loadManifestModelCatalog: () => [],
    });
    sandbox.mockImplementation(async ({ workspaceDir, skillsOwner }) => {
      if (!skillsOwner) {
        throw new Error("missing prepared catalog owner");
      }
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
      skillPath = publication.skillUsagePaths.find((entry) => entry.skillName === "demo")!.readPath;
      attachPublishedSandboxSkills(skillsOwner, publication, publication);
      if (fails) {
        throw refusal;
      }
      return null;
    });
    try {
      const prepared = work.run(() =>
        fixture.prepare({
          config: { plugins: { enabled: false }, skills: { load: { watch: false } } },
        }),
      );
      void prepared.then(
        (context) => {
          cleanup = context.preparedBackend.cleanup;
        },
        () => {},
      );
      if (fails) {
        await expect(prepared).rejects.toBe(refusal);
      } else {
        cleanup = (await prepared).preparedBackend.cleanup;
        await cleanup?.();
      }
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
      expect(await fs.readFile(skillPath, "utf8")).toContain("A catalog");
      held.resolve();
      await work.drain();
      expect(descendantRead).toContain("A catalog");
      await expect(fs.access(skillPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      held.resolve();
      await cleanup?.().catch(() => undefined);
      await work.drain();
      await publication?.release();
      fixture.cleanup();
    }
  },
);
