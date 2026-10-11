import { OPENCLAW_MCP_TOOL_PREFIX } from "./cli-constants.js";

const CLAUDE_CLI_TOOL_NAMING_HEADING = "## OpenClaw tool names in Claude Code";

const CLAUDE_CLI_TOOL_NAMING_SECTION = [
  CLAUDE_CLI_TOOL_NAMING_HEADING,
  `OpenClaw MCP: \`${OPENCLAW_MCP_TOOL_PREFIX}<name>\`. Deferred: ToolSearch \`select:${OPENCLAW_MCP_TOOL_PREFIX}<name>\` first.`,
  `Tool-only replies: \`${OPENCLAW_MCP_TOOL_PREFIX}message(action=send)\`. Native \`SendMessage\`/\`PushNotification\` cannot deliver OpenClaw replies.`,
].join("\n");

// Keep Claude's registration names in its backend and preserve the shared prompt prefix.
export function appendClaudeCliToolNamingGuidance(systemPrompt: string): string {
  if (!systemPrompt.trim() || systemPrompt.includes(CLAUDE_CLI_TOOL_NAMING_HEADING)) {
    return systemPrompt;
  }
  return `${systemPrompt}\n\n${CLAUDE_CLI_TOOL_NAMING_SECTION}\n`;
}
