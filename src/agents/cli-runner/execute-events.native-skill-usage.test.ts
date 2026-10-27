// Claude CLI loads OpenClaw skills through its own Skill tool, outside the OpenClaw
// tool wrapper. The run receipt and skill.used event must still name the canonical SKILL.md.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as flushDiagnosticEvents } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  type DiagnosticSkillUsedEvent,
} from "../../infra/diagnostic-events.js";
import { consumeRunSkillUsage } from "../../skills/runtime/run-usage.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { createCliJsonlStreamingParser } from "../cli-output-stream.js";
import { canonicalizePath } from "../utils/paths.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";
import { createCliEventHandlers } from "./execute-events.js";
import { buildContext, buildToolTracking } from "./execute-events.tool-result-args.test-support.js";

// Record shapes captured from Claude Code 2.1.310 stream-json output.
function skillToolUse(id: string, skill: string) {
  return `${JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Skill", input: { skill } }],
    },
  })}\n`;
}

function skillToolResult(id: string, skill: string, isError = false) {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: isError ? `Unknown skill: ${skill}` : `Launching skill: ${skill}`,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
    tool_use_result: isError ? undefined : { success: true, commandName: skill },
  })}\n`;
}

async function prepareRun(runId: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-skill-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const skillDir = path.join(root, "workspace", "skills", "deploy-notes");
  await fs.mkdir(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillFile, "---\nname: deploy-notes\ndescription: Deploys.\n---\nSteps.\n");
  const skill = createCanonicalFixtureSkill({
    name: "deploy-notes",
    description: "Deploys.",
    filePath: skillFile,
    baseDir: skillDir,
    source: "openclaw-workspace",
  });
  const plugin = await prepareClaudeCliSkillsPlugin({
    backendId: "claude-cli",
    skillsSnapshot: { prompt: "", skills: [{ name: skill.name }], resolvedSkills: [skill] },
  });
  onTestFinished(plugin.cleanup);
  const context = buildContext(runId);
  context.claudeSkillsPlugin = plugin;
  const handlers = createCliEventHandlers({
    context,
    toolTracking: buildToolTracking(),
    getRunState: () => ({ failed: false, error: undefined }),
  });
  const parser = createCliJsonlStreamingParser({
    providerId: "claude-cli",
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    onAssistantDelta: vi.fn(),
    onToolUseStart: handlers.emitParsedToolUseStart,
    onToolResult: handlers.emitParsedToolResult,
  });
  const events: DiagnosticSkillUsedEvent[] = [];
  onTestFinished(
    onInternalDiagnosticEvent((event) => {
      if (event.type === "skill.used") {
        events.push(event);
      }
    }),
  );
  return { parser, events, skillFile: canonicalizePath(skillFile) };
}

describe("Claude CLI native Skill tool usage", () => {
  it("records a successful native Skill load against the canonical SKILL.md", async () => {
    const runId = "native-skill-usage";
    const { parser, events, skillFile } = await prepareRun(runId);

    parser.push(skillToolUse("toolu_1", "openclaw-skills:deploy-notes"));
    parser.push(skillToolResult("toolu_1", "openclaw-skills:deploy-notes"));
    await flushDiagnosticEvents();

    expect(consumeRunSkillUsage(runId)).toEqual([
      { name: "deploy-notes", source: "workspace", activation: "read", skillFile },
    ]);
    expect(events).toMatchObject([
      {
        type: "skill.used",
        runId,
        agentId: "main",
        skillName: "deploy-notes",
        skillSource: "workspace",
        activation: "read",
        toolName: "Skill",
        toolCallId: "toolu_1",
      },
    ]);
  });

  it("ignores failed loads and Claude skills OpenClaw did not materialize", async () => {
    const runId = "native-skill-usage-ignored";
    const { parser, events } = await prepareRun(runId);

    parser.push(skillToolUse("toolu_err", "openclaw-skills:deploy-notes"));
    parser.push(skillToolResult("toolu_err", "openclaw-skills:deploy-notes", true));
    parser.push(skillToolUse("toolu_user", "user-skill"));
    parser.push(skillToolResult("toolu_user", "user-skill"));
    await flushDiagnosticEvents();

    expect(consumeRunSkillUsage(runId)).toEqual([]);
    expect(events).toEqual([]);
  });
});
