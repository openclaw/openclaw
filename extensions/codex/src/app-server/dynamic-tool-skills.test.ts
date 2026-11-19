import "./dynamic-tool-build.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderCodexSkillsInstructions } from "./attempt-context.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { resolveGatewayOnlySkillDirs } from "./gateway-only-skills.js";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  cleanupDynamicToolBuildFixture,
  createCodexRuntimePlanFixture,
  createParams,
  setupDynamicToolBuildFixture,
} = await import("./dynamic-tool-build.test-support.js");

let tempDir: string;
const hostCapabilityClosers: Array<() => void> = [];

beforeEach(async () => {
  tempDir = await setupDynamicToolBuildFixture();
});

afterEach(() => cleanupDynamicToolBuildFixture(tempDir, hostCapabilityClosers));

it.each(["allowed", "denied", "oversized"])(
  "preserves the %s skill-read result through the dynamic tool bridge",
  async (mode) => {
    const denied = mode === "denied";
    const oversized = mode === "oversized";
    const workspaceDir = tempDir;
    const params = createParams(path.join(tempDir, "skills-session.jsonl"), workspaceDir, {
      runtimePlan: createCodexRuntimePlanFixture(),
      config: {
        plugins: { enabled: false },
        tools: denied ? { deny: ["skills_search", "skills_read"] } : {},
      },
    });
    const skill = {
      name: "release-guide",
      description: "Publish software releases",
      filePath: path.join(workspaceDir, "skills/release-guide/SKILL.md"),
      baseDir: path.join(workspaceDir, "skills/release-guide"),
      source: "test",
      sourceInfo: { source: "test", scope: "temporary", origin: "top-level", path: "/s" } as const,
      disableModelInvocation: false,
      readContent: oversized
        ? `# Release\n\n${"Complete instructions. ".repeat(5_000)}\nEND OF SKILL`
        : "# Release\n\nComplete instructions.\n",
    };
    params.skillsSnapshot = {
      prompt: "",
      skills: [{ name: skill.name, skillKey: skill.name }],
      resolvedSkills: [],
      discoverySkills: [skill],
    };
    await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
    const tools = await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null });
    const bridge = createCodexDynamicToolBridge({
      tools,
      signal: new AbortController().signal,
      loading: "direct",
      hookContext: { sessionKey: params.sessionKey, runId: params.runId, workspaceDir },
    });
    const guidance = renderCodexSkillsInstructions({
      attempt: params,
      dynamicTools: bridge.availableSpecs,
    });
    const call = (tool: string, arguments_: Record<string, string>) =>
      bridge.handleToolCall({
        threadId: "thread-skills",
        turnId: "turn-skills",
        callId: tool === "skills_read" ? "read-skills" : "search-skills",
        tool,
        arguments: arguments_,
      });
    if (denied) {
      expect(guidance).toBeUndefined();
    } else {
      expect(guidance).toContain("skills_search");
      expect(guidance).toContain("skills_read");
      expect(guidance).not.toContain("skills.read(");
    }
    const result = await call("skills_search", { query: "publish release" });
    expect(result.success).toBe(!denied);
    if (!denied) {
      expect(JSON.stringify(result)).toContain("release-guide");
      const read = await call("skills_read", { name: "release-guide" });
      expect(read.success).toBe(true);
      if (oversized) {
        expect(read.diagnosticTerminalType).toBe("completed");
        const text = JSON.stringify(read.contentItems);
        expect(text).toContain("Skill instructions incomplete:");
        expect(text).toContain("read the rest");
        expect(text).not.toContain("END OF SKILL");
      } else {
        const text = `Skill location: ${skill.filePath}\nResolve relative resource paths from the directory containing this SKILL.md.\n\n${skill.readContent}`;
        expect(read.contentItems).toEqual([{ type: "inputText", text }]);
      }
    }
  },
);

it.each([
  { label: "remote with a supporting file", remote: true, companion: true },
  { label: "remote, instructions only", remote: true, companion: false },
  { label: "local", remote: false, companion: true },
  { label: "remote, another copy recorded", remote: true, companion: true, elsewhere: true },
])("keeps Gateway-only library paths out of skill results: $label", async (mode) => {
  const baseDir = path.join(tempDir, "skill-library", "id-1", "revisions", "rev-1");
  await fs.mkdir(baseDir, { recursive: true });
  if (mode.companion) {
    await fs.writeFile(path.join(baseDir, "run.sh"), "echo release\n");
  }
  const source = "openclaw-library";
  const skill = {
    name: "release-guide",
    description: "Publish software releases",
    source,
    baseDir,
    filePath: path.join(baseDir, "SKILL.md"),
    sourceInfo: { source, scope: "temporary", origin: "top-level", path: baseDir } as const,
    disableModelInvocation: false,
    readContent: "# Release\n\nRun run.sh.\n",
  };
  const params = createParams(path.join(tempDir, "skills-session.jsonl"), tempDir, {
    runtimePlan: createCodexRuntimePlanFixture(),
    config: { plugins: { enabled: false }, tools: {} },
  });
  params.skillsSnapshot = {
    prompt: "",
    skills: [{ name: skill.name, skillKey: skill.name }],
    discoverySkills: [skill],
  };
  await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
  const remoteWorkspaceRoot = mode.remote ? "/remote" : undefined;
  const bridge = createCodexDynamicToolBridge({
    tools: await buildDynamicToolsForTest(params, tempDir, { sandbox: null }),
    signal: new AbortController().signal,
    loading: "direct",
    hookContext: {
      sessionKey: params.sessionKey,
      runId: params.runId,
      workspaceDir: tempDir,
      remoteWorkspaceRoot,
      gatewayOnlySkillDirs: resolveGatewayOnlySkillDirs(
        [mode.elsewhere ? { ...skill, filePath: path.join(tempDir, "other", "SKILL.md") } : skill],
        remoteWorkspaceRoot,
      ),
    },
  });
  const call = (tool: string, arguments_: Record<string, string>) =>
    bridge.handleToolCall({
      threadId: "t",
      turnId: "u",
      callId: tool,
      tool,
      arguments: arguments_,
    });

  const read = await call("skills_read", { name: skill.name });
  const search = JSON.stringify((await call("skills_search", { query: "release" })).contentItems);

  const location = `Skill location: ${skill.filePath}\nResolve relative resource paths from the directory containing this SKILL.md.\n\n`;
  const note =
    "Its supporting files are stored on the Gateway and cannot be opened from this machine.\n\n";
  const stripped = mode.remote && !mode.elsewhere;
  const prefix = stripped ? (mode.companion ? note : "") : location;
  expect(read.contentItems).toEqual([{ type: "inputText", text: prefix + skill.readContent }]);
  expect(search).toContain(skill.name);
  expect(search.includes(skill.filePath)).toBe(!stripped);
});
