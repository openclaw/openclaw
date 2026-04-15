import path from "node:path";
import { analyzeShellCommand } from "../infra/exec-approvals-analysis.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

type BashValidationParams = {
  command: string;
  workdir?: string;
  security: string;
  ask: string;
  platform?: string | null;
};

const HARD_STOP_BINS = new Set(["shutdown", "reboot", "poweroff", "halt", "mkfs", "mkfs.ext4"]);

function hasNulByte(input: string): boolean {
  return input.includes("\u0000");
}

function isDestructiveRm(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  const bin = path.basename(argv[0]).toLowerCase();
  if (bin !== "rm") {
    return false;
  }
  const flags = argv.filter((token) => token.startsWith("-")).join("");
  const recursive = flags.includes("r") || flags.includes("R") || flags.includes("--recursive");
  const forced = flags.includes("f") || flags.includes("--force");
  if (!recursive || !forced) {
    return false;
  }
  const targets = argv.filter((token, index) => index > 0 && !token.startsWith("-"));
  return targets.some((token) => token === "/" || token === "/*" || token === "~" || token === "~/*");
}

function isDangerousDd(argv: string[]): boolean {
  const bin = path.basename(argv[0] ?? "").toLowerCase();
  if (bin !== "dd") {
    return false;
  }
  return argv.some((token) => token.startsWith("of=/dev/"));
}

function detectDestructivePattern(argv: string[]): string | null {
  if (argv.length === 0) {
    return null;
  }
  const rawBin = normalizeOptionalLowercaseString(path.basename(argv[0])) ?? "";
  const bin = rawBin.split(".", 1)[0] || rawBin;
  if (HARD_STOP_BINS.has(rawBin) || HARD_STOP_BINS.has(bin)) {
    return `system-control binary (${rawBin})`;
  }
  if (isDestructiveRm(argv)) {
    return "rm -rf targeting root/home";
  }
  if (isDangerousDd(argv)) {
    return "dd writing to /dev/*";
  }
  return null;
}

function hasTraversalLikePath(argv: string[]): boolean {
  return argv.some((token, index) => {
    if (index === 0 || token.startsWith("-")) {
      return false;
    }
    return token === ".." || token.includes("../") || token.includes("..\\");
  });
}

export function validateBashCommand(params: BashValidationParams): string[] {
  const command = params.command.trim();
  if (!command) {
    throw new Error("exec validation: command is empty.");
  }
  if (hasNulByte(command)) {
    throw new Error("exec validation: command contains unsupported NUL bytes.");
  }
  if (params.workdir && hasNulByte(params.workdir)) {
    throw new Error("exec validation: workdir contains unsupported NUL bytes.");
  }

  const analysis = analyzeShellCommand({
    command,
    ...(params.workdir ? { cwd: params.workdir } : {}),
    ...(params.platform ? { platform: params.platform } : {}),
  });
  if (!analysis.ok) {
    // Keep compatibility with existing exec preflight behavior for complex shell forms
    // (multiline flow/process substitution). Dedicated preflight paths handle these.
    return [];
  }

  const warnings: string[] = [];
  let hasDestructiveSegment = false;
  for (const segment of analysis.segments) {
    const destructive = detectDestructivePattern(segment.argv);
    if (destructive) {
      hasDestructiveSegment = true;
      warnings.push(`Bash validation warning: destructive command pattern detected (${destructive}).`);
    }
    if (hasTraversalLikePath(segment.argv)) {
      warnings.push("Bash validation warning: relative parent path (`..`) detected in command arguments.");
    }
  }

  if (hasDestructiveSegment && params.security === "allowlist" && params.ask === "off") {
    throw new Error(
      "exec validation: destructive commands require interactive approval in allowlist mode (set ask=on-miss|always).",
    );
  }

  return warnings;
}
