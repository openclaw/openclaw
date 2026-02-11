import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Git sub-commands that trigger commit signing when `commit.gpgsign=true`.
 */
const GIT_SIGNING_SUBCOMMANDS = new Set([
  "commit",
  "merge",
  "tag",
  "rebase",
  "cherry-pick",
  "revert",
  "am",
  "push", // push can trigger signing for signed pushes
]);

/**
 * Check if a shell command is a git command that may trigger signing.
 * Returns the detected git sub-command, or null if not a signing-eligible git command.
 */
export function parseGitSigningCommand(command: string): string | null {
  const trimmed = command.trim();

  // Check if the command already explicitly disables signing
  if (
    trimmed.includes("--no-gpg-sign") ||
    trimmed.includes("commit.gpgsign=false") ||
    trimmed.includes("gpgsign=false")
  ) {
    return null;
  }

  // Match patterns like: git commit, git -C /path commit, git -c key=val commit, etc.
  // Also handles: cd foo && git commit, ENV=val git commit, etc.
  // Use global flag to find all git invocations in compound commands.
  const gitPattern = /(?:^|&&|\|\||;\s*|\|)\s*(?:\S+=\S+\s+)*git\s+(?:-[cC]\s+\S+\s+)*(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = gitPattern.exec(trimmed)) !== null) {
    const subcommand = match[1];
    if (subcommand && GIT_SIGNING_SUBCOMMANDS.has(subcommand)) {
      return subcommand;
    }
  }

  return null;
}

/**
 * Result of SSH signing detection.
 */
export type GitSshSigningInfo = {
  /** Whether SSH-based signing is active */
  sshSigning: boolean;
  /** Whether commit.gpgsign is enabled */
  gpgSignEnabled: boolean;
  /** The gpg.format value (e.g. "ssh", "openpgp", "x509") */
  gpgFormat: string | null;
};

/**
 * Detect if git is configured with SSH-based commit signing.
 * Reads git config from the given working directory.
 *
 * This is intentionally fast — runs two `git config` lookups with a short timeout.
 */
export async function detectGitSshSigning(cwd: string): Promise<GitSshSigningInfo> {
  const result: GitSshSigningInfo = {
    sshSigning: false,
    gpgSignEnabled: false,
    gpgFormat: null,
  };

  try {
    const [gpgSignResult, formatResult] = await Promise.all([
      execFileAsync("git", ["config", "--get", "commit.gpgsign"], {
        cwd,
        timeout: 3000,
        encoding: "utf8",
      }).catch(() => ({ stdout: "" })),
      execFileAsync("git", ["config", "--get", "gpg.format"], {
        cwd,
        timeout: 3000,
        encoding: "utf8",
      }).catch(() => ({ stdout: "" })),
    ]);

    const gpgSign = gpgSignResult.stdout.trim().toLowerCase();
    const format = formatResult.stdout.trim().toLowerCase();

    result.gpgSignEnabled = gpgSign === "true";
    result.gpgFormat = format || null;
    result.sshSigning = result.gpgSignEnabled && format === "ssh";
  } catch {
    // If we can't read git config, don't block execution
  }

  return result;
}

/**
 * Build a warning message for git SSH signing issues.
 */
export function buildGitSshSigningWarning(subcommand: string): string {
  return (
    `Warning: git ${subcommand} may fail — SSH-based commit signing (gpg.format=ssh) ` +
    `requires TTY access unavailable in non-interactive shells. ` +
    `Workaround: use pty=true, or pass --no-gpg-sign, ` +
    `or run: git -c commit.gpgsign=false ${subcommand}`
  );
}
