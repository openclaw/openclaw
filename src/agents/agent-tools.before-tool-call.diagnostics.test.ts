import { expect, it } from "vitest";
import { recordSkillFileHost } from "../skills/skill-file-host.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { findSkillUsageMatch } from "./agent-tools.before-tool-call.diagnostics.js";

it("attributes colliding physical and virtual Skill reads to their source hosts", () => {
  const filePath = "/project/skills/guide/SKILL.md";
  const local = createCanonicalFixtureSkill({
    name: "gateway-guide",
    description: "Gateway",
    filePath,
    baseDir: "/project/skills/guide",
    source: "workspace",
  });
  const remote = recordSkillFileHost(
    {
      ...createCanonicalFixtureSkill({
        name: "node-guide",
        description: "Node",
        filePath,
        baseDir: "/project/skills/guide",
        source: "openclaw-node",
      }),
    },
    "workspace",
  );
  const skillsSnapshot = { prompt: "", skills: [], resolvedSkills: [local, remote] };

  expect(
    findSkillUsageMatch({
      toolName: "read",
      toolParams: { path: filePath },
      ctx: { skillsSnapshot },
    }),
  ).toMatchObject({ skillName: "gateway-guide" });
  expect(
    findSkillUsageMatch({
      toolName: "read",
      toolParams: { path: "workspace-skill://workspace/node-guide/SKILL.md" },
      ctx: { skillsSnapshot },
    }),
  ).toMatchObject({ skillName: "node-guide" });
});
