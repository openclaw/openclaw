import { afterEach, expect, it, onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSkillsPrompt } from "../skills/loading/workspace-skill-prompt.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveCodeModeSkills } from "./code-mode-skills.js";
import {
  applyCodeModeCatalog,
  buildCodeModeCatalogPrompt,
  createCodeModeTools,
} from "./code-mode.js";
import { createCatalogCodeModeHarness, resetCodeModeTestState } from "./code-mode.test-support.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search-catalog.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetCodeModeTestState);

it("reports bounded, redacted installed-skill failures returned by a Gateway", async () => {
  const secret = `ghp_${"a".repeat(36)}`;
  const tool = createStubTool("skills_search");
  tool.execute = async () => ({
    isError: true,
    content: [{ type: "text", text: "fallback" }],
    details: {
      status: "error",
      error: `Cloud worker transcript requires prepared authority; token=${secret} ${"x".repeat(2_000)}`,
    },
  });
  const h = createCatalogCodeModeHarness([tool]);
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
  const codeModeSkills = resolveCodeModeSkills({
    skillsPrompt: await resolveSkillsPrompt({ entries: [demo], workspaceDir: "/workspace" }),
    candidates: [demo.skill, hidden.skill],
  });
  codeModeSkills[0]!.reader = async () => body;
  const h = createCatalogCodeModeHarness(createInstalledSkillTools(codeModeSkills), {
    codeModeSkills,
  });
  const result = await h.complete(`
    const body = await skills.read("demo");
    const listed = await skills.list();
    return { listed, body };
  `);
  const metadata = {
    name: "demo",
    description: `${demo.skill.description}\n${locationNote}`,
    location,
  };
  expect(result).toMatchObject({
    status: "completed",
    value: {
      listed: [metadata],
      body:
        `Skill location: ${location}\n` +
        "Resolve relative resource paths from the directory containing this SKILL.md.\n" +
        `${locationNote}\n\n${body}`,
    },
  });
});

it("keeps tool schemas stable across run catalogs", () => {
  const config: OpenClawConfig = { tools: { codeMode: true } };
  const serializeRun = (runId: string, targetName: string) => {
    const catalogRef = createToolSearchCatalogRef();
    const ctx = { config, catalogRef, sessionKey: "agent:main:cache-proof", runId };
    onTestFinished(() => clearToolSearchCatalog(ctx));
    const { tools } = applyCodeModeCatalog({
      ...ctx,
      tools: [...createCodeModeTools(ctx), createStubTool(targetName)],
    });
    return JSON.stringify(
      tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    );
  };
  expect(serializeRun("second", "lookup")).toBe(serializeRun("first", "exec"));
});

it("keeps core signatures visible when the catalog overflows", () => {
  const targets = createOpenClawCodingTools({
    config: { tools: { codeMode: true, exec: { mode: "full" } } },
    workspaceDir: tempDirs.make("code-mode-catalog-index-"),
    wrapBeforeToolCallHook: false,
    toolConstructionPlan: {
      includeBaseCodingTools: true,
      includeShellTools: true,
      includeChannelTools: false,
      includeOpenClawTools: false,
      includePluginTools: false,
    },
  });
  targets.push(
    ...Array.from({ length: 100 }, (_, i) => createStubTool(`extra_${i}_${"x".repeat(100)}`)),
  );
  const { ctx, catalogRef, tools: controls } = createCatalogCodeModeHarness(targets);
  const render = () => buildCodeModeCatalogPrompt(ctx, catalogRef.current?.entries ?? []);
  onTestFinished(() => clearToolSearchCatalog(ctx));
  const description = render();
  const index = description.slice(description.indexOf("Enabled async tool globals"));
  expect(index).toContain("additional tools omitted");
  expect(index.length).toBeLessThanOrEqual(8_000);
  const lines = index.split("\n");
  const shell = lines.find((line) => line.startsWith("- exec "));
  expect(shell).toContain("command: string");
  expect(shell).toContain("workdir?: string");
  expect(shell).toContain("timeoutSeconds?: number");
  expect(shell).not.toMatch(/\b(cwd|timeout)\??:/);
  const process = lines.find((line) => line.startsWith("- process "));
  expect(process).toContain("sessionId?: string");
  expect(process).toContain("timeout?: number");
  expect(process).not.toContain("timeoutMs");
  expect(lines.some((line) => line.startsWith("- read "))).toBe(true);
  applyCodeModeCatalog({ ...ctx, tools: [...controls, ...targets.toReversed()] });
  expect(render()).toBe(description);
});
