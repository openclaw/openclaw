import { afterEach, expect, it, vi } from "vitest";
import { resolveSkillsPrompt } from "../skills/loading/workspace-skill-prompt.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { resolveCodeModeSkills } from "./code-mode-skills.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCatalogCodeModeHarness,
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";

afterEach(async () => {
  await resetCodeModeTestState();
});

it("reports bounded, redacted installed-skill failures returned by a Gateway", async () => {
  const secret = `ghp_${"a".repeat(36)}`;
  const tools = createInstalledSkillTools([
    {
      name: "demo",
      description: "Demo",
      location: "/skills/demo/SKILL.md",
      source: { filePath: "/skills/demo/SKILL.md" },
    },
  ]);
  tools[0]!.execute = async () => ({
    isError: true,
    content: [{ type: "text", text: "fallback" }],
    details: {
      status: "error",
      error: `Cloud worker transcript requires prepared authority; token=${secret} ${"x".repeat(2_000)}`,
    },
  });
  const h = createCatalogCodeModeHarness(tools);
  const result = await h.complete('return await skills.search("demo", 1);');
  expect(result).toMatchObject({
    status: "failed",
    failurePhase: "bridge",
    code: "internal_error",
    error: expect.stringContaining("Cloud worker transcript requires prepared authority"),
  });
  expect(String(result.error)).not.toContain(secret);
  expect(String(result.error).length).toBeLessThan(1_200);
});

it("reads a known skill with resource context before discovery through the worker bridge", async () => {
  const demo = createFixtureSkillEntry("demo");
  const hidden = createFixtureSkillEntry("hidden");
  const body = "---\nname: demo\n---\n\nRead references/workflow.md before continuing.\n";
  const location = "node://remote/skills/demo/SKILL.md";
  const locationNote = "Run referenced files with exec host=node node=remote.";
  demo.skill.filePath = location;
  demo.skill.locationNote = locationNote;
  const reader = vi.fn(async () => body);
  const codeModeSkills = resolveCodeModeSkills({
    skillsPrompt: await resolveSkillsPrompt({ entries: [demo], workspaceDir: "/workspace" }),
    candidates: [demo.skill, hidden.skill],
  });
  codeModeSkills[0]!.reader = reader;
  const h = createCodeModeHarness({ codeModeSkills });
  applyCodeModeCatalog({
    ...h.ctx,
    tools: [...h.tools, ...createInstalledSkillTools(codeModeSkills)],
  });
  const result = await runUntilCompleted({
    execTool: h.tools[0]!,
    waitTool: h.tools[1]!,
    code: `
    const body = await skills.read("demo");
    const listed = await skills.list();
    const found = await skills.search("demo");
    let unknown;
    try { await skills.read("missing"); } catch (error) { unknown = error.message; }
    return { listed, found, body, unknown };
  `,
  });
  expect(result).toMatchObject({
    status: "completed",
    value: {
      listed: [
        { name: "demo", description: `${demo.skill.description}\n${locationNote}`, location },
      ],
      found: {
        skills: [
          { name: "demo", description: `${demo.skill.description}\n${locationNote}`, location },
        ],
        hasMore: false,
        coverage: { bodyIndexed: 0, metadataOnly: 1, truncatedBodies: 0 },
      },
      body:
        `Skill location: ${location}\n` +
        "Resolve relative resource paths from the directory containing this SKILL.md.\n" +
        `${locationNote}\n\n${body}`,
      unknown:
        'Skill "missing" is not available to this agent. Search the available skills instead.',
    },
  });
  expect(reader).toHaveBeenCalledExactlyOnceWith({
    location,
    signal: expect.any(AbortSignal),
  });
});
