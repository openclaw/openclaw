import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSkillsPrompt } from "../skills/loading/workspace-skill-prompt.js";
import {
  createCanonicalFixtureSkill,
  createFixtureSkillEntry,
} from "../skills/test-support/test-helpers.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveCodeModeSkills } from "./code-mode-skills.js";
import {
  applyCodeModeCatalog,
  buildCodeModeCatalogPrompt,
  createCodeModeTools,
} from "./code-mode.js";
import { createCatalogCodeModeHarness, resetCodeModeTestState } from "./code-mode.test-support.js";
import { bindHostSkillCatalog } from "./harness/host-skills.js";
import { prepareInstalledSkillCatalog } from "./installed-skill-runtime.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search-catalog.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";
import { registerAgentWorkspaceAccess } from "./workspace-access.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetCodeModeTestState);

it("reads local skill companions through the worker without exposing escaped, binary or oversized files", async () => {
  const dir = tempDirs.make("code-mode-skill-resources-");
  const root = path.join(dir, "guide");
  await fs.mkdir(path.join(root, "references"), { recursive: true });
  const filePath = path.join(root, "SKILL.md");
  await fs.writeFile(filePath, "Read references/workflow.md.");
  await fs.writeFile(path.join(root, "references/workflow.md"), "Companion text 😀");
  await fs.writeFile(path.join(dir, "outside.md"), "Outside marker");
  await fs.symlink(path.join(dir, "outside.md"), path.join(root, "escape.md"));
  await fs.symlink(dir, path.join(root, "escape-dir"), "dir");
  await fs.link(path.join(dir, "outside.md"), path.join(root, "hardlink.md"));
  await fs.writeFile(path.join(root, "large.md"), "x".repeat(256 * 1024 + 1));
  await fs.writeFile(path.join(root, "binary"), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, "invalid-utf8"), Buffer.from([0xff]));
  const skill = createCanonicalFixtureSkill({
    name: "guide",
    description: "Guide",
    filePath,
    baseDir: root,
    source: "bundled",
  });
  const snapshot = {
    prompt: await resolveSkillsPrompt({
      workspaceDir: dir,
      entries: [{ skill, frontmatter: {} }],
    }),
    skills: [{ name: "guide" }],
    discoverySkills: [skill],
  };
  let active = true;
  const catalog = prepareInstalledSkillCatalog({
    snapshot,
    workspaceDir: dir,
    assertCurrent() {
      if (!active) {
        throw new Error("Run retired");
      }
    },
  });
  const tools = createInstalledSkillTools(catalog);
  const h = createCatalogCodeModeHarness(tools, { codeModeSkills: catalog });
  const prompt = buildAgentSystemPrompt({
    workspaceDir: dir,
    codeModeActive: true,
    toolNames: ["exec", "wait"],
    capabilityToolNames: tools.map((tool) => tool.name),
    skillsPrompt: snapshot.prompt,
  });
  expect(prompt).not.toContain("<available_skills>");
  const result = await h.complete(`
    const found = await skills.search("guide");
    const whole = await skills.read("guide");
    const companion = await skills.read("guide", "references/workflow.md");
    const denied = [];
    for (const relativePath of ${JSON.stringify([
      "../outside.md",
      "references/../../outside.md",
      "escape.md",
      "escape-dir/outside.md",
      "hardlink.md",
      "large.md",
      "binary",
      "invalid-utf8",
      "references",
      "missing.md",
      filePath,
      "C:/SKILL.md",
      "C:SKILL.md",
      "references\\workflow.md",
      "~/SKILL.md",
      "",
    ])}) {
      try { await skills.read("guide", relativePath); denied.push(false); }
      catch { denied.push(true); }
    }
    return { found, whole, companion, denied };
  `);
  expect(result).toMatchObject({
    status: "completed",
    value: {
      found: { skills: [{ name: "guide" }] },
      whole: expect.stringContaining("Read references/workflow.md."),
      companion: "Companion text 😀",
      denied: Array(16).fill(true),
    },
  });
  const read = tools.find((tool) => tool.name === "skills_read")!;
  expect(
    (await read.execute("native", { name: "guide", relativePath: "references/workflow.md" }))
      .content,
  ).toEqual([{ type: "text", text: "Companion text 😀" }]);
  const resourceRoot = (await catalog[0]!.resourceRoot)!;
  const readFile = resourceRoot.read.bind(resourceRoot);
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const spy = vi.spyOn(resourceRoot, "read").mockImplementationOnce(async (...args) => {
      const opened = await readFile(...args);
      if (cancel) {
        controller.abort();
      } else {
        active = false;
      }
      return opened;
    });
    onTestFinished(() => spy.mockRestore());
    await expect(
      read.execute(
        "revoked",
        { name: "guide", relativePath: "references/workflow.md" },
        controller.signal,
      ),
    ).rejects.toThrow();
    spy.mockRestore();
    active = true;
  }
  await fs.rename(root, `${root}-old`);
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "SKILL.md"), "Replacement marker");
  expect(await h.complete('return await skills.read("guide", "SKILL.md");')).toMatchObject({
    status: "failed",
  });
});

it("keeps restricted placements instruction-only for companion requests", async () => {
  const dir = tempDirs.make("skill-resource-placement-");
  const filePath = path.join(dir, "SKILL.md");
  await fs.writeFile(filePath, "Instructions");
  await fs.writeFile(path.join(dir, "companion.md"), "Host marker");
  const local = createCanonicalFixtureSkill({
    name: "guide",
    description: "Guide",
    filePath,
    baseDir: dir,
    source: "bundled",
  });
  const snapshot = { prompt: "", skills: [{ name: "guide" }], discoverySkills: [local] };
  const catalogs = [
    prepareInstalledSkillCatalog({
      snapshot: { ...snapshot, discoverySkills: [{ ...local, fileHost: "workspace" }] },
      workspaceDir: dir,
    }),
    prepareInstalledSkillCatalog({
      snapshot: {
        ...snapshot,
        discoverySkills: [{ ...local, filePath: "node://remote/SKILL.md" }],
      },
      workspaceDir: dir,
    }),
    prepareInstalledSkillCatalog({
      snapshot,
      workspaceDir: dir,
      sandbox: createSandboxTestContext(),
    }),
    bindHostSkillCatalog({
      snapshot,
      workspaceDir: dir,
      requiredRoot: dir,
      readable: true,
      assertCurrent() {},
    })(),
  ];
  onTestFinished(
    registerAgentWorkspaceAccess(dir, {
      loadSkills: vi.fn(),
      bridge: {
        readFile: vi.fn(),
        readFileWithSource: vi.fn(),
        readDirectory: vi.fn(),
        writeFile: vi.fn(),
        createFileExclusive: vi.fn(),
        stat: vi.fn(),
      },
    }),
  );
  for (const remoteSnapshot of [
    snapshot,
    {
      ...snapshot,
      librarySelections: [
        { name: "guide", skillId: "guide-id", revision: "revision", ownerProfileId: null },
      ],
    },
  ]) {
    catalogs.push(prepareInstalledSkillCatalog({ snapshot: remoteSnapshot, workspaceDir: dir }));
  }
  for (const catalog of catalogs) {
    const read = createInstalledSkillTools(catalog).find((tool) => tool.name === "skills_read")!;
    await expect(
      read.execute("restricted", { name: "guide", relativePath: "companion.md" }),
    ).rejects.toThrow("instruction-only");
  }
});

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
