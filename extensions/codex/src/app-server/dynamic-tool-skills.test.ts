import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderCodexSkillsInstructions } from "./attempt-context.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

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
  "delivers bounded skill pages or refuses %s reads",
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
      let cursor: string | undefined;
      let reconstructed = "";
      do {
        const read = await call("skills_read", {
          name: "release-guide",
          ...(cursor ? { cursor } : {}),
        });
        expect(read.success).toBe(true);
        const text = read.contentItems.find((item) => item.type === "inputText")!;
        if (text.type !== "inputText") {
          throw new Error("Missing skill page");
        }
        expect(text.text).not.toContain("truncated dynamic tool result");
        const match = /\n\n\[Skill page (\d+):(\d+)\/(\d+); nextCursor=(null|"[^"]+")\./u.exec(
          text.text,
        )!;
        reconstructed += text.text.slice(text.text.indexOf("\n\n") + 2, match.index);
        cursor = JSON.parse(match[4]!) ?? undefined;
      } while (cursor);
      expect(reconstructed).toBe(skill.readContent);
    }
  },
);
