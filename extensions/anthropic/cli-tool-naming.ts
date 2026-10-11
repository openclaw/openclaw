import { OPENCLAW_MCP_TOOL_PREFIX } from "./cli-constants.js";

const CLAUDE_CLI_TOOL_NAMING_HEADING = "## OpenClaw tool names in Claude Code";

const CLAUDE_CLI_TOOL_NAMING_SECTION = [
  CLAUDE_CLI_TOOL_NAMING_HEADING,
  `- OpenClaw MCP tools listed above are registered under the \`openclaw\` server as \`${OPENCLAW_MCP_TOOL_PREFIX}<name>\` (\`message\` => \`${OPENCLAW_MCP_TOOL_PREFIX}message\`). Use the registered name when calling an OpenClaw tool.`,
  `- If an OpenClaw tool is deferred, load it with ToolSearch \`select:${OPENCLAW_MCP_TOOL_PREFIX}<name>\`, then call it. Keyword search may not surface the tool.`,
  `- Visible source replies on message-tool-only turns use \`${OPENCLAW_MCP_TOOL_PREFIX}message(action=send)\`. Native \`SendMessage\` and \`PushNotification\` do not deliver through OpenClaw.`,
].join("\n");

// Keep Claude's registration names in its backend and preserve the shared prompt prefix.
export function appendClaudeCliToolNamingGuidance(systemPrompt: string): string {
  if (!systemPrompt.trim() || systemPrompt.includes(CLAUDE_CLI_TOOL_NAMING_HEADING)) {
    return systemPrompt;
  }
  return `${systemPrompt}\n\n${CLAUDE_CLI_TOOL_NAMING_SECTION}\n`;
}
