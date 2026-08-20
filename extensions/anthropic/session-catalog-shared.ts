// Dependency-free Claude catalog contracts shared by catalog and terminal ownership.

// Shared bound for free-text catalog fields such as paths and titles.
export const MAX_STRING_LENGTH = 4096;

export const CLAUDE_SESSIONS_LIST_COMMAND = "anthropic.claude.sessions.list.v1";
export const CLAUDE_SESSION_READ_COMMAND = "anthropic.claude.sessions.read.v1";
export const CLAUDE_CLI_NODE_RUN_COMMAND = "agent.cli.claude.run.v1";
export const CLAUDE_TERMINAL_RESUME_COMMAND = "anthropic.claude.terminal.resume.v1";
export const CLAUDE_TERMINAL_START_COMMAND = "anthropic.claude.terminal.start.v1";

export class ClaudeCatalogParamsError extends Error {}

// Desktop sessions share the resumable projects store with CLI sessions.
export function isResumableClaudeSource(source: string | undefined): boolean {
  return source === "claude-cli" || source === "claude-desktop";
}

// Decodes one complete JSON number token with the admitted reader's exact
// semantics: JSON number grammar and a finite value. `overflowed` marks a
// token the bounded scanner truncated, which is rejected here so a shorter
// valid prefix is never mistaken for the full value the admitted reader saw.
export function parseBoundedJsonNumberToken(
  token: string,
  overflowed: boolean,
): number | undefined {
  if (overflowed || token.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(token) as unknown;
  } catch {
    return undefined;
  }
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}
