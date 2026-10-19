import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { recordExplicitSkillSelectionFileHost } from "../../skills/discovery/skill-command-provenance.js";
import { createSyntheticSourceInfo } from "../../skills/loading/skill-contract.js";
import { resolveSkillsPrompt } from "../../skills/loading/workspace-skill-prompt.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import { recordSkillFileHost, resolveSkillFileHost } from "../../skills/skill-file-host.js";
import type { SkillSnapshot } from "../../skills/types.js";
import {
  mapSandboxSkillEntriesForPrompt,
  remapExplicitSkillSelectionPath,
  remapSkillReferencePaths,
  resolveSandboxSkillRuntimeInputs,
} from "./sandbox-skills.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const hostSkillPath = "/usr/lib/node_modules/openclaw/skills/demo/SKILL.md";
const hostSkillBaseDir = "/usr/lib/node_modules/openclaw/skills/demo";
const workspaceSkill = recordSkillFileHost(
  {
    name: "demo",
    description: "Demo skill",
    filePath: hostSkillPath,
    baseDir: hostSkillBaseDir,
    source: "openclaw-bundled",
    sourceInfo: createSyntheticSourceInfo(hostSkillPath, {
      source: "openclaw-bundled",
      baseDir: hostSkillBaseDir,
    }),
    disableModelInvocation: false,
  },
  "workspace",
);
const snapshot: SkillSnapshot = {
  prompt: `<available_skills><skill><location>${hostSkillPath}</location></skill></available_skills>`,
  skills: [{ name: "demo" }],
  resolvedSkills: [workspaceSkill],
  discoverySkills: [workspaceSkill],
};
const deliveredPath = (name: string, file = "SKILL.md") =>
  `/workspace/.openclaw/sandbox-skills/skills/${name}/${file}`;

function usagePath(name: string, skillFile = hostSkillPath) {
  return {
    readPath: `/state/sandbox-skills/skills/${name}/SKILL.md`,
    skillFile,
    skillName: name,
    skillSource: "workspace" as const,
  };
}

async function writeSkill(root: string, name: string, metadata: string) {
  const dir = path.join(root, "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\nopenclaw: ${metadata}\n---\n# ${name}\n`,
    "utf8",
  );
  return dir;
}

async function promptFor(runtime: ReturnType<typeof resolveSandboxSkillRuntimeInputs>) {
  const { skillsWorkspaceDir, skillsPromptWorkspaceDir, skillsSnapshot, skillsEligibility } =
    runtime;
  const { shouldLoadSkillEntries, skillEntries } = await resolveEmbeddedRunSkillEntries({
    workspaceDir: skillsWorkspaceDir,
    eligibility: skillsEligibility,
    skillsSnapshot,
    workspaceOnly: runtime.workspaceOnly,
  });
  const entries = mapSandboxSkillEntriesForPrompt({
    entries: shouldLoadSkillEntries ? skillEntries : undefined,
    skillsWorkspaceDir,
    skillsPromptWorkspaceDir,
  });
  const prompt = await resolveSkillsPrompt({
    skillsSnapshot,
    entries,
    workspaceDir: skillsPromptWorkspaceDir,
    eligibility: skillsEligibility,
  });
  return { prompt, skillEntries };
}

function remoteEligibility(platform: string, note: string, hasAnyBin = (_bins: string[]) => false) {
  return { remote: { platforms: [platform], note, hasBin: () => false, hasAnyBin } };
}

describe("resolveSandboxSkillRuntimeInputs", () => {
  it.each([false, true])(
    "uses the anchor without materialized skills (sandbox: %s)",
    (sandboxed) => {
      expect(
        resolveSandboxSkillRuntimeInputs({
          sandbox: sandboxed ? { enabled: true } : undefined,
          skillsAnchorWorkspace: "/workspace",
          skillsSnapshot: snapshot,
        }),
      ).toEqual({
        skillsSnapshot: sandboxed ? undefined : snapshot,
        skillsPromptWorkspaceDir: "/workspace",
        skillsWorkspaceDir: "/workspace",
        workspaceOnly: sandboxed,
      });
    },
  );

  it("maps materialized read paths while preserving original file identities", () => {
    expect(
      resolveSandboxSkillRuntimeInputs({
        sandbox: {
          enabled: true,
          workspaceAccess: "rw",
          containerWorkdir: "/workspace",
          skillsWorkspaceDir: "/state/sandbox-skills",
          skillUsagePaths: [
            {
              readPath: "/state/sandbox-skills/skills/demo/SKILL.md",
              skillFile: "/agent-workspace/skills/demo/SKILL.md",
              skillName: "demo",
              skillSource: "workspace",
            },
          ],
        },
        skillsAnchorWorkspace: "/workspace",
      }).skillUsagePaths,
    ).toEqual([
      {
        readPath: "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md",
        skillFile: "/agent-workspace/skills/demo/SKILL.md",
        skillName: "demo",
        skillSource: "workspace",
      },
    ]);
  });

  it("remaps workspace-hosted explicit references to the delivered sandbox copy", () => {
    const hiddenSkillPath = "/host/skills/hidden/SKILL.md";
    const gatewaySkill = recordSkillFileHost(
      { ...workspaceSkill, name: "gateway-demo" },
      "gateway",
    );
    const runtime = resolveSandboxSkillRuntimeInputs({
      sandbox: {
        enabled: true,
        workspaceAccess: "rw",
        containerWorkdir: "/workspace",
        skillsWorkspaceDir: "/state/sandbox-skills",
        skillUsagePaths: [
          usagePath("demo"),
          usagePath("gateway-demo"),
          usagePath("hidden", hiddenSkillPath),
        ],
      },
      skillsAnchorWorkspace: "/workspace",
      skillsSnapshot: {
        ...snapshot,
        skills: [...snapshot.skills, { name: "hidden" }],
        resolvedSkills: [workspaceSkill, gatewaySkill],
      },
    });

    expect(
      remapSkillReferencePaths(
        `Read workspace-skill://workspace/demo/SKILL.md, ${hostSkillPath}, workspace-skill://workspace/hidden/SKILL.md, workspace-skill://workspace/hidden/references/setup.md, ${hiddenSkillPath}, and /host/skills/hidden/references/setup.md before acting.`,
        runtime.skillUsagePaths,
      ),
    ).toBe(
      `Read ${deliveredPath("demo")}, ${deliveredPath("gateway-demo")}, ${deliveredPath("hidden")}, ${deliveredPath("hidden", "references/setup.md")}, ${deliveredPath("hidden")}, and ${deliveredPath("hidden", "references/setup.md")} before acting.`,
    );
    const selections = [
      ["demo-2", hostSkillPath, "workspace"],
      ["gateway-demo", hostSkillPath, "gateway"],
      ["hidden-2", hiddenSkillPath, "workspace"],
    ] as const;
    expect(
      selections.map(([name, filePath, host]) =>
        remapExplicitSkillSelectionPath(
          recordExplicitSkillSelectionFileHost({ name, path: filePath }, host),
          runtime.skillUsagePaths,
        ),
      ),
    ).toEqual(["demo", "gateway-demo", "hidden"].map((name) => deliveredPath(name)));
  });

  it.each([
    { label: "rebuilds sandbox prompts from materialized skill paths", skillsSnapshot: snapshot },
    {
      label: "keeps audited skills out of an explicitly empty sandbox snapshot",
      skillsSnapshot: { prompt: "", skills: [] },
    },
  ])("$label", async ({ skillsSnapshot }) => {
    const root = temps.make("openclaw-sandbox-skills-");
    const effectiveWorkspace = path.join(root, "workspace");
    const materializedWorkspace = path.join(root, "state", "sandbox-skills");
    const skillDir = await writeSkill(
      materializedWorkspace,
      "demo",
      '{"requires":{"anyBins":["sandboxbin"]}}',
    );
    const skillsEligibility = remoteEligibility("linux", "sandbox", (bins) =>
      bins.includes("sandboxbin"),
    );

    const runtime = resolveSandboxSkillRuntimeInputs({
      sandbox: {
        enabled: true,
        containerWorkdir: "/workspace",
        skillsEligibility,
        skillsWorkspaceDir: materializedWorkspace,
        skillUsagePaths: [{ ...usagePath("demo"), readPath: path.join(skillDir, "SKILL.md") }],
        workspaceAccess: "rw",
      },
      skillsAnchorWorkspace: effectiveWorkspace,
      skillsSnapshot,
    });
    const { prompt, skillEntries } = await promptFor(runtime);

    if (skillsSnapshot === snapshot) {
      expect(prompt).toContain(deliveredPath("demo"));
      const deliveredSkill = runtime.skillsSnapshot?.resolvedSkills?.[0];
      expect(deliveredSkill).toBeDefined();
      if (!deliveredSkill) {
        throw new Error("missing delivered sandbox skill");
      }
      expect(resolveSkillFileHost(deliveredSkill)).toBeUndefined();
    } else {
      expect(prompt).toBe("");
      expect(skillEntries).toEqual([]);
    }
    expect(prompt.replaceAll("\\", "/")).not.toContain(materializedWorkspace.replaceAll("\\", "/"));
    expect(prompt).not.toContain(hostSkillPath);
    expect(prompt).not.toContain("plugin-skills");
    expect(prompt.replaceAll("\\", "/")).not.toContain("/skills/canvas/SKILL.md");
  });

  it("preserves remote eligibility when rebuilding sandbox prompts", async () => {
    const root = temps.make("openclaw-sandbox-skills-");
    await writeSkill(root, "macskill", '{"os":["darwin"]}');
    const skillsEligibility = remoteEligibility("darwin", "remote mac available");

    const { prompt } = await promptFor({
      skillsWorkspaceDir: root,
      skillsPromptWorkspaceDir: root,
      skillsEligibility,
      workspaceOnly: true,
    });

    expect(prompt).toContain("remote mac available");
    expect(prompt).toContain("macskill");
  });
});
