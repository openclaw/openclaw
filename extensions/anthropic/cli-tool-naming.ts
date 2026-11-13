import { OPENCLAW_MCP_TOOL_PREFIX } from "./cli-constants.js";

const CLAUDE_CLI_EXACT_TOOL_NAME_INSTRUCTION =
  "Tools policy-filtered. Names case-sensitive; call exact.";
const CLAUDE_CLI_TOOL_NAMING_GUIDANCE = [
  `For OpenClaw tools, call \`${OPENCLAW_MCP_TOOL_PREFIX}<name>\`; the bare Tooling labels are not callable.`,
  `Deferred: ToolSearch \`select:${OPENCLAW_MCP_TOOL_PREFIX}<name>\` first.`,
].join("\n");
const CLAUDE_CLI_TOOL_NAMING_GUIDANCE_MARKER = "For OpenClaw tools, call";
const CLAUDE_CLI_MESSAGE_TOOL_GUIDANCE = `Tool-only replies: \`${OPENCLAW_MCP_TOOL_PREFIX}message(action=send)\`. Native \`SendMessage\`/\`PushNotification\` cannot deliver OpenClaw replies.`;

// Put Claude's registered names before the shared prompt's generic exact-call instruction.
export function appendClaudeCliToolNamingGuidance(
  systemPrompt: string,
  toolNames: readonly string[] = [],
): string {
  if (
    toolNames.length === 0 ||
    !systemPrompt.trim() ||
    systemPrompt.includes(CLAUDE_CLI_TOOL_NAMING_GUIDANCE_MARKER)
  ) {
    return systemPrompt;
  }
  const instructionIndex = systemPrompt.indexOf(CLAUDE_CLI_EXACT_TOOL_NAME_INSTRUCTION);
  const toolingHeadingIndex = systemPrompt.indexOf("## Tooling");
  const toolingHeadingEnd =
    toolingHeadingIndex < 0 ? -1 : systemPrompt.indexOf("\n", toolingHeadingIndex);
  const insertionIndex =
    instructionIndex >= 0
      ? instructionIndex
      : toolingHeadingIndex < 0
        ? -1
        : toolingHeadingEnd >= 0
          ? toolingHeadingEnd + 1
          : systemPrompt.length;
  const namingGuidance = `${CLAUDE_CLI_TOOL_NAMING_GUIDANCE}\n`;
  const promptWithNamingGuidance =
    insertionIndex >= 0
      ? `${systemPrompt.slice(0, insertionIndex)}${namingGuidance}${systemPrompt.slice(insertionIndex)}`
      : `${systemPrompt}\n\n${CLAUDE_CLI_TOOL_NAMING_GUIDANCE}`;
  const messageGuidance = toolNames.includes("message")
    ? `\n${CLAUDE_CLI_MESSAGE_TOOL_GUIDANCE}`
    : "";
  return `${promptWithNamingGuidance}${messageGuidance}\n`;
}
