import { buildUntrustedChannelMetadata } from "openclaw/plugin-sdk/security-runtime";

// LLMs default to standard Markdown (e.g. **bold**, # headers, [links](url)),
// which Slack does not render correctly. This prompt overrides that behavior
// so responses use Slack's native mrkdwn syntax instead.
const SLACK_PLATFORM_PROMPT = `\
*Slack Formatting Rules*

You are responding in a Slack workspace. Use Slack mrkdwn syntax, NOT standard Markdown.

Key differences from standard Markdown:
- Bold: *bold* (single asterisks, NOT double)
- Italic: _italic_ (underscores)
- Strikethrough: ~strikethrough~ (single tildes)
- Code inline: \`code\`
- Code block: \`\`\`code block\`\`\` (no language identifier)
- Bulleted list: use a single space before the dash (e.g. " - item")
- Numbered list: use a single space before the number (e.g. " 1. item")
- Links: <URL|display text>
- Block quote: > text

Do NOT use:
- **double asterisks** for bold
- # headers (use *bold* on its own line instead)
- [text](url) markdown links
- Language identifiers in code blocks (e.g. \`\`\`js)
- Tables in pipe-delimited format`;

export function resolveSlackRoomContextHints(params: {
  isRoomish: boolean;
  channelInfo?: { topic?: string; purpose?: string };
  channelConfig?: { systemPrompt?: string | null } | null;
  globalSystemPrompt?: string | null;
  dmSystemPrompt?: string | null;
  isDirectMessage: boolean;
}): {
  untrustedChannelMetadata?: ReturnType<typeof buildUntrustedChannelMetadata>;
  groupSystemPrompt?: string;
} {
  const untrustedChannelMetadata = params.isRoomish
    ? buildUntrustedChannelMetadata({
        source: "slack",
        label: "Slack channel description",
        entries: [params.channelInfo?.topic, params.channelInfo?.purpose],
      })
    : undefined;

  // Build system prompt: platform > global > channel/DM-specific
  const systemPromptParts = [
    SLACK_PLATFORM_PROMPT,
    params.globalSystemPrompt?.trim() || null,
    params.isRoomish ? params.channelConfig?.systemPrompt?.trim() || null : null,
    params.isDirectMessage ? params.dmSystemPrompt?.trim() || null : null,
  ].filter((entry): entry is string => Boolean(entry));

  const groupSystemPrompt = systemPromptParts.join("\n\n");

  return {
    untrustedChannelMetadata,
    groupSystemPrompt,
  };
}
