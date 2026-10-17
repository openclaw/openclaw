import type { CliOutput } from "../cli-output-contracts.js";

// Claude Code prints this as the entire reply once the subscription window is
// exhausted, e.g. "You've hit your session limit · resets 4:10pm (Asia/Seoul)".
// The match covers the whole trimmed message on one line, so a real answer that
// quotes or discusses the notice stays a success.
const CLAUDE_CLI_USAGE_LIMIT_NOTICE_RE =
  /^you(?:['’]ve| have) hit your (?:[a-z0-9-]+ )?limit\s*[·∙.-]\s*resets [^\r\n]{1,80}$/i;

/** True when the whole message is Claude Code's subscription-limit notice. */
export function isClaudeCliUsageLimitNotice(provider: string, message: string): boolean {
  return provider === "claude-cli" && CLAUDE_CLI_USAGE_LIMIT_NOTICE_RE.test(message.trim());
}

/**
 * Claude Code reports an exhausted subscription as a successful turn whose only
 * text is the notice. Reclassify it as an error so the fallback chain runs
 * instead of delivering and persisting the notice as the assistant's answer.
 * Turns with tool or delivery effects stay successes: failing them would let a
 * fallback model replay effects that already happened.
 */
export function rejectClaudeCliUsageLimitNotice(provider: string, output: CliOutput): CliOutput {
  if (
    output.errorText ||
    !isClaudeCliUsageLimitNotice(provider, output.text) ||
    (output.toolSummary?.calls ?? 0) > 0 ||
    output.toolMediaUrls?.length ||
    output.acceptedSessionSpawns?.length ||
    output.didSendViaMessagingTool ||
    output.didDeliverSourceReplyViaMessageTool ||
    output.yielded
  ) {
    return output;
  }
  return { ...output, text: "", textParts: undefined, errorText: output.text.trim() };
}
