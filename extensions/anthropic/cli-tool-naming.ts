import { OPENCLAW_MCP_TOOL_PREFIX } from "./cli-constants.js";

const CLAUDE_CLI_TOOL_NAMING_HEADING = "## OpenClaw tool names in Claude Code";

const CLAUDE_CLI_TOOL_NAMING_SECTION = [
  CLAUDE_CLI_TOOL_NAMING_HEADING,
  `OpenClaw MCP: \`${OPENCLAW_MCP_TOOL_PREFIX}<name>\`. Deferred: ToolSearch \`select:${OPENCLAW_MCP_TOOL_PREFIX}<name>\` first.`,
].join("\n");
const CLAUDE_CLI_MESSAGE_TOOL_GUIDANCE = `Tool-only replies: \`${OPENCLAW_MCP_TOOL_PREFIX}message(action=send)\`. Native \`SendMessage\`/\`PushNotification\` cannot deliver OpenClaw replies.`;

// Keep Claude's registration names in its backend and preserve the shared prompt prefix.
export function appendClaudeCliToolNamingGuidance(
  systemPrompt: string,
  toolNames: readonly string[] = [],
): string {
  if (
    toolNames.length === 0 ||
    !systemPrompt.trim() ||
    systemPrompt.includes(CLAUDE_CLI_TOOL_NAMING_HEADING)
  ) {
    return systemPrompt;
  }
  const messageGuidance = toolNames.includes("message")
    ? `\n${CLAUDE_CLI_MESSAGE_TOOL_GUIDANCE}`
    : "";
  return `${systemPrompt}\n\n${CLAUDE_CLI_TOOL_NAMING_SECTION}${messageGuidance}\n`;
}
