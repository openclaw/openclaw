import "./dynamic-tool-build.test-support.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderCodexSkillsInstructions } from "./attempt-context.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  cleanupDynamicToolBuildFixture,
  createCodexRuntimePlanFixture,
  createParams,
  hoisted,
} = await import("./dynamic-tool-build.test-support.js");

let tempDir: string;
const hostCapabilityClosers: Array<() => void> = [];

beforeEach(async () => {
  hoisted.loadNodeExecAvailability.mockResolvedValue({
    cacheKey: "eligible",
    isAvailable: () => true,
  });
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-skills-"));
});

afterEach(async () => {
  await cleanupDynamicToolBuildFixture(tempDir, hostCapabilityClosers);
});

describe("Codex installed skills", () => {
  it.each([
    { denied: false, oversized: false },
    { denied: true, oversized: false },
    { denied: false, oversized: true },
  ])("delivers whole host instructions or refuses the read (%j)", async ({ denied, oversized }) => {
    const workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const params = createParams(path.join(tempDir, "skills-session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.config = {
      plugins: { enabled: false },
      tools: denied ? { deny: ["skills_search", "skills_read"] } : {},
    };
    const skill = {
      name: "release-guide",
      description: "Publish software releases",
      filePath: path.join(workspaceDir, "skills/release-guide/SKILL.md"),
      baseDir: path.join(workspaceDir, "skills/release-guide"),
      source: "test",
      sourceInfo: {
        source: "test",
        scope: "temporary" as const,
        origin: "top-level" as const,
        path: "/skills/release-guide/SKILL.md",
      },
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
      skillsPrompt: "",
      dynamicTools: bridge.availableSpecs,
    });
    if (denied) {
      expect(guidance).toBeUndefined();
    } else {
      expect(guidance).toContain("skills_search");
      expect(guidance).toContain("skills_read");
      expect(guidance).not.toContain("skills.read(");
    }
    const result = await bridge.handleToolCall({
      threadId: "thread-skills",
      turnId: "turn-skills",
      callId: "search-skills",
      tool: "skills_search",
      arguments: { query: "publish release" },
    });
    expect(result.success).toBe(!denied);
    if (!denied) {
      expect(JSON.stringify(result)).toContain("release-guide");
      const read = await bridge.handleToolCall({
        threadId: "thread-skills",
        turnId: "turn-skills",
        callId: "read-skills",
        tool: "skills_read",
        arguments: { name: "release-guide" },
      });
      expect(read.success).toBe(!oversized);
      if (oversized) {
        expect(read.diagnosticTerminalType).toBe("error");
        expect(JSON.stringify(read.contentItems)).toContain("cannot deliver the whole skill");
        expect(JSON.stringify(read.contentItems)).not.toContain("Complete instructions.");
      } else {
        expect(read.contentItems).toEqual([{ type: "inputText", text: skill.readContent }]);
      }
    }
  });
});
