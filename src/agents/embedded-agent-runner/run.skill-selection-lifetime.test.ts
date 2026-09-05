import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildWorkspaceSkillCommandSpecs } from "../../skills/discovery/command-specs.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { applySkillProposal, proposeCreateSkill } from "../../skills/workshop/service.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  createOverflowRunParams,
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";

let runHarness: Awaited<ReturnType<typeof loadRunOverflowCompactionHarness>>;
let bindWorkspaceSkillUsage: typeof import("../../skills/runtime/run-usage.js").bindWorkspaceSkillUsage;
let createSkillWorkshopTool: typeof import("../tools/skill-workshop-tool.js").createSkillWorkshopTool;
let getAgentRunContext: typeof import("../../infra/agent-run-registry.js").getAgentRunContext;

beforeAll(async () => {
  runHarness = await loadRunOverflowCompactionHarness();
  ({ bindWorkspaceSkillUsage } = await import("../../skills/runtime/run-usage.js"));
  ({ createSkillWorkshopTool } = await import("../tools/skill-workshop-tool.js"));
  ({ getAgentRunContext } = await import("../../infra/agent-run-registry.js"));
});

function hasRunWorkspaceSkillUsage(params: Parameters<typeof bindWorkspaceSkillUsage>[0]): boolean {
  return bindWorkspaceSkillUsage(params)?.() === true;
}

describe("explicit skill selection lifetime", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.skill-selection-lifetime" });
    useOpenAIPlatformAuthFixture();
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("revokes a failed run receipt before the CLI session id is reused", async () => {
    const skillName = "failed-run-repair";
    const proposal = await proposeCreateSkill({
      workspaceDir: state.workspaceDir,
      env: state.env,
      name: skillName,
      description: "Failed run receipt proof fixture",
      content: `# ${skillName}\n\nKeep OLD_GUIDANCE.\n`,
    });
    await applySkillProposal({
      workspaceDir: state.workspaceDir,
      env: state.env,
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
    });

    const entries = loadWorkspaceSkills(state.workspaceDir, {
      managedSkillsDir: path.join(state.root, "managed"),
      bundledSkillsDir: "",
      pluginSkillsDir: path.join(state.root, "plugins"),
    });
    const skillsSnapshot = buildSkillSnapshot(state.workspaceDir, { entries });
    const selected = buildWorkspaceSkillCommandSpecs(state.workspaceDir, { entries }).find(
      (command) => command.skillName === skillName,
    );
    const snapshotCommand = skillsSnapshot.resolvedSkillCommands?.find(
      (command) => command.skillName === skillName,
    );
    expect(selected?.skillFile).toBeTruthy();
    expect(snapshotCommand).toBeTruthy();
    expect(selected?.skillFile).toBe(snapshotCommand?.selectionPath);

    const runId = "reused-cli-session-id";
    const skillFile = snapshotCommand?.skillFile ?? "";
    const failedAttempt = new Error("native harness stopped before turn finalization");
    let failedRunInstance: { instanceId: string; runId: string } | undefined;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      failedRunInstance = getAgentRunContext(runId)?.delegatedAuthority?.operationalRunInstance;
      expect(attempt.explicitSkillSelections).toEqual([
        { name: selected?.name, path: selected?.skillFile },
      ]);
      expect(attempt.skillsSnapshot?.resolvedSkillCommands).toContainEqual(snapshotCommand);
      expect(
        hasRunWorkspaceSkillUsage({
          operationalRunInstance: failedRunInstance,
          skillFile,
        }),
      ).toBe(true);
      throw failedAttempt;
    });

    await expect(
      runHarness.runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "openai",
        model: "gpt-5.6-luna",
        sessionId: runId,
        runId,
        explicitSkillSelections: selected?.skillFile
          ? [{ name: selected.name, path: selected.skillFile }]
          : [],
        skillsSnapshot,
      }),
    ).rejects.toBe(failedAttempt);
    expect(
      hasRunWorkspaceSkillUsage({
        operationalRunInstance: failedRunInstance,
        skillFile,
      }),
    ).toBe(false);

    const tool = createSkillWorkshopTool({
      workspaceDir: state.workspaceDir,
      env: state.env,
      config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
      agentId: "main",
      origin: { agentId: "main", runId },
    });
    await tool.execute("prepare-reused-session", {
      action: "prepare_patch",
      skill_name: skillName,
      old_string: "Keep OLD_GUIDANCE.",
    });

    let patchError: unknown;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      const replacementRunInstance =
        getAgentRunContext(runId)?.delegatedAuthority?.operationalRunInstance;
      expect(
        hasRunWorkspaceSkillUsage({
          operationalRunInstance: replacementRunInstance,
          skillFile,
        }),
      ).toBe(false);
      try {
        await tool.execute("patch-reused-session", {
          action: "patch",
          skill_name: skillName,
          old_string: "Keep OLD_GUIDANCE.",
          new_string: "Keep NEW_GUIDANCE.",
        });
      } catch (error) {
        patchError = error;
      }
      return makeAttemptResult({ assistantTexts: ["Repair remained denied"] });
    });

    await runHarness.runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "openai",
      model: "gpt-5.6-luna",
      sessionId: runId,
      runId,
      skillsSnapshot,
    });

    expect(patchError).toBeInstanceOf(Error);
    expect((patchError as Error).message).toContain(
      `skill "${skillName}" was not used in this run`,
    );
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("Keep OLD_GUIDANCE.");
  });
});
