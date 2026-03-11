import path from "node:path";
import {
  analyzeShellCommand,
  type ExecCommandSegment,
  type ExecCommandAnalysis,
} from "../infra/exec-approvals.js";
import { parseExecArgvToken } from "../infra/exec-command-resolution.js";
import {
  assertFilesystemPathPermission,
  resolveFilesystemPermissionPath,
  type FilesystemPermissionOperation,
  type ResolvedFilesystemPermissions,
} from "../infra/filesystem-permissions.js";
import { expandHomePrefix } from "../infra/home-dir.js";

type ExecPathPermissionCheck = {
  operation: FilesystemPermissionOperation;
  targetPath: string;
  reason: string;
};

const READ_POSITIONAL_COMMANDS = new Set([
  "cat",
  "cut",
  "diff",
  "du",
  "file",
  "head",
  "less",
  "ls",
  "more",
  "realpath",
  "readlink",
  "sort",
  "stat",
  "tail",
  "tree",
  "uniq",
  "wc",
]);

const WRITE_POSITIONAL_COMMANDS = new Set([
  "chmod",
  "chown",
  "chgrp",
  "install",
  "mkdir",
  "mktemp",
  "rm",
  "rmdir",
  "touch",
  "truncate",
]);

const SCRIPT_INTERPRETERS = new Set([
  "bash",
  "dash",
  "fish",
  "ksh",
  "node",
  "nodejs",
  "perl",
  "php",
  "python",
  "python3",
  "ruby",
  "sh",
  "zsh",
]);

function normalizeCommandName(segment: ExecCommandSegment): string {
  const executable =
    segment.resolution?.executableName?.trim() ||
    segment.resolution?.rawExecutable?.trim() ||
    segment.argv[0]?.trim() ||
    "";
  if (!executable) {
    return "";
  }
  return path.basename(executable).toLowerCase();
}

function resolvePathToken(token: string, cwd: string): string | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed === "-") {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("$")) {
    return null;
  }
  try {
    return resolveFilesystemPermissionPath({
      targetPath: trimmed.startsWith("~") ? expandHomePrefix(trimmed) : trimmed,
      cwd,
    });
  } catch {
    return null;
  }
}

function collectPositionalTokens(argv: string[]): string[] {
  const tokens: string[] = [];
  let afterTerminator = false;
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]?.trim() ?? "";
    if (!token) {
      continue;
    }
    if (!afterTerminator && token === "--") {
      afterTerminator = true;
      continue;
    }
    if (!afterTerminator) {
      const parsed = parseExecArgvToken(token);
      if (parsed.kind === "option" || parsed.kind === "terminator") {
        continue;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

function collectFindStartPaths(argv: string[]): string[] {
  const roots: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]?.trim() ?? "";
    if (!token) {
      continue;
    }
    if (token === "--") {
      break;
    }
    if (token.startsWith("-") || token === "(" || token === "!" || token === ")") {
      break;
    }
    roots.push(token);
  }
  return roots;
}

function collectPathChecksForSegment(params: {
  segment: ExecCommandSegment;
  cwd: string;
}): ExecPathPermissionCheck[] {
  const checks: ExecPathPermissionCheck[] = [];
  const argv =
    params.segment.resolution?.effectiveArgv && params.segment.resolution.effectiveArgv.length > 0
      ? params.segment.resolution.effectiveArgv
      : params.segment.argv;

  const executablePath =
    params.segment.resolution?.resolvedRealPath ?? params.segment.resolution?.resolvedPath;
  if (executablePath) {
    checks.push({
      operation: "execute",
      targetPath: executablePath,
      reason: "command executable",
    });
  }

  const command = normalizeCommandName(params.segment);
  if (!command) {
    return checks;
  }

  const addChecksFromTokens = (
    tokens: string[],
    operation: FilesystemPermissionOperation,
    reason: string,
  ) => {
    for (const token of tokens) {
      const resolved = resolvePathToken(token, params.cwd);
      if (!resolved) {
        continue;
      }
      checks.push({ operation, targetPath: resolved, reason });
    }
  };

  if (command === "cp" || command === "mv") {
    const positionals = collectPositionalTokens(argv);
    if (positionals.length >= 2) {
      const destination = positionals[positionals.length - 1];
      addChecksFromTokens(positionals.slice(0, -1), "read", `${command} source`);
      if (destination) {
        addChecksFromTokens([destination], "write", `${command} destination`);
      }
    }
    return checks;
  }

  if (command === "ln") {
    const positionals = collectPositionalTokens(argv);
    if (positionals.length >= 2) {
      const target = positionals[positionals.length - 1];
      addChecksFromTokens([positionals[0]], "read", "ln source");
      if (target) {
        addChecksFromTokens([target], "write", "ln target");
      }
    } else {
      addChecksFromTokens(positionals, "write", "ln target");
    }
    return checks;
  }

  if (command === "dd") {
    for (const token of argv.slice(1)) {
      const trimmed = token.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed.startsWith("if=")) {
        addChecksFromTokens([trimmed.slice(3)], "read", "dd input");
      } else if (trimmed.startsWith("of=")) {
        addChecksFromTokens([trimmed.slice(3)], "write", "dd output");
      }
    }
    return checks;
  }

  if (command === "find") {
    const roots = collectFindStartPaths(argv);
    addChecksFromTokens(roots, "read", "find root");
    return checks;
  }

  if (command === "grep" || command === "rg") {
    const positionals = collectPositionalTokens(argv);
    if (positionals.length > 1) {
      addChecksFromTokens(positionals.slice(1), "read", `${command} file`);
    }
    return checks;
  }

  if (command === "sed" || command === "awk") {
    const positionals = collectPositionalTokens(argv);
    if (positionals.length > 1) {
      addChecksFromTokens(positionals.slice(1), "read", `${command} file`);
    }
    return checks;
  }

  if (SCRIPT_INTERPRETERS.has(command)) {
    const positionals = collectPositionalTokens(argv);
    if (positionals.length > 0) {
      addChecksFromTokens([positionals[0]], "read", `${command} script`);
    }
    return checks;
  }

  if (READ_POSITIONAL_COMMANDS.has(command)) {
    addChecksFromTokens(collectPositionalTokens(argv), "read", `${command} operand`);
    return checks;
  }

  if (WRITE_POSITIONAL_COMMANDS.has(command) || command === "tee") {
    addChecksFromTokens(collectPositionalTokens(argv), "write", `${command} operand`);
    return checks;
  }

  return checks;
}

function collectExecPathPermissionChecks(params: {
  command: string;
  cwd: string;
  env: Record<string, string>;
}): { analysis: ExecCommandAnalysis; checks: ExecPathPermissionCheck[] } {
  const analysis = analyzeShellCommand({
    command: params.command,
    cwd: params.cwd,
    env: params.env,
    platform: process.platform,
  });
  if (!analysis.ok) {
    return { analysis, checks: [] };
  }
  const checks: ExecPathPermissionCheck[] = [];
  for (const segment of analysis.segments) {
    checks.push(...collectPathChecksForSegment({ segment, cwd: params.cwd }));
  }
  return { analysis, checks };
}

export function assertExecFilesystemPermissions(params: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  permissions: ResolvedFilesystemPermissions | undefined;
}): void {
  if (!params.permissions) {
    return;
  }
  const { analysis, checks } = collectExecPathPermissionChecks(params);
  if (!analysis.ok) {
    throw new Error(
      `exec denied: failed to analyze filesystem access (${analysis.reason ?? "unknown reason"})`,
    );
  }

  for (const check of checks) {
    assertFilesystemPathPermission({
      permissions: params.permissions,
      targetPath: check.targetPath,
      operation: check.operation,
      cwd: params.cwd,
      context: `exec ${check.reason}`,
    });
  }
}

export const __testing = {
  collectExecPathPermissionChecks,
};
