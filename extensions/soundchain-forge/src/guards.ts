// Security guards for SoundChain Forge tools
// Zero booleans — all validation returns typed string results.

import { resolve, normalize } from "node:path";

// ─── Path Guard ──────────────────────────────────────────────────────────

const PATH_VERDICT = {
  ALLOWED: "ALLOWED",
  BLOCKED: "BLOCKED",
  OUTSIDE: "OUTSIDE",
} as const;

type PathVerdict = (typeof PATH_VERDICT)[keyof typeof PATH_VERDICT];

type PathResult = {
  verdict: PathVerdict;
  resolved: string;
  error?: string;
};

const DEFAULT_ALLOWED = ["/home/ubuntu/soundchain", "/tmp"];
const BLOCKED_PATHS = ["/etc/shadow", "/etc/passwd", "/root", "/proc", "/sys"];
const BLOCKED_PREFIXES = [
  "/root/",
  "/etc/ssh/",
  "/etc/ssl/",
  "/home/ubuntu/.ssh/",
  "/home/ubuntu/.aws/",
  "/home/ubuntu/.gnupg/",
];

export class PathGuard {
  private allowedPaths: string[];

  constructor(allowedPaths?: string[]) {
    this.allowedPaths = (allowedPaths ?? DEFAULT_ALLOWED).map((p) => resolve(p));
  }

  validate(filePath: string): PathResult {
    const resolved = resolve(normalize(filePath));

    // Block known sensitive paths
    for (const blocked of BLOCKED_PATHS) {
      if (resolved === blocked) {
        return {
          verdict: PATH_VERDICT.BLOCKED,
          resolved,
          error: `Access denied: ${blocked}`,
        };
      }
    }

    for (const prefix of BLOCKED_PREFIXES) {
      if (resolved.startsWith(prefix)) {
        return {
          verdict: PATH_VERDICT.BLOCKED,
          resolved,
          error: `Access denied: ${prefix}*`,
        };
      }
    }

    // Check against allowed roots
    const inside = this.allowedPaths.some(
      (root) => resolved === root || resolved.startsWith(root + "/"),
    );

    if (!inside) {
      return {
        verdict: PATH_VERDICT.OUTSIDE,
        resolved,
        error: `Path outside allowed directories: ${this.allowedPaths.join(", ")}`,
      };
    }

    return { verdict: PATH_VERDICT.ALLOWED, resolved };
  }
}

// ─── Bash Guard ──────────────────────────────────────────────────────────

const BASH_VERDICT = {
  ALLOWED: "ALLOWED",
  BLOCKED: "BLOCKED",
} as const;

type BashResult = {
  verdict: (typeof BASH_VERDICT)[keyof typeof BASH_VERDICT];
  error?: string;
};

const BASH_BLOCKLIST = [
  "rm -rf /",
  "rm -rf /*",
  "sudo ",
  "dd if=",
  "mkfs",
  ":(){ :|:& };:",
  "shutdown",
  "reboot",
  "halt",
  "init 0",
  "init 6",
  "> /dev/sda",
  "chmod -R 777 /",
  "chown -R",
  "curl | sh",
  "curl | bash",
  "wget | sh",
  "wget | bash",
];

export class BashGuard {
  validate(command: string): BashResult {
    const lower = command.toLowerCase().trim();

    for (const blocked of BASH_BLOCKLIST) {
      if (lower.includes(blocked.toLowerCase())) {
        return {
          verdict: BASH_VERDICT.BLOCKED,
          error: `Blocked command pattern: ${blocked}`,
        };
      }
    }

    return { verdict: BASH_VERDICT.ALLOWED };
  }
}

// ─── Git Guard ───────────────────────────────────────────────────────────

const GIT_VERDICT = {
  ALLOWED: "ALLOWED",
  BLOCKED: "BLOCKED",
} as const;

type GitResult = {
  verdict: (typeof GIT_VERDICT)[keyof typeof GIT_VERDICT];
  error?: string;
};

const GIT_ALLOWED_COMMANDS = [
  "status",
  "diff",
  "log",
  "add",
  "commit",
  "push",
  "pull",
  "branch",
  "checkout",
  "stash",
  "show",
  "remote",
  "fetch",
  "merge",
  "rebase",
  "cherry-pick",
  "tag",
  "rev-parse",
  "ls-files",
  "blame",
];

const GIT_BLOCKED_FLAGS = ["--force", "-f", "--no-verify", "--hard", "--force-with-lease"];

const GIT_BLOCKED_COMBOS = [
  "push --force",
  "push -f",
  "reset --hard",
  "clean -f",
  "clean -fd",
  "branch -D",
];

export class GitGuard {
  validate(subcommand: string, args: string[]): GitResult {
    const cmd = subcommand.toLowerCase();

    if (!GIT_ALLOWED_COMMANDS.includes(cmd)) {
      return {
        verdict: GIT_VERDICT.BLOCKED,
        error: `Git subcommand not allowed: ${cmd}. Allowed: ${GIT_ALLOWED_COMMANDS.join(", ")}`,
      };
    }

    const full = `${cmd} ${args.join(" ")}`.toLowerCase();

    for (const combo of GIT_BLOCKED_COMBOS) {
      if (full.includes(combo)) {
        return {
          verdict: GIT_VERDICT.BLOCKED,
          error: `Blocked git command: ${combo}`,
        };
      }
    }

    for (const flag of GIT_BLOCKED_FLAGS) {
      if (args.some((a) => a.toLowerCase() === flag)) {
        return {
          verdict: GIT_VERDICT.BLOCKED,
          error: `Blocked git flag: ${flag}`,
        };
      }
    }

    return { verdict: GIT_VERDICT.ALLOWED };
  }
}
