// Allowed command prefixes for setupCommand -- package managers, build tools, and safe builtins
export const ALLOWED_COMMAND_PREFIXES = [
  "npm",
  "npx",
  "pip",
  "pip3",
  "git",
  "apt-get",
  "apt",
  "yarn",
  "pnpm",
  "bun",
  "cargo",
  "go",
  "make",
  "echo",
] as const;

// Shell metacharacters and dangerous characters that enable command injection (CWE-78)
// Includes: pipes, chains, substitution, redirection, grouping, quotes, control chars
export const BLOCKED_SHELL_CHARS_PATTERN = /[;|&$`><(){}\[\]\n\r\t\f\v\\"'\\]/;

/**
 * Validates a setupCommand string against an allowlist of safe command prefixes
 * and rejects shell metacharacters that could enable command injection.
 *
 * @returns Object with `valid` boolean and optional `reason` when invalid.
 */
export function validateSetupCommand(command: string): { valid: boolean; reason?: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { valid: true };
  }

  if (BLOCKED_SHELL_CHARS_PATTERN.test(trimmed)) {
    return { valid: false, reason: "contains blocked shell metacharacter" };
  }

  const firstToken = trimmed.split(/\s+/)[0]!.toLowerCase();
  const allowed = ALLOWED_COMMAND_PREFIXES.some((prefix) => firstToken === prefix);
  if (!allowed) {
    return { valid: false, reason: `command '${firstToken}' not in allowlist` };
  }

  return { valid: true };
}
