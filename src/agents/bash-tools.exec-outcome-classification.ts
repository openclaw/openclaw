import { isEnvAssignmentToken, resolveCarrierCommandArgv } from "../infra/command-carriers.js";
import type { ExecOutcomeClassification } from "../infra/exec-outcome-classification-types.js";
import { normalizeExecutableToken } from "../infra/exec-wrapper-tokens.js";
import { splitShellArgs } from "../utils/shell-argv.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-runtime.js";

export type { ExecOutcomeClassification } from "../infra/exec-outcome-classification-types.js";

export type ExecOutcomeClassificationInput = {
  command?: string;
  status?: ExecProcessOutcome["status"];
  exitCode?: number | null;
  timedOut?: boolean;
  aggregated?: string;
};

const EXIT_FOOTER_RE = /\n*\(Command exited with code \d+\)\s*$/u;

const xargsOptionsWithValue = new Set([
  "-a",
  "--arg-file",
  "-d",
  "--delimiter",
  "-E",
  "-e",
  "-I",
  "-i",
  "-L",
  "-l",
  "-n",
  "--max-args",
  "-P",
  "--max-procs",
  "-s",
  "--max-chars",
]);

function cleanAggregateOutput(value: string | undefined): string {
  return (value ?? "").replace(EXIT_FOOTER_RE, "").trim();
}

function splitUnquotedPipes(command: string): string[] | null {
  const segments: string[] = [];
  let segment = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      segment += char;
      escaped = false;
      continue;
    }
    if (!inSingle && char === "\\") {
      segment += char;
      escaped = true;
      continue;
    }
    if (!inDouble && char === "'") {
      inSingle = !inSingle;
      segment += char;
      continue;
    }
    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      segment += char;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (char === "\n" || char === "\r" || char === "&") {
        return null;
      }
      if (char === ";") {
        return null;
      }
      if (
        (char === "&" && command[index + 1] === "&") ||
        (char === "|" && command[index + 1] === "|")
      ) {
        return null;
      }
      if (char === "|") {
        segments.push(segment);
        segment = "";
        continue;
      }
    }
    segment += char;
  }

  if (escaped || inSingle || inDouble) {
    return null;
  }
  segments.push(segment);
  return segments;
}

function resolveExecutableArgv(command: string): string[] | null {
  let argv = splitShellArgs(command);
  for (let depth = 0; argv && depth < 4; depth += 1) {
    while (isEnvAssignmentToken(argv[0] ?? "")) {
      argv = argv.slice(1);
    }
    const carriedArgv = resolveCarrierCommandArgv(argv, 0, { includeExec: true });
    if (!carriedArgv) {
      return argv;
    }
    argv = carriedArgv;
  }
  return null;
}

function firstExecutable(command: string): string | undefined {
  const argv = resolveExecutableArgv(command);
  return normalizeExecutableToken(argv?.[0] ?? "");
}

function isDirectRgNoMatch(params: { command: string; exitCode: number }): boolean {
  const segments = splitUnquotedPipes(params.command);
  if (params.exitCode !== 1 || !segments || segments.length !== 1) {
    return false;
  }
  return firstExecutable(segments[0] ?? "") === "rg";
}

function isXargsRgNoMatch(params: { command: string; exitCode: number }): boolean {
  const segments = splitUnquotedPipes(params.command);
  if (
    params.exitCode !== 123 ||
    !params.command.includes("xargs") ||
    !params.command.includes("rg") ||
    !segments
  ) {
    return false;
  }

  return xargsCommandLaunchesRg(segments.at(-1) ?? "");
}

function xargsCommandLaunchesRg(segment: string): boolean {
  const words = resolveExecutableArgv(segment);
  if (!words) {
    return false;
  }
  if (normalizeExecutableToken(words[0] ?? "") !== "xargs") {
    return false;
  }

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word) {
      continue;
    }
    if (word === "--") {
      return normalizeExecutableToken(words[index + 1] ?? "") === "rg";
    }
    if (xargsOptionsWithValue.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("--") && word.includes("=")) {
      continue;
    }
    if (word.startsWith("-")) {
      continue;
    }
    return normalizeExecutableToken(word) === "rg";
  }

  return false;
}

export function classifyExecOutcome(
  params: ExecOutcomeClassificationInput,
): ExecOutcomeClassification {
  if (params.timedOut === true || params.status === "failed") {
    return "failure";
  }
  if (params.exitCode === 0) {
    return "success";
  }
  if (typeof params.exitCode !== "number") {
    return "failure";
  }

  const command = params.command?.trim();
  if (!command || !command.includes("rg")) {
    return "failure";
  }
  if (cleanAggregateOutput(params.aggregated)) {
    return "failure";
  }

  if (
    isDirectRgNoMatch({ command, exitCode: params.exitCode }) ||
    isXargsRgNoMatch({ command, exitCode: params.exitCode })
  ) {
    return "benign_no_result";
  }

  return "failure";
}

export function execOutcomeStatusLabel(
  classification: ExecOutcomeClassification,
): string | undefined {
  return classification === "benign_no_result" ? "No matches found" : undefined;
}
