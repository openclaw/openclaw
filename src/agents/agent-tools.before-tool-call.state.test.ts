import path from "node:path";
import {
  createTerminalPresentationContractTool,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import {
  attachToolCallSkillUsage,
  recordToolCallSkillUsage,
  resetAdjustedParamsByToolCallIdForTests,
  type ToolCallSkillUsage,
} from "./agent-tools.before-tool-call.state.js";

afterEach(resetAdjustedParamsByToolCallIdForTests);

it.each([["plain text"], [["first", "second"]]])(
  "leaves non-object details as returned (%j)",
  (details) => {
    recordToolCallSkillUsage("call-1", "run-1", {
      skillName: "demo-skill",
      skillSource: "workspace",
      activation: "read",
    });
    const result = { content: [], details };

    expect(attachToolCallSkillUsage(result, "call-1", "run-1")).toBe(result);
    expect(result.details).toBe(details);
    expect(attachToolCallSkillUsage({ content: [] }, "call-1", "run-1")).toEqual({ content: [] });
  },
);

it("bounds skill use left by reads that finish after their run ended", async () => {
  const runId = "run-ended";
  const skillDir = path.join("/workspace", ".agents", "skills", "demo-skill");
  const toolResult = textToolResult("# Demo", { kind: "text", content: "# Demo" });
  let abortRun = () => {};
  const lateTool = createTerminalPresentationContractTool({
    name: "read",
    result: toolResult,
    format: () => undefined,
  });
  // The tool ignores cancellation: its run ends while it is still executing.
  vi.mocked(lateTool.execute).mockImplementation(async () => {
    abortRun();
    return toolResult;
  });
  const read = wrapToolWithBeforeToolCallHook(lateTool, {
    runId,
    workspaceDir: "/workspace",
    skillsSnapshot: {
      prompt: "",
      skills: [{ name: "demo-skill" }],
      resolvedSkills: [
        createCanonicalFixtureSkill({
          name: "demo-skill",
          description: "Demo",
          filePath: path.join(skillDir, "SKILL.md"),
          baseDir: skillDir,
          source: "workspace",
        }),
      ],
    },
  });
  const skillUsage: ToolCallSkillUsage = {
    skillName: "demo-skill",
    skillSource: "workspace",
    activation: "read",
  };

  // No harness finalizes these calls, so their entries stay until the cap evicts them.
  for (const toolCallId of ["late-a", "late-b"]) {
    const controller = new AbortController();
    abortRun = () => controller.abort();
    await read.execute(
      toolCallId,
      { path: ".agents/skills/demo-skill/SKILL.md" },
      controller.signal,
      undefined,
    );
  }
  expect(attachToolCallSkillUsage(toolResult, "late-b", "run-next")).toBe(toolResult);
  for (let index = 0; index < 1023; index += 1) {
    recordToolCallSkillUsage(`newer-${index}`, "run-newer", skillUsage);
  }
  expect(attachToolCallSkillUsage(toolResult, "late-a", runId)).toBe(toolResult);
  expect(attachToolCallSkillUsage(toolResult, "late-b", runId).details).toEqual({
    kind: "text",
    content: "# Demo",
    openclawSkillUsage: skillUsage,
  });
});
