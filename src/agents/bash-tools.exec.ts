import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { consumeRootOptionToken } from "../infra/cli-root-options.js";
import {
  analyzeShellCommand,
  splitCommandChainWithOperators,
} from "../infra/exec-approvals-analysis.js";
import {
  type ExecAsk,
  type ExecHost,
  type ExecSecurity,
  loadExecApprovals,
  maxAsk,
  minSecurity,
  requireValidExecTarget,
} from "../infra/exec-approvals.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { sanitizeHostExecEnvWithDiagnostics } from "../infra/host-env-security.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import { logInfo } from "../logger.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { splitShellArgs } from "../utils/shell-argv.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { describeExecTool } from "./bash-tools.descriptions.js";
import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import { renderExecOutputText } from "./bash-tools.exec-output.js";
import {
  DEFAULT_MAX_OUTPUT,
  DEFAULT_PATH,
  DEFAULT_PENDING_MAX_OUTPUT,
  type ExecProcessOutcome,
  applyPathPrepend,
  applyShellPath,
  normalizeExecAsk,
  normalizeExecSecurity,
  normalizePathPrepend,
  resolveExecTarget,
  resolveApprovalRunningNoticeMs,
  runExecProcess,
  execSchema,
} from "./bash-tools.exec-runtime.js";
import type {
  ExecElevatedDefaults,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
import {
  buildSandboxEnv,
  clampWithDefault,
  coerceEnv,
  readEnvInt,
  resolveSandboxWorkdir,
  resolveWorkdir,
  truncateMiddle,
} from "./bash-tools.shared.js";
import { EXEC_TOOL_DISPLAY_SUMMARY } from "./tool-description-presets.js";
import { type AgentToolWithMeta, failedTextResult, textResult } from "./tools/common.js";

export type { BashSandboxConfig } from "./bash-tools.shared.js";
export type {
  ExecElevatedDefaults,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";

function buildExecForegroundResult(params: {
  outcome: ExecProcessOutcome;
  cwd?: string;
  warningText?: string;
}): AgentToolResult<ExecToolDetails> {
  const warningText = params.warningText?.trim() ? `${params.warningText}\n\n` : "";
  if (params.outcome.status === "failed") {
    return failedTextResult(`${warningText}${params.outcome.reason}`, {
      status: "failed",
      exitCode: params.outcome.exitCode ?? null,
      durationMs: params.outcome.durationMs,
      aggregated: params.outcome.aggregated,
      timedOut: params.outcome.timedOut,
      cwd: params.cwd,
    });
  }
  return textResult(`${warningText}${renderExecOutputText(params.outcome.aggregated)}`, {
    status: "completed",
    exitCode: params.outcome.exitCode,
    durationMs: params.outcome.durationMs,
    aggregated: params.outcome.aggregated,
    cwd: params.cwd,
  });
}

const PREFLIGHT_ENV_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-S",
  "-u",
  "--argv0",
  "--block-signal",
  "--chdir",
  "--default-signal",
  "--ignore-signal",
  "--split-string",
  "--unset",
]);

const SKIPPABLE_SCRIPT_PREFLIGHT_FS_ERROR_CODES = new Set([
  "EACCES",
  "EISDIR",
  "ELOOP",
  "EINVAL",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);

function getNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String((error as { code?: unknown }).code);
}

type FsSafeModule = typeof import("../infra/fs-safe.js");

const fsSafeModuleLoader = createLazyImportLoader<FsSafeModule>(
  () => import("../infra/fs-safe.js"),
);

async function loadFsSafeModule(): Promise<FsSafeModule> {
  return await fsSafeModuleLoader.load();
}

function shouldSkipScriptPreflightPathError(
  error: unknown,
  SafeOpenError: FsSafeModule["SafeOpenError"],
): boolean {
  if (error instanceof SafeOpenError) {
    return true;
  }
  const errorCode = getNodeErrorCode(error);
  return !!(errorCode && SKIPPABLE_SCRIPT_PREFLIGHT_FS_ERROR_CODES.has(errorCode));
}

function resolvePreflightRelativePath(params: { rootDir: string; absPath: string }): string | null {
  const root = path.resolve(params.rootDir);
  const candidate = path.resolve(params.absPath);
  const relative = path.relative(root, candidate);
  if (/^\.\.(?:[\\/]|$)/u.test(relative) || path.isAbsolute(relative)) {
    return null;
  }
  // Preserve literal "~" path segments under the workdir. `readFileWithinRoot`
  // expands home prefixes for relative paths, so normalize `~/...` to `./~/...`.
  return /^~(?:$|[\\/])/u.test(relative) ? `.${path.sep}${relative}` : relative;
}

type ExecPreflightScriptTarget =
  | { kind: "node"; relOrAbsPaths: string[] }
  | { kind: "python"; relOrAbsPaths: string[] }
  | { kind: "shell"; relOrAbsPaths: string[] };

function isShellEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token);
}

function isEnvExecutableToken(token: string | undefined): boolean {
  if (!token) {
    return false;
  }
  const base = normalizeOptionalLowercaseString(token.split(/[\\/]/u).at(-1)) ?? "";
  const normalizedBase = base.endsWith(".exe") ? base.slice(0, -4) : base;
  return normalizedBase === "env";
}

function stripPreflightEnvPrefix(argv: string[]): string[] {
  if (argv.length === 0) {
    return argv;
  }
  let idx = 0;
  while (idx < argv.length && isShellEnvAssignmentToken(argv[idx])) {
    idx += 1;
  }
  if (!isEnvExecutableToken(argv[idx])) {
    return argv;
  }
  idx += 1;
  while (idx < argv.length) {
    const token = argv[idx];
    if (token === "--") {
      idx += 1;
      break;
    }
    if (isShellEnvAssignmentToken(token)) {
      idx += 1;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    idx += 1;
    const option = token.split("=", 1)[0];
    if (
      PREFLIGHT_ENV_OPTIONS_WITH_VALUES.has(option) &&
      !token.includes("=") &&
      idx < argv.length
    ) {
      idx += 1;
    }
  }
  return argv.slice(idx);
}

function findFirstPythonScriptArg(tokens: string[]): string | null {
  const optionsWithSeparateValue = new Set(["-W", "-X", "-Q", "--check-hash-based-pycs"]);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      const next = tokens[i + 1];
      return normalizeLowercaseStringOrEmpty(next).endsWith(".py") ? next : null;
    }
    if (token === "-") {
      return null;
    }
    if (token === "-c" || token === "-m") {
      return null;
    }
    if ((token.startsWith("-c") || token.startsWith("-m")) && token.length > 2) {
      return null;
    }
    if (optionsWithSeparateValue.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return normalizeLowercaseStringOrEmpty(token).endsWith(".py") ? token : null;
  }
  return null;
}

function findNodeScriptArgs(tokens: string[]): string[] {
  const optionsWithSeparateValue = new Set(["-r", "--require", "--import"]);
  const preloadScripts: string[] = [];
  let entryScript: string | null = null;
  let hasInlineEvalOrPrint = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      if (!hasInlineEvalOrPrint && !entryScript) {
        const next = tokens[i + 1];
        if (normalizeLowercaseStringOrEmpty(next).endsWith(".js")) {
          entryScript = next;
        }
      }
      break;
    }
    if (
      token === "-e" ||
      token === "-p" ||
      token === "--eval" ||
      token === "--print" ||
      token.startsWith("--eval=") ||
      token.startsWith("--print=") ||
      ((token.startsWith("-e") || token.startsWith("-p")) && token.length > 2)
    ) {
      hasInlineEvalOrPrint = true;
      if (token === "-e" || token === "-p" || token === "--eval" || token === "--print") {
        i += 1;
      }
      continue;
    }
    if (optionsWithSeparateValue.has(token)) {
      const next = tokens[i + 1];
      if (normalizeLowercaseStringOrEmpty(next).endsWith(".js")) {
        preloadScripts.push(next);
      }
      i += 1;
      continue;
    }
    if (
      (token.startsWith("-r") && token.length > 2) ||
      token.startsWith("--require=") ||
      token.startsWith("--import=")
    ) {
      const inlineValue = token.startsWith("-r")
        ? token.slice(2)
        : token.slice(token.indexOf("=") + 1);
      if (normalizeLowercaseStringOrEmpty(inlineValue).endsWith(".js")) {
        preloadScripts.push(inlineValue);
      }
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    if (
      !hasInlineEvalOrPrint &&
      !entryScript &&
      normalizeLowercaseStringOrEmpty(token).endsWith(".js")
    ) {
      entryScript = token;
    }
    break;
  }
  const targets = [...preloadScripts];
  if (entryScript) {
    targets.push(entryScript);
  }
  return targets;
}

function extractInterpreterScriptTargetFromArgv(
  argv: string[] | null,
): Extract<ExecPreflightScriptTarget, { kind: "node" | "python" }> | null {
  if (!argv || argv.length === 0) {
    return null;
  }
  let commandIdx = 0;
  while (commandIdx < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(argv[commandIdx])) {
    commandIdx += 1;
  }
  const executable = normalizeOptionalLowercaseString(argv[commandIdx]);
  if (!executable) {
    return null;
  }
  const args = argv.slice(commandIdx + 1);
  if (/^python(?:3(?:\.\d+)?)?$/i.test(executable)) {
    const script = findFirstPythonScriptArg(args);
    if (script) {
      return { kind: "python", relOrAbsPaths: [script] };
    }
    return null;
  }
  if (executable === "node") {
    const scripts = findNodeScriptArgs(args);
    if (scripts.length > 0) {
      return { kind: "node", relOrAbsPaths: scripts };
    }
    return null;
  }
  return null;
}

function extractInterpreterScriptPathsFromSegment(rawSegment: string): string[] {
  const argv = splitShellArgs(rawSegment.trim());
  if (!argv || argv.length === 0) {
    return [];
  }
  const withoutLeadingKeyword = /^(?:if|then|do|elif|else|while|until|time)$/i.test(argv[0] ?? "")
    ? argv.slice(1)
    : argv;
  const target = extractInterpreterScriptTargetFromArgv(
    stripPreflightEnvPrefix(withoutLeadingKeyword),
  );
  return target?.relOrAbsPaths ?? [];
}

function extractScriptTargetFromCommand(
  command: string,
): Extract<ExecPreflightScriptTarget, { kind: "node" | "python" }> | null {
  const raw = command.trim();
  const splitShellArgsPreservingBackslashes = (value: string): string[] | null => {
    const tokens: string[] = [];
    let buf = "";
    let inSingle = false;
    let inDouble = false;

    const pushToken = () => {
      if (buf.length > 0) {
        tokens.push(buf);
        buf = "";
      }
    };

    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (inSingle) {
        if (ch === "'") {
          inSingle = false;
        } else {
          buf += ch;
        }
        continue;
      }
      if (inDouble) {
        if (ch === '"') {
          inDouble = false;
        } else {
          buf += ch;
        }
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        continue;
      }
      if (/\s/.test(ch)) {
        pushToken();
        continue;
      }
      buf += ch;
    }

    if (inSingle || inDouble) {
      return null;
    }
    pushToken();
    return tokens;
  };
  const shouldUseWindowsPathTokenizer =
    process.platform === "win32" &&
    /(?:^|[\s"'`])(?:[A-Za-z]:\\|\\\\|[^\s"'`|&;()<>]+\\[^\s"'`|&;()<>]+)/.test(raw);
  const candidateArgv = shouldUseWindowsPathTokenizer
    ? [splitShellArgsPreservingBackslashes(raw)]
    : [splitShellArgs(raw)];

  for (const argv of candidateArgv) {
    const attempts = [argv, argv ? stripPreflightEnvPrefix(argv) : null];
    for (const attempt of attempts) {
      const target = extractInterpreterScriptTargetFromArgv(attempt);
      if (target) {
        return target;
      }
    }
  }
  return null;
}

function findShellScriptArg(tokens: string[]): string | null {
  const shellOptionsWithSeparateValues = new Set([
    "-O",
    "-o",
    "--init-file",
    "--login-file",
    "--rcfile",
  ]);

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (!token) {
      continue;
    }
    if (token === "--") {
      const script = tokens[idx + 1];
      return script && script !== "-" ? script : null;
    }
    if (token === "-") {
      return null;
    }
    if (!token.startsWith("-")) {
      return token;
    }
    if (
      token === "-c" ||
      token === "--command" ||
      token === "--command-string" ||
      token === "--execute"
    ) {
      return null;
    }
    if (
      (!token.startsWith("--") && token.slice(1).includes("c")) ||
      token.startsWith("-c") ||
      token.startsWith("--command=") ||
      token.startsWith("--command-string=") ||
      token.startsWith("--execute=")
    ) {
      return null;
    }
    if (
      token === "-s" ||
      (token.startsWith("-") && !token.startsWith("--") && token.includes("s"))
    ) {
      return null;
    }

    const optionName = token.split("=", 1)[0];
    if (shellOptionsWithSeparateValues.has(optionName) && !token.includes("=")) {
      idx += 1;
      continue;
    }
    if (
      !token.startsWith("--") &&
      token.length > 2 &&
      (token.endsWith("O") || token.endsWith("o"))
    ) {
      idx += 1;
    }
  }
  return null;
}

function extractShellScriptTargetFromArgv(
  argv: string[] | null,
): Extract<ExecPreflightScriptTarget, { kind: "shell" }> | null {
  if (!argv || argv.length === 0) {
    return null;
  }
  const stripped = stripOpenClawControlCommandPrefixes(
    stripOpenClawControlLeadingRedirections(stripPreflightEnvPrefix(argv)),
  );
  if (!OPENCLAW_CONTROL_SHELL_WRAPPERS.has(normalizeCommandBaseName(stripped[0]))) {
    return null;
  }
  const script = findShellScriptArg(stripped.slice(1));
  return script ? { kind: "shell", relOrAbsPaths: [script] } : null;
}

function extractDirectShellScriptTargetFromArgv(
  argv: string[] | null,
): Extract<ExecPreflightScriptTarget, { kind: "shell" }> | null {
  if (!argv || argv.length === 0) {
    return null;
  }
  const stripped = stripOpenClawControlCommandPrefixes(
    stripOpenClawControlLeadingRedirections(stripPreflightEnvPrefix(argv)),
  );
  const command = stripped[0];
  if (!command || command.startsWith("-")) {
    return null;
  }
  const commandName = normalizeCommandBaseName(command);
  if (!/\.(?:bash|command|fish|ksh|sh|zsh)$/iu.test(commandName)) {
    return null;
  }
  return { kind: "shell", relOrAbsPaths: [command] };
}

function extractSourcedShellScriptTargetFromArgv(
  argv: string[] | null,
): Extract<ExecPreflightScriptTarget, { kind: "shell" }> | null {
  if (!argv || argv.length === 0) {
    return null;
  }
  const stripped = stripOpenClawControlCommandPrefixes(
    stripOpenClawControlLeadingRedirections(stripPreflightEnvPrefix(argv)),
  );
  const commandName = normalizeCommandBaseName(stripped[0]);
  if (commandName !== "." && commandName !== "source") {
    return null;
  }
  const script = stripped[1] === "--" ? stripped[2] : stripped[1];
  return script && script !== "-" ? { kind: "shell", relOrAbsPaths: [script] } : null;
}

function collectShellScriptTargetPathsFromArgv(argv: string[], depth: number): string[] {
  const paths: string[] = [];
  const directTargets = [
    extractShellScriptTargetFromArgv(argv),
    extractDirectShellScriptTargetFromArgv(argv),
    extractSourcedShellScriptTargetFromArgv(argv),
  ];
  for (const target of directTargets) {
    if (target) {
      paths.push(...target.relOrAbsPaths);
    }
  }

  if (depth <= 0) {
    return paths;
  }

  const stripped = stripOpenClawControlCommandPrefixes(
    stripOpenClawControlLeadingRedirections(stripPreflightEnvPrefix(argv)),
  );
  const payloads = [
    ...extractOpenClawControlEnvSplitStringPayload(argv),
    ...extractOpenClawControlShellWrapperPayload(stripped),
  ];
  for (const payload of payloads) {
    const target = extractShellScriptTargetFromCommand(payload, depth - 1);
    if (target) {
      paths.push(...target.relOrAbsPaths);
    }
  }
  return paths;
}

function extractShellScriptTargetFromCommand(
  command: string,
  depth = 4,
): Extract<ExecPreflightScriptTarget, { kind: "shell" }> | null {
  const raw = command.trim();
  const argv = splitShellArgs(raw);
  const paths: string[] = [];
  if (argv) {
    paths.push(...collectShellScriptTargetPathsFromArgv(argv, depth));
  }

  const analysis = analyzeShellCommand({ command: raw });
  const segmentArgvs = analysis.ok
    ? analysis.segments.map((segment) => segment.argv)
    : extractOpenClawControlFallbackLines(raw)
        .flatMap(splitOpenClawControlFallbackSegments)
        .map(splitShellArgs)
        .filter((segmentArgv): segmentArgv is string[] => segmentArgv !== null);
  for (const segmentArgv of segmentArgvs) {
    paths.push(...collectShellScriptTargetPathsFromArgv(segmentArgv, depth));
  }

  const uniquePaths = Array.from(new Set(paths));
  return uniquePaths.length > 0 ? { kind: "shell", relOrAbsPaths: uniquePaths } : null;
}

function extractUnquotedShellText(raw: string): string | null {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      if (!inSingle && !inDouble) {
        // Preserve escapes outside quotes so downstream heuristics can distinguish
        // escaped literals (e.g. `\|`) from executable shell operators.
        out += `\\${ch}`;
      }
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      const next = raw[i + 1];
      if (ch === "\\" && next && /[\\'"$`\n\r]/.test(next)) {
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    out += ch;
  }

  if (escaped || inSingle || inDouble) {
    return null;
  }
  return out;
}

function splitShellSegmentsOutsideQuotes(
  rawText: string,
  params: { splitPipes: boolean },
): string[] {
  const segments: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushSegment = () => {
    if (buf.trim().length > 0) {
      segments.push(buf);
    }
    buf = "";
  };

  for (let i = 0; i < rawText.length; i += 1) {
    const ch = rawText[i];
    const next = rawText[i + 1];

    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }

    if (!inSingle && ch === "\\") {
      buf += ch;
      escaped = true;
      continue;
    }

    if (inSingle) {
      buf += ch;
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      buf += ch;
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      buf += ch;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      pushSegment();
      continue;
    }
    if (ch === ";") {
      pushSegment();
      continue;
    }
    if (ch === "&" && next === "&") {
      pushSegment();
      i += 1;
      continue;
    }
    if (ch === "|" && next === "|") {
      pushSegment();
      i += 1;
      continue;
    }
    if (params.splitPipes && ch === "|") {
      pushSegment();
      continue;
    }

    buf += ch;
  }
  pushSegment();
  return segments;
}

function isInterpreterExecutable(executable: string | undefined): boolean {
  if (!executable) {
    return false;
  }
  return /^python(?:3(?:\.\d+)?)?$/i.test(executable) || executable === "node";
}

function hasUnescapedSequence(raw: string, sequence: string): boolean {
  if (sequence.length === 0) {
    return false;
  }
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (raw.startsWith(sequence, i)) {
      return true;
    }
  }
  return false;
}

function hasUnquotedScriptHint(raw: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let token = "";

  const flushToken = (): boolean => {
    const normalizedToken = normalizeLowercaseStringOrEmpty(token);
    if (normalizedToken.endsWith(".py") || normalizedToken.endsWith(".js")) {
      return true;
    }
    token = "";
    return false;
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      if (!inSingle && !inDouble) {
        token += ch;
      }
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      if (flushToken()) {
        return true;
      }
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      if (flushToken()) {
        return true;
      }
      inDouble = true;
      continue;
    }
    if (/\s/u.test(ch) || "|&;()<>".includes(ch)) {
      if (flushToken()) {
        return true;
      }
      continue;
    }
    token += ch;
  }
  return flushToken();
}

function resolveLeadingShellSegmentExecutable(rawSegment: string): string | undefined {
  const segment = (extractUnquotedShellText(rawSegment) ?? rawSegment).trim();
  const argv = splitShellArgs(segment);
  if (!argv || argv.length === 0) {
    return undefined;
  }
  const withoutLeadingKeyword = /^(?:if|then|do|elif|else|while|until|time)$/i.test(argv[0] ?? "")
    ? argv.slice(1)
    : argv;
  if (withoutLeadingKeyword.length === 0) {
    return undefined;
  }
  const normalizedArgv = stripPreflightEnvPrefix(withoutLeadingKeyword);
  let commandIdx = 0;
  while (
    commandIdx < normalizedArgv.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(normalizedArgv[commandIdx] ?? "")
  ) {
    commandIdx += 1;
  }
  return normalizeOptionalLowercaseString(normalizedArgv[commandIdx]);
}

function analyzeInterpreterHeuristicsFromUnquoted(raw: string): {
  hasPython: boolean;
  hasNode: boolean;
  hasComplexSyntax: boolean;
  hasProcessSubstitution: boolean;
  hasScriptHint: boolean;
} {
  const hasPython = splitShellSegmentsOutsideQuotes(raw, { splitPipes: true }).some((segment) =>
    /^python(?:3(?:\.\d+)?)?$/i.test(resolveLeadingShellSegmentExecutable(segment) ?? ""),
  );
  const hasNode = splitShellSegmentsOutsideQuotes(raw, { splitPipes: true }).some(
    (segment) => resolveLeadingShellSegmentExecutable(segment) === "node",
  );
  const hasProcessSubstitution = hasUnescapedSequence(raw, "<(") || hasUnescapedSequence(raw, ">(");
  const hasComplexSyntax =
    hasUnescapedSequence(raw, "|") ||
    hasUnescapedSequence(raw, "&&") ||
    hasUnescapedSequence(raw, "||") ||
    hasUnescapedSequence(raw, ";") ||
    raw.includes("\n") ||
    raw.includes("\r") ||
    hasUnescapedSequence(raw, "$(") ||
    hasUnescapedSequence(raw, "`") ||
    hasProcessSubstitution;
  const hasScriptHint = hasUnquotedScriptHint(raw);

  return { hasPython, hasNode, hasComplexSyntax, hasProcessSubstitution, hasScriptHint };
}

function extractShellWrappedCommandPayload(
  executable: string | undefined,
  args: string[],
): string | null {
  if (!executable) {
    return null;
  }
  const executableBase = normalizeOptionalLowercaseString(executable.split(/[\\/]/u).at(-1)) ?? "";
  const normalizedExecutable = executableBase.endsWith(".exe")
    ? executableBase.slice(0, -4)
    : executableBase;
  if (!/^(?:bash|dash|fish|ksh|sh|zsh)$/i.test(normalizedExecutable)) {
    return null;
  }
  const shortOptionsWithSeparateValue = new Set(["-O", "-o"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      return null;
    }
    if (arg === "-c") {
      return args[i + 1] ?? null;
    }
    if (/^-[A-Za-z]+$/u.test(arg)) {
      if (arg.includes("c")) {
        return args[i + 1] ?? null;
      }
      if (shortOptionsWithSeparateValue.has(arg)) {
        i += 1;
      }
      continue;
    }
    if (/^--[A-Za-z0-9][A-Za-z0-9-]*(?:=.*)?$/u.test(arg)) {
      if (!arg.includes("=")) {
        const next = args[i + 1];
        if (next && next !== "--" && !next.startsWith("-")) {
          i += 1;
        }
      }
      continue;
    }
    return null;
  }
  return null;
}

function shouldFailClosedInterpreterPreflight(command: string): {
  hasInterpreterInvocation: boolean;
  hasComplexSyntax: boolean;
  hasProcessSubstitution: boolean;
  hasInterpreterSegmentScriptHint: boolean;
  hasInterpreterPipelineScriptHint: boolean;
  isDirectInterpreterCommand: boolean;
} {
  const raw = command.trim();
  const rawArgv = splitShellArgs(raw);
  const argv = rawArgv ? stripPreflightEnvPrefix(rawArgv) : null;
  let commandIdx = 0;
  if (argv) {
    while (
      commandIdx < argv.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(argv[commandIdx] ?? "")
    ) {
      commandIdx += 1;
    }
  }
  const directExecutable = normalizeOptionalLowercaseString(argv?.[commandIdx]);
  const args = argv ? argv.slice(commandIdx + 1) : [];

  const isDirectPythonExecutable = Boolean(
    directExecutable && /^python(?:3(?:\.\d+)?)?$/i.test(directExecutable),
  );
  const isDirectNodeExecutable = directExecutable === "node";
  const isDirectInterpreterCommand = isDirectPythonExecutable || isDirectNodeExecutable;

  const unquotedRaw = extractUnquotedShellText(raw) ?? raw;
  const topLevel = analyzeInterpreterHeuristicsFromUnquoted(unquotedRaw);

  const shellWrappedPayload = extractShellWrappedCommandPayload(directExecutable, args);
  const nestedUnquoted = shellWrappedPayload
    ? (extractUnquotedShellText(shellWrappedPayload) ?? shellWrappedPayload)
    : "";
  const nested = shellWrappedPayload
    ? analyzeInterpreterHeuristicsFromUnquoted(nestedUnquoted)
    : {
        hasPython: false,
        hasNode: false,
        hasComplexSyntax: false,
        hasProcessSubstitution: false,
        hasScriptHint: false,
      };
  const hasInterpreterInvocationInSegment = (rawSegment: string): boolean =>
    isInterpreterExecutable(resolveLeadingShellSegmentExecutable(rawSegment));
  const isScriptExecutingInterpreterCommand = (rawCommand: string): boolean => {
    const argv = splitShellArgs(rawCommand.trim());
    if (!argv || argv.length === 0) {
      return false;
    }
    const withoutLeadingKeyword = /^(?:if|then|do|elif|else|while|until|time)$/i.test(argv[0] ?? "")
      ? argv.slice(1)
      : argv;
    if (withoutLeadingKeyword.length === 0) {
      return false;
    }
    const normalizedArgv = stripPreflightEnvPrefix(withoutLeadingKeyword);
    let commandIdx = 0;
    while (
      commandIdx < normalizedArgv.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(normalizedArgv[commandIdx] ?? "")
    ) {
      commandIdx += 1;
    }
    const executable = normalizeOptionalLowercaseString(normalizedArgv[commandIdx]);
    if (!executable) {
      return false;
    }
    const args = normalizedArgv.slice(commandIdx + 1);

    if (/^python(?:3(?:\.\d+)?)?$/i.test(executable)) {
      const pythonInfoOnlyFlags = new Set(["-V", "--version", "-h", "--help"]);
      if (args.some((arg) => pythonInfoOnlyFlags.has(arg))) {
        return false;
      }
      if (
        args.some(
          (arg) =>
            arg === "-c" ||
            arg === "-m" ||
            arg.startsWith("-c") ||
            arg.startsWith("-m") ||
            arg === "--check-hash-based-pycs",
        )
      ) {
        return false;
      }
      return true;
    }

    if (executable === "node") {
      const nodeInfoOnlyFlags = new Set(["-v", "--version", "-h", "--help", "-c", "--check"]);
      if (args.some((arg) => nodeInfoOnlyFlags.has(arg))) {
        return false;
      }
      if (
        args.some(
          (arg) =>
            arg === "-e" ||
            arg === "-p" ||
            arg === "--eval" ||
            arg === "--print" ||
            arg.startsWith("--eval=") ||
            arg.startsWith("--print=") ||
            ((arg.startsWith("-e") || arg.startsWith("-p")) && arg.length > 2),
        )
      ) {
        return false;
      }
      return true;
    }

    return false;
  };
  const hasScriptHintInSegment = (segment: string): boolean =>
    extractInterpreterScriptPathsFromSegment(segment).length > 0 || hasUnquotedScriptHint(segment);
  const hasInterpreterAndScriptHintInSameSegment = (rawText: string): boolean => {
    const segments = splitShellSegmentsOutsideQuotes(rawText, { splitPipes: true });
    return segments.some((segment) => {
      if (!isScriptExecutingInterpreterCommand(segment)) {
        return false;
      }
      return hasScriptHintInSegment(segment);
    });
  };
  const hasInterpreterPipelineScriptHintInSameSegment = (rawText: string): boolean => {
    const commandSegments = splitShellSegmentsOutsideQuotes(rawText, { splitPipes: false });
    return commandSegments.some((segment) => {
      const pipelineCommands = splitShellSegmentsOutsideQuotes(segment, { splitPipes: true });
      const hasScriptExecutingPipedInterpreter = pipelineCommands
        .slice(1)
        .some((pipelineCommand) => isScriptExecutingInterpreterCommand(pipelineCommand));
      if (!hasScriptExecutingPipedInterpreter) {
        return false;
      }
      return hasScriptHintInSegment(segment);
    });
  };
  const hasInterpreterSegmentScriptHint =
    hasInterpreterAndScriptHintInSameSegment(raw) ||
    (shellWrappedPayload !== null && hasInterpreterAndScriptHintInSameSegment(shellWrappedPayload));
  const hasInterpreterPipelineScriptHint =
    hasInterpreterPipelineScriptHintInSameSegment(raw) ||
    (shellWrappedPayload !== null &&
      hasInterpreterPipelineScriptHintInSameSegment(shellWrappedPayload));
  const hasShellWrappedInterpreterSegmentScriptHint =
    shellWrappedPayload !== null && hasInterpreterAndScriptHintInSameSegment(shellWrappedPayload);
  const hasShellWrappedInterpreterInvocation =
    (nested.hasPython || nested.hasNode) &&
    (hasShellWrappedInterpreterSegmentScriptHint ||
      nested.hasScriptHint ||
      nested.hasComplexSyntax ||
      nested.hasProcessSubstitution);
  const hasTopLevelInterpreterInvocation = splitShellSegmentsOutsideQuotes(raw, {
    splitPipes: true,
  }).some((segment) => hasInterpreterInvocationInSegment(segment));
  const hasInterpreterInvocation =
    isDirectInterpreterCommand ||
    hasShellWrappedInterpreterInvocation ||
    hasTopLevelInterpreterInvocation;

  return {
    hasInterpreterInvocation,
    hasComplexSyntax: topLevel.hasComplexSyntax || hasShellWrappedInterpreterInvocation,
    hasProcessSubstitution: topLevel.hasProcessSubstitution || nested.hasProcessSubstitution,
    hasInterpreterSegmentScriptHint,
    hasInterpreterPipelineScriptHint,
    isDirectInterpreterCommand,
  };
}

async function validateScriptFileForShellBleed(params: {
  command: string;
  skipLanguageHeuristics?: boolean;
  workdir: string;
}): Promise<void> {
  const targets = [
    ...(params.skipLanguageHeuristics ? [] : [extractScriptTargetFromCommand(params.command)]),
    extractShellScriptTargetFromCommand(params.command),
  ].filter((target): target is ExecPreflightScriptTarget => target !== null);
  if (targets.length === 0) {
    if (params.skipLanguageHeuristics) {
      return;
    }
    const {
      hasInterpreterInvocation,
      hasComplexSyntax,
      hasProcessSubstitution,
      hasInterpreterSegmentScriptHint,
      hasInterpreterPipelineScriptHint,
      isDirectInterpreterCommand,
    } = shouldFailClosedInterpreterPreflight(params.command);
    if (
      hasInterpreterInvocation &&
      hasComplexSyntax &&
      (hasInterpreterSegmentScriptHint ||
        hasInterpreterPipelineScriptHint ||
        (hasProcessSubstitution && isDirectInterpreterCommand))
    ) {
      // Fail closed when interpreter-driven script execution is ambiguous; otherwise
      // attackers can route script content through forms our fast parser cannot validate.
      throw new Error(
        "exec preflight: complex interpreter invocation detected; refusing to run without script preflight validation. " +
          "Use a direct `python <file>.py` or `node <file>.js` command.",
      );
    }
    return;
  }

  const { SafeOpenError, readFileWithinRoot } = await loadFsSafeModule();
  for (const target of targets) {
    for (const relOrAbsPath of target.relOrAbsPaths) {
      const absPath = path.isAbsolute(relOrAbsPath)
        ? path.resolve(relOrAbsPath)
        : path.resolve(params.workdir, relOrAbsPath);
      const relativePath = resolvePreflightRelativePath({
        rootDir: params.workdir,
        absPath,
      });
      const scriptRootDir =
        target.kind === "shell" && !relativePath ? path.dirname(absPath) : params.workdir;
      const scriptRelativePath =
        target.kind === "shell" && !relativePath ? path.basename(absPath) : relativePath;
      if (!scriptRelativePath) {
        continue;
      }

      // Best-effort: validate safely resolved script files that are reasonably
      // small. This keeps preflight checks on a pinned file identity instead of
      // trusting mutable pathnames across multiple ops.
      // Use non-blocking open to avoid stalls if a path is swapped to a FIFO.
      let content: string;
      try {
        const safeRead = await readFileWithinRoot({
          rootDir: scriptRootDir,
          relativePath: scriptRelativePath,
          nonBlockingRead: true,
          allowSymlinkTargetWithinRoot: true,
          maxBytes: 512 * 1024,
        });
        content = safeRead.buffer.toString("utf-8");
      } catch (error) {
        if (shouldSkipScriptPreflightPathError(error, SafeOpenError)) {
          // Preflight validation is best-effort: skip path/read failures and
          // continue to execute the command normally.
          continue;
        }
        throw error;
      }

      if (target.kind === "shell") {
        if (parseOpenClawMessageDeliveryShellCommand(content)) {
          throw new Error(OPENCLAW_MESSAGE_DELIVERY_EXEC_ERROR);
        }
        continue;
      }

      // Common failure mode: shell env var syntax leaking into Python/JS.
      // We deliberately match all-caps/underscore vars to avoid false positives with `$` as a JS identifier.
      const envVarRegex = /\$[A-Z_][A-Z0-9_]{1,}/g;
      const first = envVarRegex.exec(content);
      if (first) {
        const idx = first.index;
        const before = content.slice(0, idx);
        const line = before.split("\n").length;
        const token = first[0];
        throw new Error(
          [
            `exec preflight: detected likely shell variable injection (${token}) in ${target.kind} script: ${path.basename(
              absPath,
            )}:${line}.`,
            target.kind === "python"
              ? `In Python, use os.environ.get(${JSON.stringify(token.slice(1))}) instead of raw ${token}.`
              : `In Node.js, use process.env[${JSON.stringify(token.slice(1))}] instead of raw ${token}.`,
            "(If this is inside a string literal on purpose, escape it or restructure the code.)",
          ].join("\n"),
        );
      }

      // Another recurring pattern from the issue: shell commands accidentally emitted as JS.
      if (target.kind === "node") {
        const firstNonEmpty = content
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0);
        if (firstNonEmpty && /^NODE\b/.test(firstNonEmpty)) {
          throw new Error(
            `exec preflight: JS file starts with shell syntax (${firstNonEmpty}). ` +
              `This looks like a shell command, not JavaScript.`,
          );
        }
      }
    }
  }
}

function shouldSkipExecScriptPreflight(params: {
  host: ExecHost;
  security: ExecSecurity;
  ask: ExecAsk;
}): boolean {
  return params.host === "gateway" && params.security === "full" && params.ask === "off";
}

type ParsedExecApprovalCommand = {
  approvalId: string;
  decision: "allow-once" | "allow-always" | "deny";
};

function parseExecApprovalShellCommand(raw: string): ParsedExecApprovalCommand | null {
  const normalized = raw.trimStart();
  const match = normalized.match(
    /^\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|always|deny)\b/i,
  );
  if (!match) {
    return null;
  }
  return {
    approvalId: match[1],
    decision:
      normalizeLowercaseStringOrEmpty(match[2]) === "always"
        ? "allow-always"
        : (normalizeLowercaseStringOrEmpty(match[2]) as ParsedExecApprovalCommand["decision"]),
  };
}

function normalizeCommandBaseName(token: string | undefined): string {
  if (!token) {
    return "";
  }
  const base = normalizeLowercaseStringOrEmpty(token.split(/[\\/]/u).at(-1));
  return base
    .replace(/^[({]+/u, "")
    .replace(/[)}]+$/u, "")
    .replace(/\.(?:cmd|exe)$/u, "");
}

const OPENCLAW_CONTROL_SHELL_KEYWORD_PREFIXES = new Set([
  "if",
  "then",
  "do",
  "elif",
  "else",
  "while",
  "until",
  "time",
  "{",
  "(",
  "!",
]);

const OPENCLAW_PACKAGE_RUNNERS = new Set(["bun", "pnpm", "npm", "yarn"]);
const OPENCLAW_PACKAGE_RUNNER_SUBCOMMANDS = new Set(["dlx", "exec", "run", "run-script", "x"]);
const PACKAGE_RUNNER_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-F",
  "-p",
  "--cache",
  "--cache-dir",
  "--config",
  "--cwd",
  "--dir",
  "--filter",
  "--filter-prod",
  "--modules-folder",
  "--package",
  "--prefix",
  "--registry",
  "--reporter",
  "--store-dir",
  "--userconfig",
  "--loglevel",
]);

function packageRunnerOptionTakesValue(runner: string, optionName: string): boolean {
  if ((optionName === "-w" || optionName === "--workspace") && runner === "npm") {
    return true;
  }
  return PACKAGE_RUNNER_OPTIONS_WITH_VALUES.has(optionName);
}

function isPackageRunnerCommandBoundary(token: string | undefined): boolean {
  const commandName = normalizeCommandBaseName(token);
  return (
    commandName === "openclaw" ||
    OPENCLAW_PACKAGE_RUNNER_SUBCOMMANDS.has(token ?? "") ||
    token === "workspace"
  );
}

function skipPackageRunnerOptions(argv: string[], startIndex: number, runner: string): number {
  let idx = startIndex;
  while (idx < argv.length) {
    const token = argv[idx];
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      return idx + 1;
    }
    if (!token.startsWith("-") || token === "-") {
      return idx;
    }
    const optionName = token.split("=", 1)[0];
    idx += 1;
    if (
      packageRunnerOptionTakesValue(runner, optionName) &&
      !token.includes("=") &&
      idx < argv.length
    ) {
      idx += 1;
      continue;
    }
    if (
      !token.includes("=") &&
      argv[idx] &&
      !argv[idx].startsWith("-") &&
      isPackageRunnerCommandBoundary(argv[idx + 1])
    ) {
      idx += 1;
    }
  }
  return idx;
}

function collectPackageRunnerCallPayloads(
  argv: string[],
  startIndex: number,
  runner: string,
): string[] {
  const payloads: string[] = [];
  for (let idx = startIndex; idx < argv.length; idx += 1) {
    const token = argv[idx];
    if (!token) {
      continue;
    }
    if (token === "--") {
      break;
    }
    if (token === "-c" || token === "--call") {
      const payload = argv[idx + 1];
      if (payload?.trim()) {
        payloads.push(payload);
      }
      idx += 1;
      continue;
    }
    if (token.startsWith("--call=")) {
      const payload = token.slice("--call=".length);
      if (payload.trim()) {
        payloads.push(payload);
      }
      continue;
    }
    if (token.startsWith("-c") && token.length > 2) {
      const payload = token.slice(2);
      if (payload.trim()) {
        payloads.push(payload);
      }
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    const optionName = token.split("=", 1)[0];
    if (packageRunnerOptionTakesValue(runner, optionName) && !token.includes("=")) {
      idx += 1;
    }
  }
  return payloads;
}

function extractPackageRunnerShellPayloads(argv: string[]): string[] {
  const commandName = normalizeCommandBaseName(argv[0]);
  if (commandName === "corepack") {
    return extractPackageRunnerShellPayloads(argv.slice(1));
  }
  if (commandName === "npx" || commandName === "pnpx") {
    return collectPackageRunnerCallPayloads(argv, 1, "npm");
  }
  if (commandName === "pnpm") {
    const beforeSubcommand = scanPnpmShellModeOptions(argv, 1);
    const subcommand = argv[beforeSubcommand.idx];
    if (subcommand !== "exec") {
      return [];
    }
    const afterSubcommand = scanPnpmShellModeOptions(argv, beforeSubcommand.idx + 1);
    if (!beforeSubcommand.shellMode && !afterSubcommand.shellMode) {
      return [];
    }
    const payloadArgv = argv.slice(afterSubcommand.idx).filter((token) => token !== "--");
    const payload = payloadArgv.length === 1 ? payloadArgv[0] : payloadArgv.join(" ");
    return payload.trim() ? [payload] : [];
  }
  if (commandName !== "npm") {
    return [];
  }
  const idx = skipPackageRunnerOptions(argv, 1, commandName);
  const subcommand = argv[idx];
  if (subcommand !== "exec" && subcommand !== "x") {
    return [];
  }
  return collectPackageRunnerCallPayloads(argv, idx + 1, commandName);
}

function isOpenClawCliEntrypoint(token: string | undefined): boolean {
  const commandName = normalizeCommandBaseName(token);
  return (
    commandName === "openclaw" ||
    commandName.startsWith("openclaw@") ||
    commandName === "openclaw.mjs" ||
    commandName === "entry.js" ||
    commandName === "entry.mjs"
  );
}

function normalizeOpenClawPackageRunnerArgv(argv: string[]): string[] {
  const normalizedArgv = isOpenClawCliEntrypoint(argv[0]) ? ["openclaw", ...argv.slice(1)] : argv;
  return normalizedArgv[1] === "--"
    ? [normalizedArgv[0], ...normalizedArgv.slice(2)]
    : normalizedArgv;
}

function normalizeOpenClawPackageRunnerCommandArgv(argv: string[]): string[] | null {
  const normalizedArgv = stripOpenClawCliLauncher(argv);
  return normalizeCommandBaseName(normalizedArgv[0]) === "openclaw" ? normalizedArgv : null;
}

function stripOpenClawCliLauncher(argv: string[]): string[] {
  if (isOpenClawCliEntrypoint(argv[0])) {
    return normalizeOpenClawPackageRunnerArgv(argv);
  }

  const commandName = normalizeCommandBaseName(argv[0]);
  if (commandName !== "node") {
    return argv;
  }

  let idx = 1;
  const nodeOptionsWithValues = new Set([
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "--env-file",
  ]);
  while (idx < argv.length) {
    const token = argv[idx];
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    const optionName = token.split("=", 1)[0];
    idx += 1;
    if (nodeOptionsWithValues.has(optionName) && !token.includes("=")) {
      idx += 1;
    }
  }

  if (isOpenClawCliEntrypoint(argv[idx])) {
    return normalizeOpenClawPackageRunnerArgv(["openclaw", ...argv.slice(idx + 1)]);
  }
  return argv;
}

function scanPnpmShellModeOptions(
  argv: string[],
  startIndex: number,
): { idx: number; shellMode: boolean } {
  let idx = startIndex;
  let shellMode = false;
  while (idx < argv.length) {
    const token = argv[idx];
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      return { idx: idx + 1, shellMode };
    }
    if (!token.startsWith("-") || token === "-") {
      return { idx, shellMode };
    }
    const optionName = token.split("=", 1)[0];
    if (optionName === "-c" || optionName === "--shell-mode") {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : "";
      shellMode = value !== "false" && value !== "0";
      idx += 1;
      continue;
    }
    idx += 1;
    if (packageRunnerOptionTakesValue("pnpm", optionName) && !token.includes("=")) {
      idx += 1;
    }
  }
  return { idx, shellMode };
}

function stripOpenClawPackageRunner(argv: string[]): string[] {
  const commandName = normalizeCommandBaseName(argv[0]);
  if (commandName === "openclaw") {
    return argv;
  }
  if (commandName === "corepack") {
    return stripOpenClawPackageRunner(argv.slice(1));
  }
  if (OPENCLAW_PACKAGE_RUNNERS.has(commandName)) {
    let idx = skipPackageRunnerOptions(argv, 1, commandName);
    const directCommand = normalizeOpenClawPackageRunnerCommandArgv(argv.slice(idx));
    if (directCommand) {
      return directCommand;
    }
    const subcommand = argv[idx];
    if (commandName === "yarn" && subcommand === "workspace" && argv[idx + 1]) {
      idx = skipPackageRunnerOptions(argv, idx + 2, commandName);
      const workspaceCommand = normalizeOpenClawPackageRunnerCommandArgv(argv.slice(idx));
      if (workspaceCommand) {
        return workspaceCommand;
      }
    }
    if (subcommand && OPENCLAW_PACKAGE_RUNNER_SUBCOMMANDS.has(subcommand)) {
      idx = skipPackageRunnerOptions(argv, idx + 1, commandName);
      const subcommandCommand = normalizeOpenClawPackageRunnerCommandArgv(argv.slice(idx));
      if (subcommandCommand) {
        return subcommandCommand;
      }
    }
  }
  if (commandName === "npx" || commandName === "pnpx" || commandName === "bunx") {
    let idx = 1;
    while (idx < argv.length) {
      const token = argv[idx];
      if (token === "--") {
        idx += 1;
        break;
      }
      if (!token.startsWith("-") || token === "-") {
        break;
      }
      idx += 1;
      if ((token === "-p" || token === "--package") && idx < argv.length) {
        idx += 1;
      }
    }
    const packageCommand = normalizeOpenClawPackageRunnerCommandArgv(argv.slice(idx));
    if (packageCommand) {
      return packageCommand;
    }
  }
  return argv;
}

function stripOpenClawRootOptions(argv: string[]): string[] {
  if (normalizeCommandBaseName(argv[0]) !== "openclaw") {
    return argv;
  }
  const out = [argv[0]];
  const args = argv.slice(1);
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      out.push(...(out.length === 1 ? args.slice(idx + 1) : [arg, ...args.slice(idx + 1)]));
      break;
    }
    const consumed = consumeRootOptionToken(args, idx);
    if (consumed > 0) {
      idx += consumed - 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

type OpenClawControlShellCommandCandidate = { raw: string; argv?: string[] };

const OPENCLAW_CONTROL_SHELL_WRAPPERS = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
const OPENCLAW_CONTROL_COMMAND_STANDALONE_OPTIONS = new Set(["-p", "-v", "-V"]);
const OPENCLAW_CONTROL_ENV_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-S",
  "-u",
  "--argv0",
  "--block-signal",
  "--chdir",
  "--default-signal",
  "--ignore-signal",
  "--split-string",
  "--unset",
]);
const OPENCLAW_CONTROL_EXEC_OPTIONS_WITH_VALUES = new Set(["-a"]);
const OPENCLAW_CONTROL_EXEC_STANDALONE_OPTIONS = new Set(["-c", "-l"]);
const OPENCLAW_CONTROL_SUDO_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-D",
  "-g",
  "-p",
  "-R",
  "-T",
  "-U",
  "-u",
  "--chdir",
  "--close-from",
  "--group",
  "--host",
  "--other-user",
  "--prompt",
  "--role",
  "--type",
  "--user",
]);
const OPENCLAW_CONTROL_SUDO_STANDALONE_OPTIONS = new Set([
  "-A",
  "-E",
  "--askpass",
  "--preserve-env",
]);
const OPENCLAW_CONTROL_SUDO_CLUSTER_VALUE_OPTIONS = new Set([
  "C",
  "D",
  "g",
  "h",
  "p",
  "R",
  "T",
  "U",
  "u",
]);

function openClawControlSudoClusterConsumesNext(option: string): boolean {
  if (!option.startsWith("-") || option.startsWith("--") || option.length <= 2) {
    return false;
  }
  const lastFlag = option.at(-1);
  return Boolean(lastFlag && OPENCLAW_CONTROL_SUDO_CLUSTER_VALUE_OPTIONS.has(lastFlag));
}

const isOpenClawControlEnvAssignmentToken = (token: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token);

function extractOpenClawControlEnvSplitStringPayload(argv: string[]): string[] {
  const remaining = [...argv];
  while (remaining.length > 0) {
    while (remaining[0] && isOpenClawControlEnvAssignmentToken(remaining[0])) {
      remaining.shift();
    }
    const token = remaining[0];
    const commandName = normalizeCommandBaseName(token);
    if (!token || commandName === "env") {
      break;
    }
    if (commandName === "command" || commandName === "builtin") {
      remaining.shift();
      while (remaining[0]?.startsWith("-")) {
        const option = remaining.shift()!;
        if (option === "--") {
          break;
        }
        if (!OPENCLAW_CONTROL_COMMAND_STANDALONE_OPTIONS.has(option.split("=", 1)[0])) {
          continue;
        }
      }
      continue;
    }
    if (commandName === "exec") {
      remaining.shift();
      while (remaining[0]?.startsWith("-")) {
        const option = remaining.shift()!;
        if (option === "--") {
          break;
        }
        const normalized = option.split("=", 1)[0];
        if (OPENCLAW_CONTROL_EXEC_STANDALONE_OPTIONS.has(normalized)) {
          continue;
        }
        if (
          OPENCLAW_CONTROL_EXEC_OPTIONS_WITH_VALUES.has(normalized) &&
          !option.includes("=") &&
          remaining[0]
        ) {
          remaining.shift();
        }
      }
      continue;
    }
    if (commandName === "sudo") {
      remaining.shift();
      while (remaining[0]?.startsWith("-")) {
        const option = remaining.shift()!;
        if (option === "--") {
          break;
        }
        const normalized = option.split("=", 1)[0];
        if (OPENCLAW_CONTROL_SUDO_STANDALONE_OPTIONS.has(normalized)) {
          continue;
        }
        if (openClawControlSudoClusterConsumesNext(option) && remaining[0]) {
          remaining.shift();
          continue;
        }
        if (
          OPENCLAW_CONTROL_SUDO_OPTIONS_WITH_VALUES.has(normalized) &&
          !option.includes("=") &&
          remaining[0]
        ) {
          remaining.shift();
        }
      }
      continue;
    }
    break;
  }
  if (normalizeCommandBaseName(remaining[0]) !== "env") {
    return [];
  }
  remaining.shift();
  const payloads: string[] = [];
  const takeSplitStringPayload = (option: string): string | undefined => {
    if (option === "-S" || option === "--split-string") {
      return remaining.shift();
    }
    if (option.startsWith("--split-string=")) {
      return option.slice("--split-string=".length);
    }
    if (!option.startsWith("--")) {
      const splitIndex = option.indexOf("S");
      if (splitIndex > 0) {
        return option.slice(splitIndex + 1) || remaining.shift();
      }
    }
    return undefined;
  };
  while (remaining.length > 0) {
    while (remaining[0] && isOpenClawControlEnvAssignmentToken(remaining[0])) {
      remaining.shift();
    }
    const token: string | undefined = remaining[0];
    if (!token) {
      break;
    }
    if (token === "--") {
      remaining.shift();
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    const option = remaining.shift()!;
    const normalized = option.split("=", 1)[0];
    const splitString = takeSplitStringPayload(option);
    if (splitString !== undefined) {
      const value = [splitString, ...remaining].filter((part) => part.length > 0).join(" ");
      if (value?.trim()) {
        payloads.push(value);
      }
      break;
    }
    if (
      OPENCLAW_CONTROL_ENV_OPTIONS_WITH_VALUES.has(normalized) &&
      !option.includes("=") &&
      remaining[0]
    ) {
      remaining.shift();
    }
  }
  return payloads;
}

function stripOpenClawControlCommandPrefixes(argv: string[]): string[] {
  const remaining = [...argv];
  while (remaining.length > 0) {
    while (remaining[0] && isOpenClawControlEnvAssignmentToken(remaining[0])) {
      remaining.shift();
    }

    const token = remaining[0];
    if (!token) {
      break;
    }
    if (token === "--") {
      remaining.shift();
      continue;
    }
    const commandName = normalizeCommandBaseName(token);
    if (commandName === "env") {
      remaining.shift();
      while (remaining.length > 0) {
        while (remaining[0] && isOpenClawControlEnvAssignmentToken(remaining[0])) {
          remaining.shift();
        }
        const envToken = remaining[0];
        if (!envToken) {
          break;
        }
        if (envToken === "--") {
          remaining.shift();
          continue;
        }
        if (!envToken.startsWith("-") || envToken === "-") {
          break;
        }
        const option = remaining.shift()!;
        const normalized = option.split("=", 1)[0];
        if (
          OPENCLAW_CONTROL_ENV_OPTIONS_WITH_VALUES.has(normalized) &&
          !option.includes("=") &&
          remaining[0]
        ) {
          remaining.shift();
        }
      }
      continue;
    }
    if (commandName === "command" || commandName === "builtin") {
      remaining.shift();
      while (remaining[0]?.startsWith("-")) {
        const option = remaining.shift()!;
        if (option === "--") {
          break;
        }
        if (!OPENCLAW_CONTROL_COMMAND_STANDALONE_OPTIONS.has(option.split("=", 1)[0])) {
          continue;
        }
      }
      continue;
    }
    if (commandName === "exec") {
      remaining.shift();
      while (remaining[0]?.startsWith("-")) {
        const option = remaining.shift()!;
        if (option === "--") {
          break;
        }
        const normalized = option.split("=", 1)[0];
        if (OPENCLAW_CONTROL_EXEC_STANDALONE_OPTIONS.has(normalized)) {
          continue;
        }
        if (
          OPENCLAW_CONTROL_EXEC_OPTIONS_WITH_VALUES.has(normalized) &&
          !option.includes("=") &&
          remaining[0]
        ) {
          remaining.shift();
        }
      }
      continue;
    }
    if (commandName === "sudo") {
      remaining.shift();
      while (remaining[0]?.startsWith("-")) {
        const option = remaining.shift()!;
        if (option === "--") {
          break;
        }
        const normalized = option.split("=", 1)[0];
        if (OPENCLAW_CONTROL_SUDO_STANDALONE_OPTIONS.has(normalized)) {
          continue;
        }
        if (openClawControlSudoClusterConsumesNext(option) && remaining[0]) {
          remaining.shift();
          continue;
        }
        if (
          OPENCLAW_CONTROL_SUDO_OPTIONS_WITH_VALUES.has(normalized) &&
          !option.includes("=") &&
          remaining[0]
        ) {
          remaining.shift();
        }
      }
      continue;
    }
    break;
  }
  return remaining;
}

function classifyOpenClawControlLeadingRedirection(
  token: string | undefined,
): "attached" | "standalone" | null {
  if (!token || token.startsWith("<(") || token.startsWith(">(")) {
    return null;
  }
  const redirectionOperator = "(?:\\d+)?(?:<>|<<-?|<<<|>>|>\\||>|<|<&|>&)|&>>|&>";
  if (new RegExp(`^(?:${redirectionOperator})$`, "u").test(token)) {
    return "standalone";
  }
  if (new RegExp(`^(?:${redirectionOperator}).+`, "u").test(token)) {
    return "attached";
  }
  return null;
}

function stripOpenClawControlLeadingRedirections(argv: string[]): string[] {
  let idx = 0;
  while (idx < argv.length) {
    const redirection = classifyOpenClawControlLeadingRedirection(argv[idx]);
    if (!redirection) {
      break;
    }
    idx += redirection === "standalone" && idx + 1 < argv.length ? 2 : 1;
  }
  return idx > 0 ? argv.slice(idx) : argv;
}

function extractOpenClawControlShellWrapperPayload(argv: string[]): string[] {
  const [commandName, ...rest] = argv;
  const normalizedCommandName = normalizeCommandBaseName(commandName);
  if (normalizedCommandName === "cmd") {
    for (let i = 0; i < rest.length; i += 1) {
      const token = normalizeLowercaseStringOrEmpty(rest[i]);
      if (token === "/c" || token === "/k") {
        const payload = rest.slice(i + 1).join(" ");
        return payload.trim() ? [payload] : [];
      }
    }
    return [];
  }
  if (normalizedCommandName === "powershell" || normalizedCommandName === "pwsh") {
    for (let i = 0; i < rest.length; i += 1) {
      const token = normalizeLowercaseStringOrEmpty(rest[i]);
      if (token === "-command" || token === "-commandwithargs" || token === "-c") {
        const payload = rest.slice(i + 1).join(" ");
        return payload.trim() ? [payload] : [];
      }
    }
    return [];
  }
  if (!commandName || !OPENCLAW_CONTROL_SHELL_WRAPPERS.has(normalizedCommandName)) {
    return [];
  }
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token) {
      continue;
    }
    if (token === "-c" || token === "-lc" || token === "-ic" || token === "-xc") {
      return rest[i + 1] ? [rest[i + 1]] : [];
    }
    if (/^-[^-]*c[^-]*$/u.test(token)) {
      return rest[i + 1] ? [rest[i + 1]] : [];
    }
  }
  return [];
}

function extractOpenClawControlEvalPayload(argv: string[]): string[] {
  const [commandName, ...rest] = argv;
  if (normalizeCommandBaseName(commandName) !== "eval") {
    return [];
  }
  const payloadArgv = rest[0] === "--" ? rest.slice(1) : rest;
  const payload = payloadArgv.join(" ");
  return payload.trim() ? [payload] : [];
}

function buildOpenClawControlCandidatesFromArgv(
  argv: string[],
): OpenClawControlShellCommandCandidate[] {
  const firstToken = argv[0] ?? "";
  const shellKeywordCandidates =
    OPENCLAW_CONTROL_SHELL_KEYWORD_PREFIXES.has(firstToken) ||
    OPENCLAW_CONTROL_SHELL_KEYWORD_PREFIXES.has(normalizeCommandBaseName(firstToken))
      ? buildOpenClawControlCandidatesFromArgv(argv.slice(1))
      : [];
  const envSplitCandidates = extractOpenClawControlEnvSplitStringPayload(argv).flatMap(
    (payload) => {
      const innerArgv = splitShellArgs(payload);
      return innerArgv ? buildOpenClawControlCandidatesFromArgv(innerArgv) : [{ raw: payload }];
    },
  );
  const prefixStripped = stripOpenClawControlCommandPrefixes(argv);
  const redirectionStripped = stripOpenClawControlLeadingRedirections(prefixStripped);
  const redirectionCandidates =
    redirectionStripped === prefixStripped
      ? []
      : buildOpenClawControlCandidatesFromArgv(redirectionStripped);
  const stripped = stripOpenClawControlCommandPrefixes(redirectionStripped);
  const shellWrapperCandidates = extractOpenClawControlShellWrapperPayload(stripped).flatMap(
    (payload) => {
      const innerArgv = splitShellArgs(payload);
      return innerArgv ? buildOpenClawControlCandidatesFromArgv(innerArgv) : [{ raw: payload }];
    },
  );
  const evalCandidates = extractOpenClawControlEvalPayload(stripped).flatMap((payload) => {
    const innerArgv = splitShellArgs(payload);
    return innerArgv ? buildOpenClawControlCandidatesFromArgv(innerArgv) : [{ raw: payload }];
  });
  return [
    ...(stripped.length > 0 ? [{ raw: stripped.join(" "), argv: stripped }] : []),
    ...shellKeywordCandidates,
    ...envSplitCandidates,
    ...redirectionCandidates,
    ...shellWrapperCandidates,
    ...evalCandidates,
  ];
}

function extractOpenClawControlHeredocsFromLine(
  line: string,
): { delimiter: string; stripTabs: boolean; startIndex: number; quoted: boolean }[] {
  const specs: { delimiter: string; stripTabs: boolean; startIndex: number; quoted: boolean }[] =
    [];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/u.test(line[i - 1] ?? ""))) {
      break;
    }
    if (ch !== "<" || next !== "<" || line[i + 2] === "<") {
      continue;
    }

    const startIndex = i;
    let scanIndex = i + 2;
    let stripTabs = false;
    if (line[scanIndex] === "-") {
      stripTabs = true;
      scanIndex += 1;
    }
    while (line[scanIndex] === " " || line[scanIndex] === "\t") {
      scanIndex += 1;
    }

    const first = line[scanIndex];
    if (first === "'" || first === '"') {
      const quote = first;
      scanIndex += 1;
      let delimiter = "";
      while (scanIndex < line.length) {
        const current = line[scanIndex];
        if (quote === '"' && current === "\\" && scanIndex + 1 < line.length) {
          delimiter += line[scanIndex + 1];
          scanIndex += 2;
          continue;
        }
        if (current === quote) {
          specs.push({ delimiter, stripTabs, startIndex, quoted: true });
          i = scanIndex;
          break;
        }
        delimiter += current;
        scanIndex += 1;
      }
      continue;
    }

    let delimiter = "";
    while (scanIndex < line.length) {
      const current = line[scanIndex];
      if (/\s/u.test(current) || "|&;<>".includes(current)) {
        break;
      }
      delimiter += current;
      scanIndex += 1;
    }
    if (delimiter) {
      specs.push({ delimiter, stripTabs, startIndex, quoted: false });
      i = scanIndex - 1;
    }
  }

  return specs;
}

function extractOpenClawControlFallbackLines(rawCommand: string): string[] {
  const out: string[] = [];
  const pendingDelimiters: { delimiter: string; stripTabs: boolean }[] = [];

  const extractHeredocsFromLine = (line: string): { delimiter: string; stripTabs: boolean }[] => {
    const specs: { delimiter: string; stripTabs: boolean }[] = [];
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const next = line[i + 1];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (!inSingle && ch === "\\") {
        escaped = true;
        continue;
      }
      if (inSingle) {
        if (ch === "'") {
          inSingle = false;
        }
        continue;
      }
      if (inDouble) {
        if (ch === '"') {
          inDouble = false;
        }
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        continue;
      }
      if (ch === "#" && (i === 0 || /\s/u.test(line[i - 1] ?? ""))) {
        break;
      }
      if (ch !== "<" || next !== "<" || line[i + 2] === "<") {
        continue;
      }

      let scanIndex = i + 2;
      let stripTabs = false;
      if (line[scanIndex] === "-") {
        stripTabs = true;
        scanIndex += 1;
      }
      while (line[scanIndex] === " " || line[scanIndex] === "\t") {
        scanIndex += 1;
      }

      const first = line[scanIndex];
      if (first === "'" || first === '"') {
        const quote = first;
        scanIndex += 1;
        let delimiter = "";
        while (scanIndex < line.length) {
          const current = line[scanIndex];
          if (quote === '"' && current === "\\" && scanIndex + 1 < line.length) {
            delimiter += line[scanIndex + 1];
            scanIndex += 2;
            continue;
          }
          if (current === quote) {
            specs.push({ delimiter, stripTabs });
            i = scanIndex;
            break;
          }
          delimiter += current;
          scanIndex += 1;
        }
        continue;
      }

      let delimiter = "";
      while (scanIndex < line.length) {
        const current = line[scanIndex];
        if (/\s/u.test(current) || "|&;<>".includes(current)) {
          break;
        }
        delimiter += current;
        scanIndex += 1;
      }
      if (delimiter) {
        specs.push({ delimiter, stripTabs });
        i = scanIndex - 1;
      }
    }

    return specs;
  };

  for (const rawLine of rawCommand.split(/\r?\n/)) {
    if (pendingDelimiters.length > 0) {
      const current = pendingDelimiters[0];
      const delimiterLine = current.stripTabs ? rawLine.replace(/^\t+/u, "") : rawLine;
      if (delimiterLine === current.delimiter) {
        pendingDelimiters.shift();
      }
      continue;
    }

    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    out.push(line);

    for (const heredoc of extractHeredocsFromLine(line)) {
      pendingDelimiters.push(heredoc);
    }
  }

  return out;
}

function splitOpenClawControlFallbackPipelines(line: string): string[] {
  const out: string[] = [];
  let buffer = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushBuffer = () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      out.push(trimmed);
    }
    buffer = "";
  };

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (escaped) {
      buffer += ch;
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      buffer += ch;
      escaped = true;
      continue;
    }
    if (inSingle) {
      buffer += ch;
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      buffer += ch;
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      buffer += ch;
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      buffer += ch;
      inDouble = true;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/u.test(line[i - 1] ?? ""))) {
      buffer += line.slice(i);
      break;
    }
    if (ch === "|") {
      pushBuffer();
      if (next === "&") {
        i += 1;
      }
      continue;
    }
    if (ch === "&" && next !== "&") {
      pushBuffer();
      continue;
    }
    buffer += ch;
  }

  pushBuffer();
  return out.length > 0 ? out : [line];
}

function splitOpenClawControlFallbackSegments(line: string): string[] {
  const chainParts = splitCommandChainWithOperators(line)?.map((part) => part.part) ?? [line];
  return chainParts.flatMap(splitOpenClawControlFallbackPipelines);
}

function stripQuotedHeredocBodiesForOpenClawControlSubstitutions(rawCommand: string): string {
  const out: string[] = [];
  const pendingDelimiters: { delimiter: string; stripTabs: boolean; quoted: boolean }[] = [];

  for (const rawLine of rawCommand.split(/\r?\n/)) {
    if (pendingDelimiters.length > 0) {
      const current = pendingDelimiters[0];
      const delimiterLine = current.stripTabs ? rawLine.replace(/^\t+/u, "") : rawLine;
      if (delimiterLine === current.delimiter) {
        pendingDelimiters.shift();
        continue;
      }
      if (!current.quoted) {
        out.push(rawLine);
      }
      continue;
    }

    out.push(rawLine);
    const line = rawLine.trim();
    for (const heredoc of extractOpenClawControlHeredocsFromLine(line)) {
      pendingDelimiters.push(heredoc);
    }
  }

  return out.join("\n");
}

function extractOpenClawControlCommandSubstitutionPayloads(rawCommand: string): string[] {
  const command = stripQuotedHeredocBodiesForOpenClawControlSubstitutions(rawCommand);
  const payloads: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const readParenPayload = (startIndex: number): { payload: string; endIndex: number } | null => {
    let depth = 1;
    let nestedSingle = false;
    let nestedDouble = false;
    let nestedEscaped = false;
    const payloadStart = startIndex + 2;

    for (let i = payloadStart; i < command.length; i += 1) {
      const ch = command[i];
      const next = command[i + 1];

      if (nestedEscaped) {
        nestedEscaped = false;
        continue;
      }
      if (!nestedSingle && ch === "\\") {
        nestedEscaped = true;
        continue;
      }
      if (nestedSingle) {
        if (ch === "'") {
          nestedSingle = false;
        }
        continue;
      }
      if (nestedDouble) {
        if (ch === '"') {
          nestedDouble = false;
        }
        continue;
      }
      if (ch === "'") {
        nestedSingle = true;
        continue;
      }
      if (ch === '"') {
        nestedDouble = true;
        continue;
      }
      if (ch === "$" && next === "(") {
        depth += 1;
        i += 1;
        continue;
      }
      if ((ch === "<" || ch === ">") && next === "(") {
        depth += 1;
        i += 1;
        continue;
      }
      if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          return { payload: command.slice(payloadStart, i), endIndex: i };
        }
      }
    }
    return null;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
        continue;
      }
      if (ch === "$" && next === "(") {
        const parsed = readParenPayload(i);
        if (parsed) {
          payloads.push(parsed.payload);
          i = parsed.endIndex;
        }
        continue;
      }
      if (ch === "`") {
        let payload = "";
        for (let j = i + 1; j < command.length; j += 1) {
          const current = command[j];
          if (current === "\\" && j + 1 < command.length) {
            payload += command[j + 1];
            j += 1;
            continue;
          }
          if (current === "`") {
            payloads.push(payload);
            i = j;
            break;
          }
          payload += current;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "$" && next === "(") {
      const parsed = readParenPayload(i);
      if (parsed) {
        payloads.push(parsed.payload);
        i = parsed.endIndex;
      }
      continue;
    }
    if ((ch === "<" || ch === ">") && next === "(") {
      const parsed = readParenPayload(i);
      if (parsed) {
        payloads.push(parsed.payload);
        i = parsed.endIndex;
      }
      continue;
    }
    if (ch === "`") {
      let payload = "";
      for (let j = i + 1; j < command.length; j += 1) {
        const current = command[j];
        if (current === "\\" && j + 1 < command.length) {
          payload += command[j + 1];
          j += 1;
          continue;
        }
        if (current === "`") {
          payloads.push(payload);
          i = j;
          break;
        }
        payload += current;
      }
    }
  }

  return payloads;
}

function openClawControlArgvRunsShell(argv: string[]): boolean {
  const stripped = stripOpenClawControlCommandPrefixes(argv);
  return OPENCLAW_CONTROL_SHELL_WRAPPERS.has(normalizeCommandBaseName(stripped[0]));
}

function openClawControlLineRunsShellHeredoc(line: string): boolean {
  const chainParts = splitCommandChainWithOperators(line)?.map((part) => part.part) ?? [line];
  for (const chainPart of chainParts) {
    const segments = splitOpenClawControlFallbackPipelines(chainPart);
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex] ?? "";
      const heredoc = extractOpenClawControlHeredocsFromLine(segment)[0];
      if (!heredoc) {
        continue;
      }
      const prefixArgv = splitShellArgs(segment.slice(0, heredoc.startIndex).trim());
      if (prefixArgv && openClawControlArgvRunsShell(prefixArgv)) {
        return true;
      }
      for (const consumer of segments.slice(segmentIndex + 1)) {
        const consumerArgv = splitShellArgs(consumer);
        if (consumerArgv && openClawControlArgvRunsShell(consumerArgv)) {
          return true;
        }
      }
    }
  }
  return false;
}

function extractOpenClawControlHereStringsFromLine(
  line: string,
): { payload: string; startIndex: number }[] {
  const specs: { payload: string; startIndex: number }[] = [];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    const afterNext = line[i + 2];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/u.test(line[i - 1] ?? ""))) {
      break;
    }
    if (ch !== "<" || next !== "<" || afterNext !== "<" || line[i + 3] === "<") {
      continue;
    }

    const wordArgv = splitShellArgs(line.slice(i + 3).trim());
    const payload = wordArgv?.[0];
    if (payload) {
      specs.push({ payload, startIndex: i });
    }
  }
  return specs;
}

function extractOpenClawControlShellHereStringPayloads(rawCommand: string): string[] {
  const payloads: string[] = [];
  for (const rawLine of rawCommand.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const chainParts = splitCommandChainWithOperators(line)?.map((part) => part.part) ?? [line];
    for (const chainPart of chainParts) {
      const segments = splitOpenClawControlFallbackPipelines(chainPart);
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex] ?? "";
        for (const hereString of extractOpenClawControlHereStringsFromLine(segment)) {
          const prefixArgv = splitShellArgs(segment.slice(0, hereString.startIndex).trim());
          const shellConsumesHereString =
            Boolean(prefixArgv && openClawControlArgvRunsShell(prefixArgv)) ||
            segments.slice(segmentIndex + 1).some((consumer) => {
              const consumerArgv = splitShellArgs(consumer);
              return Boolean(consumerArgv && openClawControlArgvRunsShell(consumerArgv));
            });
          if (shellConsumesHereString) {
            payloads.push(hereString.payload);
          }
        }
      }
    }
  }
  return payloads;
}

function extractOpenClawControlShellHeredocPayloads(rawCommand: string): string[] {
  const payloads: string[] = [];
  const pendingDelimiters: {
    delimiter: string;
    stripTabs: boolean;
    capture: boolean;
    body: string[];
  }[] = [];

  for (const rawLine of rawCommand.split(/\r?\n/)) {
    if (pendingDelimiters.length > 0) {
      const current = pendingDelimiters[0];
      const delimiterLine = current.stripTabs ? rawLine.replace(/^\t+/u, "") : rawLine;
      if (delimiterLine === current.delimiter) {
        const done = pendingDelimiters.shift();
        if (done?.capture && done.body.length > 0) {
          payloads.push(done.body.join("\n"));
        }
        continue;
      }
      if (current.capture) {
        current.body.push(rawLine);
      }
      continue;
    }

    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const capture = openClawControlLineRunsShellHeredoc(line);
    for (const heredoc of extractOpenClawControlHeredocsFromLine(line)) {
      pendingDelimiters.push({ ...heredoc, capture, body: [] });
    }
  }

  return payloads;
}

function normalizeOpenClawControlLineContinuations(command: string): string {
  let out = "";
  let inSingle = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    const afterNext = command[i + 2];

    if (ch === "'") {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (!inSingle && ch === "\\" && next === "\r" && afterNext === "\n") {
      i += 2;
      continue;
    }
    if (!inSingle && ch === "\\" && (next === "\n" || next === "\r")) {
      i += 1;
      continue;
    }
    out += ch;
  }

  return out;
}

function buildOpenClawControlCandidatesFromRaw(
  command: string,
): OpenClawControlShellCommandCandidate[] {
  const rawCommand = normalizeOpenClawControlLineContinuations(command).trim();
  const nestedCandidates = [
    ...extractOpenClawControlCommandSubstitutionPayloads(rawCommand),
    ...extractOpenClawControlShellHeredocPayloads(rawCommand),
    ...extractOpenClawControlShellHereStringPayloads(rawCommand),
  ]
    .map((payload) => payload.trim())
    .filter((payload) => payload && payload !== rawCommand)
    .flatMap(buildOpenClawControlCandidatesFromRaw);
  const analysis = analyzeShellCommand({ command: rawCommand });
  const directCandidates = analysis.ok
    ? analysis.segments.flatMap((segment) => buildOpenClawControlCandidatesFromArgv(segment.argv))
    : extractOpenClawControlFallbackLines(rawCommand)
        .flatMap(splitOpenClawControlFallbackSegments)
        .flatMap((line) => {
          const argv = splitShellArgs(line);
          return argv ? buildOpenClawControlCandidatesFromArgv(argv) : [{ raw: line }];
        });
  return [...nestedCandidates, ...directCandidates];
}

function parseOpenClawChannelsLoginArgv(argv: string[]): boolean {
  if (extractPackageRunnerShellPayloads(argv).some(parseOpenClawChannelsLoginShellCommand)) {
    return true;
  }
  const openclawArgv = stripOpenClawRootOptions(
    stripOpenClawCliLauncher(stripOpenClawPackageRunner(argv)),
  );
  return (
    normalizeCommandBaseName(openclawArgv[0]) === "openclaw" &&
    (openclawArgv[1] === "channels" || openclawArgv[1] === "channel") &&
    openclawArgv[2] === "login"
  );
}

function parseOpenClawChannelsLoginShellCommand(raw: string): boolean {
  return buildOpenClawControlCandidatesFromRaw(raw).some((candidate) =>
    candidate.argv ? parseOpenClawChannelsLoginArgv(candidate.argv) : false,
  );
}

function parseOpenClawMessageDeliveryArgv(argv: string[]): boolean {
  if (extractPackageRunnerShellPayloads(argv).some(parseOpenClawMessageDeliveryShellCommand)) {
    return true;
  }
  const openclawArgv = stripOpenClawRootOptions(
    stripOpenClawCliLauncher(stripOpenClawPackageRunner(argv)),
  );
  const delivery = parseOpenClawMessageDeliveryCommand(openclawArgv);
  return Boolean(
    delivery &&
    !isOpenClawMessageDeliveryNonDelivering(openclawArgv.slice(delivery.argsStartIndex)),
  );
}

const OPENCLAW_MESSAGE_DELIVERY_TOP_LEVEL_COMMANDS = new Set(["broadcast", "poll", "send"]);
const OPENCLAW_MESSAGE_DELIVERY_THREAD_COMMANDS = new Set(["create", "reply"]);
const OPENCLAW_MESSAGE_DELIVERY_EXEC_ERROR = [
  "exec cannot run OpenClaw message delivery commands.",
  "Reply normally to the current conversation, or use the message tool when an explicit cross-channel send is needed.",
].join(" ");

function parseOpenClawMessageDeliveryCommand(
  openclawArgv: string[],
): { argsStartIndex: number } | null {
  if (normalizeCommandBaseName(openclawArgv[0]) !== "openclaw" || openclawArgv[1] !== "message") {
    return null;
  }
  if (OPENCLAW_MESSAGE_DELIVERY_TOP_LEVEL_COMMANDS.has(openclawArgv[2])) {
    return { argsStartIndex: 3 };
  }
  if (
    openclawArgv[2] === "thread" &&
    OPENCLAW_MESSAGE_DELIVERY_THREAD_COMMANDS.has(openclawArgv[3])
  ) {
    return { argsStartIndex: 4 };
  }
  if (openclawArgv[2] === "sticker" && openclawArgv[3] === "send") {
    return { argsStartIndex: 4 };
  }
  return null;
}

const OPENCLAW_MESSAGE_DELIVERY_VALUE_OPTIONS = new Set([
  "-m",
  "--account",
  "--auto-archive-min",
  "--channel",
  "--delivery",
  "--media",
  "--message",
  "--message-id",
  "--presentation",
  "--poll-duration-hours",
  "--poll-duration-seconds",
  "--poll-option",
  "--poll-question",
  "--reply-to",
  "--sticker-id",
  "--target",
  "--targets",
  "--thread-id",
  "--thread-name",
  "-t",
]);

function isOpenClawMessageDeliveryNonDelivering(args: string[]): boolean {
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      break;
    }
    const optionName = arg.split("=", 1)[0];
    if (OPENCLAW_MESSAGE_DELIVERY_VALUE_OPTIONS.has(optionName)) {
      if (!arg.includes("=")) {
        idx += 1;
      }
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      return true;
    }
    if (arg === "--dry-run") {
      return true;
    }
    if (arg.startsWith("--dry-run=")) {
      const value = normalizeLowercaseStringOrEmpty(arg.slice("--dry-run=".length));
      return value !== "false" && value !== "0";
    }
  }
  return false;
}

function parseOpenClawMessageDeliveryShellCommand(raw: string): boolean {
  return buildOpenClawControlCandidatesFromRaw(raw).some((candidate) =>
    candidate.argv ? parseOpenClawMessageDeliveryArgv(candidate.argv) : false,
  );
}

function rejectUnsafeControlShellCommand(command: string): void {
  const isEnvAssignmentToken = (token: string): boolean =>
    /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token);
  const shellWrappers = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
  const commandStandaloneOptions = new Set(["-p", "-v", "-V"]);
  const envOptionsWithValues = new Set([
    "-C",
    "-S",
    "-u",
    "--argv0",
    "--block-signal",
    "--chdir",
    "--default-signal",
    "--ignore-signal",
    "--split-string",
    "--unset",
  ]);
  const execOptionsWithValues = new Set(["-a"]);
  const execStandaloneOptions = new Set(["-c", "-l"]);
  const sudoOptionsWithValues = new Set([
    "-C",
    "-D",
    "-g",
    "-p",
    "-R",
    "-T",
    "-U",
    "-u",
    "--chdir",
    "--close-from",
    "--group",
    "--host",
    "--other-user",
    "--prompt",
    "--role",
    "--type",
    "--user",
  ]);
  const sudoStandaloneOptions = new Set(["-A", "-E", "--askpass", "--preserve-env"]);
  const extractEnvSplitStringPayload = (argv: string[]): string[] => {
    const remaining = [...argv];
    while (remaining.length > 0) {
      while (remaining[0] && isEnvAssignmentToken(remaining[0])) {
        remaining.shift();
      }
      const token = remaining[0];
      const commandName = normalizeCommandBaseName(token);
      if (!token || commandName === "env") {
        break;
      }
      if (commandName === "command" || commandName === "builtin") {
        remaining.shift();
        while (remaining[0]?.startsWith("-")) {
          const option = remaining.shift()!;
          if (option === "--") {
            break;
          }
          if (!commandStandaloneOptions.has(option.split("=", 1)[0])) {
            continue;
          }
        }
        continue;
      }
      if (commandName === "exec") {
        remaining.shift();
        while (remaining[0]?.startsWith("-")) {
          const option = remaining.shift()!;
          if (option === "--") {
            break;
          }
          const normalized = option.split("=", 1)[0];
          if (execStandaloneOptions.has(normalized)) {
            continue;
          }
          if (execOptionsWithValues.has(normalized) && !option.includes("=") && remaining[0]) {
            remaining.shift();
          }
        }
        continue;
      }
      if (commandName === "sudo") {
        remaining.shift();
        while (remaining[0]?.startsWith("-")) {
          const option = remaining.shift()!;
          if (option === "--") {
            break;
          }
          const normalized = option.split("=", 1)[0];
          if (sudoStandaloneOptions.has(normalized)) {
            continue;
          }
          if (sudoOptionsWithValues.has(normalized) && !option.includes("=") && remaining[0]) {
            remaining.shift();
          }
        }
        continue;
      }
      break;
    }
    if (normalizeCommandBaseName(remaining[0]) !== "env") {
      return [];
    }
    remaining.shift();
    const payloads: string[] = [];
    const takeSplitStringPayload = (option: string): string | undefined => {
      if (option === "-S" || option === "--split-string") {
        return remaining.shift();
      }
      if (option.startsWith("--split-string=")) {
        return option.slice("--split-string=".length);
      }
      if (!option.startsWith("--")) {
        const splitIndex = option.indexOf("S");
        if (splitIndex > 0) {
          return option.slice(splitIndex + 1) || remaining.shift();
        }
      }
      return undefined;
    };
    while (remaining.length > 0) {
      while (remaining[0] && isEnvAssignmentToken(remaining[0])) {
        remaining.shift();
      }
      const token: string | undefined = remaining[0];
      if (!token) {
        break;
      }
      if (token === "--") {
        remaining.shift();
        continue;
      }
      if (!token.startsWith("-") || token === "-") {
        break;
      }
      const option = remaining.shift()!;
      const normalized = option.split("=", 1)[0];
      const splitString = takeSplitStringPayload(option);
      if (splitString !== undefined) {
        const value = [splitString, ...remaining].filter((part) => part.length > 0).join(" ");
        if (value?.trim()) {
          payloads.push(value);
        }
        break;
      }
      if (envOptionsWithValues.has(normalized) && !option.includes("=") && remaining[0]) {
        remaining.shift();
      }
    }
    return payloads;
  };
  const stripApprovalCommandPrefixes = (argv: string[]): string[] => {
    const remaining = [...argv];
    while (remaining.length > 0) {
      while (remaining[0] && isEnvAssignmentToken(remaining[0])) {
        remaining.shift();
      }

      const token = remaining[0];
      if (!token) {
        break;
      }
      if (token === "--") {
        remaining.shift();
        continue;
      }
      const commandName = normalizeCommandBaseName(token);
      if (commandName === "env") {
        remaining.shift();
        while (remaining.length > 0) {
          while (remaining[0] && isEnvAssignmentToken(remaining[0])) {
            remaining.shift();
          }
          const envToken = remaining[0];
          if (!envToken) {
            break;
          }
          if (envToken === "--") {
            remaining.shift();
            continue;
          }
          if (!envToken.startsWith("-") || envToken === "-") {
            break;
          }
          const option = remaining.shift()!;
          const normalized = option.split("=", 1)[0];
          if (envOptionsWithValues.has(normalized) && !option.includes("=") && remaining[0]) {
            remaining.shift();
          }
        }
        continue;
      }
      if (commandName === "command" || commandName === "builtin") {
        remaining.shift();
        while (remaining[0]?.startsWith("-")) {
          const option = remaining.shift()!;
          if (option === "--") {
            break;
          }
          if (!commandStandaloneOptions.has(option.split("=", 1)[0])) {
            continue;
          }
        }
        continue;
      }
      if (commandName === "exec") {
        remaining.shift();
        while (remaining[0]?.startsWith("-")) {
          const option = remaining.shift()!;
          if (option === "--") {
            break;
          }
          const normalized = option.split("=", 1)[0];
          if (execStandaloneOptions.has(normalized)) {
            continue;
          }
          if (execOptionsWithValues.has(normalized) && !option.includes("=") && remaining[0]) {
            remaining.shift();
          }
        }
        continue;
      }
      if (commandName === "sudo") {
        remaining.shift();
        while (remaining[0]?.startsWith("-")) {
          const option = remaining.shift()!;
          if (option === "--") {
            break;
          }
          const normalized = option.split("=", 1)[0];
          if (sudoStandaloneOptions.has(normalized)) {
            continue;
          }
          if (sudoOptionsWithValues.has(normalized) && !option.includes("=") && remaining[0]) {
            remaining.shift();
          }
        }
        continue;
      }
      break;
    }
    return remaining;
  };
  const extractShellWrapperPayload = (argv: string[]): string[] => {
    const [commandName, ...rest] = argv;
    if (!commandName || !shellWrappers.has(normalizeCommandBaseName(commandName))) {
      return [];
    }
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (!token) {
        continue;
      }
      if (token === "-c" || token === "-lc" || token === "-ic" || token === "-xc") {
        return rest[i + 1] ? [rest[i + 1]] : [];
      }
      if (/^-[^-]*c[^-]*$/u.test(token)) {
        return rest[i + 1] ? [rest[i + 1]] : [];
      }
    }
    return [];
  };
  type UnsafeShellCommandCandidate = { raw: string; argv?: string[] };
  const buildCandidates = (argv: string[]): UnsafeShellCommandCandidate[] => {
    const envSplitCandidates = extractEnvSplitStringPayload(argv).flatMap((payload) => {
      const innerArgv = splitShellArgs(payload);
      return innerArgv ? buildCandidates(innerArgv) : [{ raw: payload }];
    });
    const stripped = stripApprovalCommandPrefixes(argv);
    const shellWrapperCandidates = extractShellWrapperPayload(stripped).flatMap((payload) => {
      const innerArgv = splitShellArgs(payload);
      return innerArgv ? buildCandidates(innerArgv) : [{ raw: payload }];
    });
    return [
      ...(stripped.length > 0 ? [{ raw: stripped.join(" "), argv: stripped }] : []),
      ...envSplitCandidates,
      ...shellWrapperCandidates,
    ];
  };

  const rawCommand = command.trim();
  if (parseOpenClawChannelsLoginShellCommand(rawCommand)) {
    throw new Error(
      [
        "exec cannot run interactive OpenClaw channel login commands.",
        "Run `openclaw channels login` in a terminal on the gateway host, or use the channel-specific login agent tool when available (for WhatsApp: `whatsapp_login`).",
      ].join(" "),
    );
  }
  if (parseOpenClawMessageDeliveryShellCommand(rawCommand)) {
    throw new Error(OPENCLAW_MESSAGE_DELIVERY_EXEC_ERROR);
  }
  const analysis = analyzeShellCommand({ command: rawCommand });
  const candidates: UnsafeShellCommandCandidate[] = analysis.ok
    ? analysis.segments.flatMap((segment) => buildCandidates(segment.argv))
    : extractOpenClawControlFallbackLines(rawCommand)
        .flatMap(splitOpenClawControlFallbackSegments)
        .flatMap((line) => {
          const argv = splitShellArgs(line);
          return argv ? buildCandidates(argv) : [{ raw: line }];
        });
  for (const candidate of candidates) {
    const candidateRaw = candidate.raw;
    if (parseExecApprovalShellCommand(candidateRaw)) {
      throw new Error(
        [
          "exec cannot run /approve commands.",
          "Show the /approve command to the user as chat text, or route it through the approval command handler instead of shell execution.",
        ].join(" "),
      );
    }
    if (
      parseOpenClawChannelsLoginShellCommand(candidateRaw) ||
      (candidate.argv ? parseOpenClawChannelsLoginArgv(candidate.argv) : false)
    ) {
      throw new Error(
        [
          "exec cannot run interactive OpenClaw channel login commands.",
          "Run `openclaw channels login` in a terminal on the gateway host, or use the channel-specific login agent tool when available (for WhatsApp: `whatsapp_login`).",
        ].join(" "),
      );
    }
    if (
      parseOpenClawMessageDeliveryShellCommand(candidateRaw) ||
      (candidate.argv ? parseOpenClawMessageDeliveryArgv(candidate.argv) : false)
    ) {
      throw new Error(OPENCLAW_MESSAGE_DELIVERY_EXEC_ERROR);
    }
  }
}

export function createExecTool(
  defaults?: ExecToolDefaults,
): AgentToolWithMeta<typeof execSchema, ExecToolDetails> {
  const defaultBackgroundMs = clampWithDefault(
    defaults?.backgroundMs ?? readEnvInt("PI_BASH_YIELD_MS"),
    10_000,
    10,
    120_000,
  );
  const allowBackground = defaults?.allowBackground ?? true;
  const defaultTimeoutSec =
    typeof defaults?.timeoutSec === "number" && defaults.timeoutSec > 0
      ? defaults.timeoutSec
      : 1800;
  const defaultPathPrepend = normalizePathPrepend(defaults?.pathPrepend);
  const {
    safeBins,
    safeBinProfiles,
    trustedSafeBinDirs,
    unprofiledSafeBins,
    unprofiledInterpreterSafeBins,
  } = resolveExecSafeBinRuntimePolicy({
    local: {
      safeBins: defaults?.safeBins,
      safeBinTrustedDirs: defaults?.safeBinTrustedDirs,
      safeBinProfiles: defaults?.safeBinProfiles,
    },
    onWarning: (message) => {
      logInfo(message);
    },
  });
  if (unprofiledSafeBins.length > 0) {
    logInfo(
      `exec: ignoring unprofiled safeBins entries (${unprofiledSafeBins.toSorted().join(", ")}); use allowlist or define tools.exec.safeBinProfiles.<bin>`,
    );
  }
  if (unprofiledInterpreterSafeBins.length > 0) {
    logInfo(
      `exec: interpreter/runtime binaries in safeBins (${unprofiledInterpreterSafeBins.join(", ")}) are unsafe without explicit hardened profiles; prefer allowlist entries`,
    );
  }
  const notifyOnExit = defaults?.notifyOnExit !== false;
  const notifyOnExitEmptySuccess = defaults?.notifyOnExitEmptySuccess === true;
  const notifySessionKey = normalizeOptionalString(defaults?.sessionKey);
  const notifyDeliveryContext = normalizeDeliveryContext({
    channel: defaults?.messageProvider,
    to: defaults?.currentChannelId,
    accountId: defaults?.accountId,
    threadId: defaults?.currentThreadTs,
  });
  const approvalRunningNoticeMs = resolveApprovalRunningNoticeMs(defaults?.approvalRunningNoticeMs);
  // Derive agentId only when sessionKey is an agent session key.
  const parsedAgentSession = parseAgentSessionKey(defaults?.sessionKey);
  const agentId =
    defaults?.agentId ??
    (parsedAgentSession ? resolveAgentIdFromSessionKey(defaults?.sessionKey) : undefined);

  return {
    name: "exec",
    label: "exec",
    displaySummary: EXEC_TOOL_DISPLAY_SUMMARY,
    get description() {
      return describeExecTool({ agentId, hasCronTool: defaults?.hasCronTool === true });
    },
    parameters: execSchema,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      const params = args as {
        command: string;
        workdir?: string;
        env?: Record<string, string>;
        yieldMs?: number;
        background?: boolean;
        timeout?: number;
        pty?: boolean;
        elevated?: boolean;
        host?: string;
        security?: string;
        ask?: string;
        node?: string;
      };

      if (!params.command) {
        throw new Error("Provide a command to start.");
      }

      const maxOutput = DEFAULT_MAX_OUTPUT;
      const pendingMaxOutput = DEFAULT_PENDING_MAX_OUTPUT;
      const warnings: string[] = [];
      const approvalWarningText = normalizeOptionalString(defaults?.approvalWarningText);
      if (approvalWarningText) {
        warnings.push(approvalWarningText);
      }
      let execCommandOverride: string | undefined;
      const backgroundRequested = params.background === true;
      const yieldRequested = typeof params.yieldMs === "number";
      if (!allowBackground && (backgroundRequested || yieldRequested)) {
        warnings.push("Warning: background execution is disabled; running synchronously.");
      }
      const yieldWindow = allowBackground
        ? backgroundRequested
          ? 0
          : clampWithDefault(
              params.yieldMs ?? defaultBackgroundMs,
              defaultBackgroundMs,
              10,
              120_000,
            )
        : null;
      const elevatedDefaults = defaults?.elevated;
      const elevatedAllowed = Boolean(elevatedDefaults?.enabled && elevatedDefaults.allowed);
      const elevatedDefaultMode =
        elevatedDefaults?.defaultLevel === "full"
          ? "full"
          : elevatedDefaults?.defaultLevel === "ask"
            ? "ask"
            : elevatedDefaults?.defaultLevel === "on"
              ? "ask"
              : "off";
      const effectiveDefaultMode = elevatedAllowed ? elevatedDefaultMode : "off";
      const elevatedMode =
        typeof params.elevated === "boolean"
          ? params.elevated
            ? elevatedDefaultMode === "full"
              ? "full"
              : "ask"
            : "off"
          : effectiveDefaultMode;
      const elevatedRequested = elevatedMode !== "off";
      if (elevatedRequested) {
        if (!elevatedDefaults?.enabled || !elevatedDefaults.allowed) {
          const runtime = defaults?.sandbox ? "sandboxed" : "direct";
          const gates: string[] = [];
          const contextParts: string[] = [];
          const provider = normalizeOptionalString(defaults?.messageProvider);
          const sessionKey = normalizeOptionalString(defaults?.sessionKey);
          if (provider) {
            contextParts.push(`provider=${provider}`);
          }
          if (sessionKey) {
            contextParts.push(`session=${sessionKey}`);
          }
          if (!elevatedDefaults?.enabled) {
            gates.push("enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled)");
          } else {
            gates.push(
              "allowFrom (tools.elevated.allowFrom.<provider> / agents.list[].tools.elevated.allowFrom.<provider>)",
            );
          }
          throw new Error(
            [
              `elevated is not available right now (runtime=${runtime}).`,
              `Failing gates: ${gates.join(", ")}`,
              contextParts.length > 0 ? `Context: ${contextParts.join(" ")}` : undefined,
              "Fix-it keys:",
              "- tools.elevated.enabled",
              "- tools.elevated.allowFrom.<provider>",
              "- agents.list[].tools.elevated.enabled",
              "- agents.list[].tools.elevated.allowFrom.<provider>",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
      }
      if (elevatedRequested) {
        logInfo(`exec: elevated command ${truncateMiddle(params.command, 120)}`);
      }
      const requestedTarget = requireValidExecTarget(params.host);
      const target = resolveExecTarget({
        configuredTarget: defaults?.host,
        requestedTarget,
        elevatedRequested,
        sandboxAvailable: Boolean(defaults?.sandbox),
      });
      const host: ExecHost = target.effectiveHost;

      const approvalDefaults = loadExecApprovals().defaults;
      const configuredSecurity =
        defaults?.security ?? approvalDefaults?.security ?? (host === "sandbox" ? "deny" : "full");
      const requestedSecurity = normalizeExecSecurity(params.security);
      let security = minSecurity(configuredSecurity, requestedSecurity ?? configuredSecurity);
      if (elevatedRequested && elevatedMode === "full") {
        security = "full";
      }
      // Keep local exec defaults in sync with exec-approvals.json when tools.exec.* is unset.
      const configuredAsk = defaults?.ask ?? approvalDefaults?.ask ?? "off";
      const requestedAsk = normalizeExecAsk(params.ask);
      let ask = maxAsk(configuredAsk, requestedAsk ?? configuredAsk);
      const bypassApprovals = elevatedRequested && elevatedMode === "full";
      if (bypassApprovals) {
        ask = "off";
      }

      const sandbox = host === "sandbox" ? defaults?.sandbox : undefined;
      if (target.selectedTarget === "sandbox" && !sandbox) {
        throw new Error(
          [
            "exec host=sandbox requires a sandbox runtime for this session.",
            'Enable sandbox mode (`agents.defaults.sandbox.mode="non-main"` or `"all"`) or use host=auto/gateway/node.',
          ].join("\n"),
        );
      }
      const explicitWorkdir = normalizeOptionalString(params.workdir);
      const defaultWorkdir = normalizeOptionalString(defaults?.cwd);
      let workdir: string | undefined;
      let containerWorkdir = sandbox?.containerWorkdir;
      if (sandbox) {
        const sandboxWorkdir = explicitWorkdir ?? defaultWorkdir ?? process.cwd();
        const resolved = await resolveSandboxWorkdir({
          workdir: sandboxWorkdir,
          sandbox,
          warnings,
        });
        workdir = resolved.hostWorkdir;
        containerWorkdir = resolved.containerWorkdir;
      } else if (host === "node") {
        // For remote node execution, only forward a cwd that was explicitly
        // requested on the tool call. The gateway's workspace root is wired in as a
        // local default, but it is not meaningful on the remote node and would
        // recreate the cross-platform approval failure this path is fixing.
        // When no explicit cwd was given, the gateway's own
        // process.cwd() is meaningless on the remote node (especially cross-platform,
        // e.g. Linux gateway + Windows node) and would cause
        // "SYSTEM_RUN_DENIED: approval requires an existing canonical cwd".
        // Passing undefined lets the node use its own default working directory.
        workdir = explicitWorkdir;
      } else {
        const rawWorkdir = explicitWorkdir ?? defaultWorkdir ?? process.cwd();
        workdir = resolveWorkdir(rawWorkdir, warnings);
      }
      rejectUnsafeControlShellCommand(params.command);

      const inheritedBaseEnv = coerceEnv(process.env);
      const hostEnvResult =
        host === "sandbox"
          ? null
          : sanitizeHostExecEnvWithDiagnostics({
              baseEnv: inheritedBaseEnv,
              overrides: params.env,
              blockPathOverrides: true,
            });
      if (
        hostEnvResult &&
        params.env &&
        (hostEnvResult.rejectedOverrideBlockedKeys.length > 0 ||
          hostEnvResult.rejectedOverrideInvalidKeys.length > 0)
      ) {
        const blockedKeys = hostEnvResult.rejectedOverrideBlockedKeys;
        const invalidKeys = hostEnvResult.rejectedOverrideInvalidKeys;
        const pathBlocked = blockedKeys.includes("PATH");
        if (pathBlocked && blockedKeys.length === 1 && invalidKeys.length === 0) {
          throw new Error(
            "Security Violation: Custom 'PATH' variable is forbidden during host execution.",
          );
        }
        if (blockedKeys.length === 1 && invalidKeys.length === 0) {
          throw new Error(
            `Security Violation: Environment variable '${blockedKeys[0]}' is forbidden during host execution.`,
          );
        }
        const details: string[] = [];
        if (blockedKeys.length > 0) {
          details.push(`blocked override keys: ${blockedKeys.join(", ")}`);
        }
        if (invalidKeys.length > 0) {
          details.push(`invalid non-portable override keys: ${invalidKeys.join(", ")}`);
        }
        const suffix = details.join("; ");
        if (pathBlocked) {
          throw new Error(
            `Security Violation: Custom 'PATH' variable is forbidden during host execution (${suffix}).`,
          );
        }
        throw new Error(`Security Violation: ${suffix}.`);
      }

      const env =
        sandbox && host === "sandbox"
          ? buildSandboxEnv({
              defaultPath: DEFAULT_PATH,
              paramsEnv: params.env,
              sandboxEnv: sandbox.env,
              containerWorkdir: containerWorkdir ?? sandbox.containerWorkdir,
            })
          : (hostEnvResult?.env ?? inheritedBaseEnv);

      if (!sandbox && host === "gateway" && !params.env?.PATH) {
        const shellPath = getShellPathFromLoginShell({
          env: process.env,
          timeoutMs: resolveShellEnvFallbackTimeoutMs(process.env),
        });
        applyShellPath(env, shellPath);
      }

      // `tools.exec.pathPrepend` is only meaningful when exec runs locally (gateway) or in the sandbox.
      // Node hosts intentionally ignore request-scoped PATH overrides, so don't pretend this applies.
      if (host === "node" && defaultPathPrepend.length > 0) {
        warnings.push(
          "Warning: tools.exec.pathPrepend is ignored for host=node. Configure PATH on the node host/service instead.",
        );
      } else {
        applyPathPrepend(env, defaultPathPrepend);
      }

      if (host === "node") {
        return executeNodeHostCommand({
          command: params.command,
          workdir,
          env,
          requestedEnv: params.env,
          requestedNode: params.node?.trim(),
          boundNode: defaults?.node?.trim(),
          sessionKey: defaults?.sessionKey,
          turnSourceChannel: defaults?.messageProvider,
          turnSourceTo: defaults?.currentChannelId,
          turnSourceAccountId: defaults?.accountId,
          turnSourceThreadId: defaults?.currentThreadTs,
          agentId,
          security,
          ask,
          strictInlineEval: defaults?.strictInlineEval,
          trigger: defaults?.trigger,
          timeoutSec: params.timeout,
          defaultTimeoutSec,
          approvalRunningNoticeMs,
          warnings,
          notifySessionKey,
          notifyOnExit,
          trustedSafeBinDirs,
        });
      }

      const localWorkdir = workdir;
      if (!localWorkdir) {
        throw new Error("exec internal error: local execution requires a resolved workdir");
      }

      if (host === "gateway" && !bypassApprovals) {
        const gatewayResult = await processGatewayAllowlist({
          command: params.command,
          workdir: localWorkdir,
          env,
          requestedEnv: params.env,
          pty: params.pty === true && !sandbox,
          timeoutSec: params.timeout,
          defaultTimeoutSec,
          security,
          ask,
          safeBins,
          safeBinProfiles,
          strictInlineEval: defaults?.strictInlineEval,
          trigger: defaults?.trigger,
          agentId,
          sessionKey: defaults?.sessionKey,
          turnSourceChannel: defaults?.messageProvider,
          turnSourceTo: defaults?.currentChannelId,
          turnSourceAccountId: defaults?.accountId,
          turnSourceThreadId: defaults?.currentThreadTs,
          scopeKey: defaults?.scopeKey,
          approvalFollowupText: defaults?.approvalFollowupText,
          approvalFollowup: defaults?.approvalFollowup,
          approvalFollowupMode: defaults?.approvalFollowupMode,
          warnings,
          notifySessionKey,
          approvalRunningNoticeMs,
          maxOutput,
          pendingMaxOutput,
          trustedSafeBinDirs,
        });
        if (gatewayResult.pendingResult) {
          return gatewayResult.pendingResult;
        }
        execCommandOverride = gatewayResult.execCommandOverride;
        if (gatewayResult.allowWithoutEnforcedCommand) {
          execCommandOverride = undefined;
        }
      }

      const explicitTimeoutSec = typeof params.timeout === "number" ? params.timeout : null;
      const effectiveTimeout = explicitTimeoutSec ?? defaultTimeoutSec;
      const getWarningText = () => (warnings.length ? `${warnings.join("\n")}\n\n` : "");
      const usePty = params.pty === true && !sandbox;

      // Preflight: block untracked message delivery from shell scripts, and
      // catch shell syntax leaking into Python/JS sources when that heuristic is enabled.
      await validateScriptFileForShellBleed({
        command: params.command,
        skipLanguageHeuristics: shouldSkipExecScriptPreflight({ host, security, ask }),
        workdir: localWorkdir,
      });

      const run = await runExecProcess({
        command: params.command,
        execCommand: execCommandOverride,
        workdir: localWorkdir,
        env,
        sandbox,
        containerWorkdir,
        usePty,
        warnings,
        maxOutput,
        pendingMaxOutput,
        notifyOnExit,
        notifyOnExitEmptySuccess,
        scopeKey: defaults?.scopeKey,
        sessionKey: notifySessionKey,
        notifyDeliveryContext,
        timeoutSec: effectiveTimeout,
        onUpdate,
      });

      let yielded = false;
      let yieldTimer: NodeJS.Timeout | null = null;

      // Tool-call abort should not kill backgrounded sessions; timeouts still must.
      const onAbortSignal = () => {
        // Immediately suppress onUpdate calls so that any late stdout/stderr
        // from the still-running process cannot push a rejected Promise into
        // pi-agent-core's updateEvents after the agent run has ended (#62520).
        // Intentionally placed *before* the yielded/backgrounded guard: the
        // agent run is ending regardless, so no consumer exists for further
        // tool_execution_update events even for backgrounded sessions (which
        // retrieve output via process poll/log instead of onUpdate callbacks).
        run.disableUpdates();
        if (yielded || run.session.backgrounded) {
          return;
        }
        run.kill();
      };

      if (signal?.aborted) {
        onAbortSignal();
      } else if (signal) {
        signal.addEventListener("abort", onAbortSignal, { once: true });
      }

      return new Promise<AgentToolResult<ExecToolDetails>>((resolve, reject) => {
        const resolveRunning = () =>
          resolve({
            content: [
              {
                type: "text",
                text: `${getWarningText()}Command still running (session ${run.session.id}, pid ${
                  run.session.pid ?? "n/a"
                }). Use process (list/poll/log/write/kill/clear/remove) for follow-up.`,
              },
            ],
            details: {
              status: "running",
              sessionId: run.session.id,
              pid: run.session.pid ?? undefined,
              startedAt: run.startedAt,
              cwd: run.session.cwd,
              tail: run.session.tail,
            },
          });

        const onYieldNow = () => {
          if (yieldTimer) {
            clearTimeout(yieldTimer);
          }
          if (yielded) {
            return;
          }
          yielded = true;
          markBackgrounded(run.session);
          resolveRunning();
        };

        if (allowBackground && yieldWindow !== null) {
          if (yieldWindow === 0) {
            onYieldNow();
          } else {
            yieldTimer = setTimeout(() => {
              if (yielded) {
                return;
              }
              yielded = true;
              markBackgrounded(run.session);
              resolveRunning();
            }, yieldWindow);
          }
        }

        run.promise
          .then((outcome) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }
            if (yielded || run.session.backgrounded) {
              return;
            }
            resolve(
              buildExecForegroundResult({
                outcome,
                cwd: run.session.cwd,
                warningText: getWarningText(),
              }),
            );
          })
          .catch((err) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }
            if (yielded || run.session.backgrounded) {
              return;
            }
            reject(err as Error);
          });
      });
    },
  };
}

export const execTool = createExecTool();

export const __testing = {
  parseOpenClawChannelsLoginShellCommand,
  parseOpenClawMessageDeliveryShellCommand,
  validateScriptFileForShellBleed,
};
