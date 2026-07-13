// Sandbox skill input tests cover snapshot suppression and synced skill workspace selection.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../../skills/loading/skill-contract.js";
import { resolveSkillsPromptForRun } from "../../skills/loading/workspace.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import type { SkillSnapshot } from "../../skills/types.js";
import {
  mapSandboxSkillEntriesForPrompt,
  mapSandboxSkillUsagePaths,
  resolveSandboxSkillRuntimeInputs,
} from "./sandbox-skills.js";

const hostSkillPath = "/usr/lib/node_modules/openclaw/skills/demo/SKILL.md";
const hostSkillBaseDir = "/usr/lib/node_modules/openclaw/skills/demo";
const snapshot: SkillSnapshot = {
  prompt:
    "<available_skills><skill><location>/usr/lib/node_modules/openclaw/skills/demo/SKILL.md</location></skill></available_skills>",
  skills: [{ name: "demo" }],
  resolvedSkills: [
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
  ],
};

describe("resolveSandboxSkillRuntimeInputs", () => {
  it("keeps snapshots for non-sandboxed runs", () => {
    expect(
      resolveSandboxSkillRuntimeInputs({
        effectiveWorkspace: "/workspace",
        skillsSnapshot: snapshot,
      }),
    ).toEqual({
      skillsSnapshot: snapshot,
      skillsPromptWorkspaceDir: "/workspace",
      skillsWorkspaceDir: "/workspace",
      workspaceOnly: false,
    });
  });

  it("uses the materialized skills workspace and drops host-path snapshots for sandboxes", () => {
    const skillsEligibility = {
      remote: {
        platforms: ["linux"],
        hasBin: () => true,
        hasAnyBin: () => true,
        note: "sandbox",
      },
    };

    expect(
      resolveSandboxSkillRuntimeInputs({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsEligibility,
          skillsWorkspaceDir: "/state/sandbox-skills",
          workspaceAccess: "rw",
        },
        effectiveWorkspace: "/workspace",
        skillsSnapshot: snapshot,
      }),
    ).toEqual({
      skillsEligibility,
      skillsSnapshot: undefined,
      skillsPromptWorkspaceDir: "/workspace/.openclaw/sandbox-skills",
      skillsWorkspaceDir: "/state/sandbox-skills",
      workspaceOnly: true,
    });
  });

  it("drops host snapshot and builds name-only prompt when skipSkillsSync is enabled", () => {
    expect(
      resolveSandboxSkillRuntimeInputs({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsWorkspaceDir: "/state/sandbox-skills",
          workspaceAccess: "ro",
          skipSkillsSync: true,
        },
        effectiveWorkspace: "/workspace",
        skillsSnapshot: snapshot,
      }),
    ).toEqual({
      skillsPromptWorkspaceDir: "/workspace",
      skillsSnapshot: {
        prompt:
          "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
        skills: [{ name: "demo" }],
      },
      skillsWorkspaceDir: "/state/sandbox-skills",
      workspaceOnly: true,
    });
  });

  it("drops host snapshot (no remapping) when skipSkillsSync is absent", () => {
    expect(
      resolveSandboxSkillRuntimeInputs({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsWorkspaceDir: "/state/sandbox-skills",
          workspaceAccess: "ro",
        },
        effectiveWorkspace: "/workspace",
        skillsSnapshot: snapshot,
      }),
    ).toEqual({
      skillsSnapshot: undefined,
      skillsPromptWorkspaceDir: "/workspace",
      skillsWorkspaceDir: "/state/sandbox-skills",
      workspaceOnly: true,
    });
  });

  it("falls back to the effective workspace for older sandbox contexts", () => {
    expect(
      resolveSandboxSkillRuntimeInputs({
        sandbox: { enabled: true },
        effectiveWorkspace: "/workspace",
        skillsSnapshot: snapshot,
      }),
    ).toEqual({
      skillsSnapshot: undefined,
      skillsPromptWorkspaceDir: "/workspace",
      skillsWorkspaceDir: "/workspace",
      workspaceOnly: true,
    });
  });

  it("maps materialized read paths while preserving original file identities", () => {
    expect(
      mapSandboxSkillUsagePaths({
        paths: [
          {
            readPath: "/state/sandbox-skills/skills/demo/SKILL.md",
            skillFile: "/agent-workspace/skills/demo/SKILL.md",
            skillName: "demo",
            skillSource: "workspace",
          },
        ],
        skillsWorkspaceDir: "/state/sandbox-skills",
        skillsPromptWorkspaceDir: "/workspace/.openclaw/sandbox-skills",
      }),
    ).toEqual([
      {
        readPath: "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md",
        skillFile: "/agent-workspace/skills/demo/SKILL.md",
        skillName: "demo",
        skillSource: "workspace",
      },
    ]);
  });

  it("rebuilds sandbox prompts from materialized skill paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-skills-"));
    try {
      const effectiveWorkspace = path.join(root, "workspace");
      const materializedWorkspace = path.join(root, "state", "sandbox-skills");
      const skillDir = path.join(materializedWorkspace, "skills", "demo");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: demo",
          "description: Demo skill",
          'openclaw: {"requires":{"anyBins":["sandboxbin"]}}',
          "---",
          "# Demo",
          "",
        ].join("\n"),
        "utf8",
      );
      const skillsEligibility = {
        remote: {
          platforms: ["linux"],
          hasBin: () => false,
          hasAnyBin: (bins: string[]) => bins.includes("sandboxbin"),
          note: "sandbox",
        },
      };

      const {
        skillsEligibility: skillsEligibilityForRun,
        skillsPromptWorkspaceDir,
        skillsSnapshot: skillsSnapshotForRun,
        skillsWorkspaceDir,
        workspaceOnly,
      } = resolveSandboxSkillRuntimeInputs({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsEligibility,
          skillsWorkspaceDir: materializedWorkspace,
          workspaceAccess: "rw",
        },
        effectiveWorkspace,
        skillsSnapshot: snapshot,
      });
      const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
        workspaceDir: skillsWorkspaceDir,
        eligibility: skillsEligibilityForRun,
        skillsSnapshot: skillsSnapshotForRun,
        workspaceOnly,
      });
      const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
        entries: shouldLoadSkillEntries ? skillEntries : undefined,
        skillsWorkspaceDir,
        skillsPromptWorkspaceDir,
      });
      const prompt = resolveSkillsPromptForRun({
        skillsSnapshot: skillsSnapshotForRun,
        entries: promptSkillEntries,
        workspaceDir: skillsPromptWorkspaceDir,
        eligibility: skillsEligibilityForRun,
      });

      expect(prompt).toContain("/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md");
      expect(prompt.replaceAll("\\", "/")).not.toContain(
        materializedWorkspace.replaceAll("\\", "/"),
      );
      expect(prompt).not.toContain(hostSkillPath);
      expect(prompt).not.toContain("plugin-skills");
      expect(prompt.replaceAll("\\", "/")).not.toContain("/skills/canvas/SKILL.md");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves remote eligibility when rebuilding sandbox prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-skills-"));
    try {
      const skillDir = path.join(root, "skills", "macskill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: macskill",
          "description: Mac-only remote skill",
          'openclaw: {"os":["darwin"]}',
          "---",
          "# Mac Skill",
          "",
        ].join("\n"),
        "utf8",
      );
      const skillsEligibility = {
        remote: {
          platforms: ["darwin"],
          hasBin: () => false,
          hasAnyBin: () => false,
          note: "remote mac available",
        },
      };

      const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
        workspaceDir: root,
        eligibility: skillsEligibility,
        workspaceOnly: true,
      });
      const prompt = resolveSkillsPromptForRun({
        entries: shouldLoadSkillEntries ? skillEntries : undefined,
        workspaceDir: root,
        eligibility: skillsEligibility,
      });

      expect(prompt).toContain("remote mac available");
      expect(prompt).toContain("macskill");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("escapes XML-special characters in skill names when skipSkillsSync is enabled", () => {
    const xmlSnapshot: SkillSnapshot = {
      prompt: "",
      skills: [{ name: 'a&b<evil>"test"' }],
      resolvedSkills: [
        {
          name: 'a&b<evil>"test"',
          description: "XML special chars skill",
          filePath: "/usr/lib/skills/test/SKILL.md",
          baseDir: "/usr/lib/skills/test",
          source: "openclaw-bundled",
          sourceInfo: createSyntheticSourceInfo("/usr/lib/skills/test/SKILL.md", {
            source: "openclaw-bundled",
            baseDir: "/usr/lib/skills/test",
          }),
          disableModelInvocation: false,
        },
      ],
    };
    expect(
      resolveSandboxSkillRuntimeInputs({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsWorkspaceDir: "/state/sandbox-skills",
          workspaceAccess: "ro",
          skipSkillsSync: true,
        },
        effectiveWorkspace: "/workspace",
        skillsSnapshot: xmlSnapshot,
      }),
    ).toEqual({
      skillsSnapshot: {
        prompt:
          "<available_skills>\n  <skill>\n    <name>a&amp;b&lt;evil&gt;&quot;test&quot;</name>\n  </skill>\n</available_skills>",
        skills: [{ name: 'a&b<evil>"test"' }],
      },
      skillsPromptWorkspaceDir: "/workspace",
      skillsWorkspaceDir: "/state/sandbox-skills",
      workspaceOnly: true,
    });
  });

  it("respects char limit when building name-only prompt with many skills", () => {
    const manySkills: SkillSnapshot = {
      prompt: "",
      skills: Array.from({ length: 20 }, (_, i) => ({ name: `skill-${i}` })),
      resolvedSkills: Array.from({ length: 20 }, (_, i) => ({
        name: `skill-${i}`,
        description: `skill ${i}`,
        filePath: `/usr/lib/skills/skill-${i}/SKILL.md`,
        baseDir: `/usr/lib/skills/skill-${i}`,
        source: "openclaw-bundled" as const,
        sourceInfo: createSyntheticSourceInfo(`/usr/lib/skills/skill-${i}/SKILL.md`, {
          source: "openclaw-bundled" as const,
          baseDir: `/usr/lib/skills/skill-${i}`,
        }),
        disableModelInvocation: false,
      })),
    };
    const result = resolveSandboxSkillRuntimeInputs({
      sandbox: {
        enabled: true,
        containerWorkdir: "/workspace",
        skillsWorkspaceDir: "/state/sandbox-skills",
        workspaceAccess: "ro",
        skipSkillsSync: true,
      },
      effectiveWorkspace: "/workspace",
      skillsSnapshot: manySkills,
    });
    const prompt = result.skillsSnapshot!.prompt;
    // All 20 skills fit well within 18000 chars, so they should all appear
    expect(prompt).toContain("<name>skill-0</name>");
    expect(prompt).toContain("<name>skill-19</name>");
    expect(prompt.length).toBeLessThan(18_000);
    expect(result.skillsSnapshot!.skills).toHaveLength(20);
  });

  it("truncates name-only prompt when skills exceed MAX_SKILLS_PROMPT_CHARS", () => {
    // Each skill name is ~1000 chars, so 20 skills would exceed the 18000 limit
    const longName = "x".repeat(1000);
    const tooMany: SkillSnapshot = {
      prompt: "",
      skills: Array.from({ length: 20 }, (_, i) => ({ name: `${longName}-${i}` })),
      resolvedSkills: Array.from({ length: 20 }, (_, i) => ({
        name: `${longName}-${i}`,
        description: `long skill ${i}`,
        filePath: `/usr/lib/skills/long-${i}/SKILL.md`,
        baseDir: `/usr/lib/skills/long-${i}`,
        source: "openclaw-bundled" as const,
        sourceInfo: createSyntheticSourceInfo(`/usr/lib/skills/long-${i}/SKILL.md`, {
          source: "openclaw-bundled" as const,
          baseDir: `/usr/lib/skills/long-${i}`,
        }),
        disableModelInvocation: false,
      })),
    };
    const result = resolveSandboxSkillRuntimeInputs({
      sandbox: {
        enabled: true,
        containerWorkdir: "/workspace",
        skillsWorkspaceDir: "/state/sandbox-skills",
        workspaceAccess: "ro",
        skipSkillsSync: true,
      },
      effectiveWorkspace: "/workspace",
      skillsSnapshot: tooMany,
    });
    const prompt = result.skillsSnapshot!.prompt;
    // The prompt should include some skills but be truncated below the limit
    expect(prompt.length).toBeLessThanOrEqual(18_000);
    // First skill should still be present
    expect(prompt).toContain("<name>");
  });

  it("preserves remote eligibility note in skip-mode name-only prompt", () => {
    const remoteNote = "remote mac available via exec";
    const eligSnapshot: SkillSnapshot = {
      prompt: "",
      skills: [{ name: "macskill" }],
      resolvedSkills: [
        {
          name: "macskill",
          description: "Mac-only skill",
          filePath: "/usr/lib/skills/mac/SKILL.md",
          baseDir: "/usr/lib/skills/mac",
          source: "openclaw-bundled",
          sourceInfo: createSyntheticSourceInfo("/usr/lib/skills/mac/SKILL.md", {
            source: "openclaw-bundled",
            baseDir: "/usr/lib/skills/mac",
          }),
          disableModelInvocation: false,
        },
      ],
    };
    const result = resolveSandboxSkillRuntimeInputs({
      sandbox: {
        enabled: true,
        containerWorkdir: "/workspace",
        skillsWorkspaceDir: "/state/sandbox-skills",
        workspaceAccess: "ro",
        skipSkillsSync: true,
        skillsEligibility: {
          remote: {
            platforms: ["darwin"],
            hasBin: () => false,
            hasAnyBin: () => false,
            note: remoteNote,
          },
        },
      },
      effectiveWorkspace: "/workspace",
      skillsSnapshot: eligSnapshot,
    });
    const prompt = result.skillsSnapshot!.prompt;
    expect(prompt).toContain(remoteNote);
    expect(prompt).toContain("<name>macskill</name>");
  });
});
