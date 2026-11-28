import { OPENCLAW_MCP_TOOL_PREFIX } from "./cli-constants.js";

const CLAUDE_CLI_TOOL_NAMING_HEADING = "## OpenClaw tool names in Claude Code";
const EXACT_TOOL_NAME_INSTRUCTION = "Tools policy-filtered. Names case-sensitive; call exact.";
const CLAUDE_CLI_TOOL_NAMING_GUIDANCE = `For OpenClaw tools, call \`${OPENCLAW_MCP_TOOL_PREFIX}<name>\`; the bare Tooling labels are not callable. Deferred: ToolSearch \`select:${OPENCLAW_MCP_TOOL_PREFIX}<name>\` first.`;
const CLAUDE_CLI_MESSAGE_TOOL_GUIDANCE = `Tool-only replies: \`${OPENCLAW_MCP_TOOL_PREFIX}message(action=send)\`. Native \`SendMessage\`/\`PushNotification\` cannot deliver OpenClaw replies.`;

// Claude Code registers OpenClaw tools as mcp__openclaw__<name> and lists every one itself, so
// the shared Tooling list states the callable form before its exact-name rule and keeps only
// the entries that add a description.
export function applyClaudeCliToolNaming(
  systemPrompt: string,
  toolNames: readonly string[] = [],
): string {
  if (
    toolNames.length === 0 ||
    !systemPrompt.trim() ||
    systemPrompt.includes(CLAUDE_CLI_TOOL_NAMING_GUIDANCE)
  ) {
    return systemPrompt;
  }
  const guidance = toolNames.includes("message")
    ? `${CLAUDE_CLI_TOOL_NAMING_GUIDANCE}\n${CLAUDE_CLI_MESSAGE_TOOL_GUIDANCE}`
    : CLAUDE_CLI_TOOL_NAMING_GUIDANCE;
  const lines = systemPrompt.split("\n");
  const instruction = lines.indexOf(EXACT_TOOL_NAME_INSTRUCTION);
  if (instruction < 0) {
    // Prompts without a Tooling section (prompt mode "none") keep the mapping at the end.
    return `${systemPrompt}\n\n${CLAUDE_CLI_TOOL_NAMING_HEADING}\n${guidance}\n`;
  }
  let listEnd = instruction + 1;
  while (lines[listEnd]?.startsWith("- ")) {
    listEnd += 1;
  }
  const nameOnlyLines = new Set(toolNames.map((name) => `- ${name}`));
  return [
    ...lines.slice(0, instruction),
    guidance,
    ...lines.slice(instruction, listEnd).filter((line) => !nameOnlyLines.has(line)),
    ...lines.slice(listEnd),
  ].join("\n");
}
