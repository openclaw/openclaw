/**
 * Claude Code registers every bundled OpenClaw tool through the `openclaw` MCP
 * server as `mcp__openclaw__<name>` and, once the MCP catalog grows, defers those
 * tools behind ToolSearch. The shared system prompt names tools by their short
 * OpenClaw ids (`message(action=send)`), so a fresh Claude session calls a tool
 * literally named `message`, receives "No such tool available: message", searches
 * `select:message`, finds nothing, and the reply strands in message-tool-only
 * conversations. This backend-owned prompt overlay spells out the mapping.
 */
import { OPENCLAW_MCP_TOOL_PREFIX } from "./cli-constants.js";

const CLAUDE_CLI_TOOL_NAMING_HEADING = "## OpenClaw tool names in Claude Code";

const CLAUDE_CLI_TOOL_NAMING_SECTION = [
  CLAUDE_CLI_TOOL_NAMING_HEADING,
  `- OpenClaw tools are served by the \`openclaw\` MCP server as \`${OPENCLAW_MCP_TOOL_PREFIX}<name>\`; short names above map 1:1 (\`message\` => \`${OPENCLAW_MCP_TOOL_PREFIX}message\`).`,
  `- A short name is never a Claude native tool. Not loaded => ToolSearch \`select:${OPENCLAW_MCP_TOOL_PREFIX}<name>\` (keyword search may not surface it), then call it.`,
  `- Visible source reply on a message-tool-only turn: \`${OPENCLAW_MCP_TOOL_PREFIX}message(action=send)\`. Native \`SendMessage\`/\`PushNotification\` are not OpenClaw delivery.`,
].join("\n");

/** Appends the OpenClaw-to-Claude tool naming section once, after the cache-stable prompt prefix. */
export function appendClaudeCliToolNamingGuidance(systemPrompt: string): string {
  const trimmed = systemPrompt.trimEnd();
  if (!trimmed || trimmed.includes(CLAUDE_CLI_TOOL_NAMING_HEADING)) {
    return systemPrompt;
  }
  return `${trimmed}\n\n${CLAUDE_CLI_TOOL_NAMING_SECTION}\n`;
}
