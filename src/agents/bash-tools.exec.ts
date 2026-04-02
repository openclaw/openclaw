import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { analyzeShellCommand } from "../infra/exec-approvals-analysis.js";
import {
  type ExecHost,
  loadExecApprovals,
  maxAsk,
  minSecurity,
  resolveExecApprovalsFromFile,
} from "../infra/exec-approvals.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { sanitizeHostExecEnvWithDiagnostics } from "../infra/host-env-security.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import { logInfo } from "../logger.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { splitShellArgs } from "../utils/shell-argv.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import {
  DEFAULT_MAX_OUTPUT,
  DEFAULT_PATH,
  DEFAULT_PENDING_MAX_OUTPUT,
  type ExecProcessOutcome,
  applyPathPrepend,
  applyShellPath,
  normalizeExecAsk,
  normalizeExecSecurity,
  normalizeExecTarget,
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
import { assertSandboxPath } from "./sandbox-paths.js";
import { failedTextResult, textResult } from "./tools/common.js";

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
      cwd: params.cwd,
    });
  }
  return textResult(`${warningText}${params.outcome.aggregated || "(no output)"}`, {
    status: "completed",
    exitCode: params.outcome.exitCode,
    durationMs: params.outcome.durationMs,
    aggregated: params.outcome.aggregated,
    cwd: params.cwd,
  });
}

function extractScriptTargetFromCommand(
  command: string,
): { kind: "python"; relOrAbsPath: string } | { kind: "node"; relOrAbsPath: string } | null {
  const raw = command.trim();
  if (!raw) {
    return null;
  }

  // Intentionally simple parsing: we only support common forms like
  //   python file.py
  //   python3 -u file.py
  //   node --experimental-something file.js
  // If the command is more complex (pipes, heredocs, quoted paths with spaces), skip preflight.
  const pythonMatch = raw.match(/^\s*(python3?|python)\s+(?:-[^\s]+\s+)*([^\s]+\.py)\b/i);
  if (pythonMatch?.[2]) {
    return { kind: "python", relOrAbsPath: pythonMatch[2] };
  }
  const nodeMatch = raw.match(/^\s*(node)\s+(?:--[^\s]+\s+)*([^\s]+\.js)\b/i);
  if (nodeMatch?.[2]) {
    return { kind: "node", relOrAbsPath: nodeMatch[2] };
  }

  return null;
}

async function validateScriptFileForShellBleed(params: {
  command: string;
  workdir: string;
}): Promise<void> {
  const target = extractScriptTargetFromCommand(params.command);
  if (!target) {
    return;
  }

  const absPath = path.isAbsolute(target.relOrAbsPath)
    ? path.resolve(target.relOrAbsPath)
    : path.resolve(params.workdir, target.relOrAbsPath);

  // Best-effort: only validate if file exists and is reasonably small.
  let stat: { isFile(): boolean; size: number };
  try {
    await assertSandboxPath({
      filePath: absPath,
      cwd: params.workdir,
      root: params.workdir,
    });
    stat = await fs.stat(absPath);
  } catch {
    return;
  }
  if (!stat.isFile()) {
    return;
  }
  if (stat.size > 512 * 1024) {
    return;
  }

  const content = await fs.readFile(absPath, "utf-8");

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
      match[2].toLowerCase() === "always"
        ? "allow-always"
        : (match[2].toLowerCase() as ParsedExecApprovalCommand["decision"]),
  };
}

function rejectExecApprovalShellCommand(command: string): void {
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
    while (remaining[0] && isEnvAssignmentToken(remaining[0])) {
      remaining.shift();
    }
    if (remaining[0] !== "env") {
      return [];
    }
    remaining.shift();
    const payloads: string[] = [];
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
      if (normalized === "-S" || normalized === "--split-string") {
        const value = option.includes("=")
          ? option.slice(option.indexOf("=") + 1)
          : remaining.shift();
        if (value?.trim()) {
          payloads.push(value);
        }
        continue;
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
      if (token === "env") {
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
      if (token === "command" || token === "builtin") {
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
      if (token === "exec") {
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
      if (token === "sudo") {
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
    if (!commandName || !shellWrappers.has(path.basename(commandName))) {
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
  const buildCandidates = (argv: string[]): string[] => {
    const envSplitCandidates = extractEnvSplitStringPayload(argv).flatMap((payload) => {
      const innerArgv = splitShellArgs(payload);
      return innerArgv ? buildCandidates(innerArgv) : [payload];
    });
    const stripped = stripApprovalCommandPrefixes(argv);
    const shellWrapperCandidates = extractShellWrapperPayload(stripped).flatMap((payload) => {
      const innerArgv = splitShellArgs(payload);
      return innerArgv ? buildCandidates(innerArgv) : [payload];
    });
    return [
      ...(stripped.length > 0 ? [stripped.join(" ")] : []),
      ...envSplitCandidates,
      ...shellWrapperCandidates,
    ];
  };

  const rawCommand = command.trim();
  const analysis = analyzeShellCommand({ command: rawCommand });
  const candidates = analysis.ok
    ? analysis.segments.flatMap((segment) => buildCandidates(segment.argv))
    : rawCommand
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          const argv = splitShellArgs(line);
          return argv ? buildCandidates(argv) : [line];
        });
  for (const candidate of candidates) {
    if (!parseExecApprovalShellCommand(candidate)) {
      continue;
    }
    throw new Error(
      [
        "exec cannot run /approve commands.",
        "Show the /approve command to the user as chat text, or route it through the approval command handler instead of shell execution.",
      ].join(" "),
    );
  }
}

/**
 * Show the exact approved token in hints. Absolute paths stay absolute so the
 * hint cannot imply an equivalent PATH lookup that resolves to a different binary.
 */
function deriveExecShortName(fullPath: string): string {
  if (path.isAbsolute(fullPath)) {
    return fullPath;
  }
  const base = path.basename(fullPath);
  return base.replace(/\.exe$/i, "") || base;
}

function buildExecToolDescription(agentId?: string): string {
  const base =
    "Execute shell commands with background continuation. Use yieldMs/background to continue later via process tool. Use pty=true for TTY-required commands (terminal UIs, coding agents).";
  if (process.platform !== "win32") {
    return base;
  }
  const lines: string[] = [base];
  lines.push(
    "IMPORTANT (Windows): Run executables directly — do NOT wrap commands in `cmd /c`, `powershell -Command`, `& ` prefix, or WSL. Use backslash paths (C:\\path), not forward slashes. Use short executable names (e.g. `node`, `python3`) instead of full paths.",
  );
  try {
    const approvalsFile = loadExecApprovals();
    const approvals = resolveExecApprovalsFromFile({ file: approvalsFile, agentId });
    const allowlist = approvals.allowlist.filter((entry) => {
      const pattern = entry.pattern?.trim() ?? "";
      return (
        pattern.length > 0 &&
        pattern !== "*" &&
        !pattern.startsWith("=command:") &&
        (pattern.includes("/") || pattern.includes("\\") || pattern.includes("~"))
      );
    });
    if (allowlist.length > 0) {
      lines.push(
        "Pre-approved executables (exact arguments are enforced at runtime; no approval prompt needed when args match):",
      );
      for (const entry of allowlist.slice(0, 10)) {
        const shortName = deriveExecShortName(entry.pattern);
        const argNote = entry.argPattern ? "(restricted args)" : "(any arguments)";
        lines.push(`  ${shortName} ${argNote}`);
      }
    }
  } catch {
    // Allowlist loading is best-effort; don't block tool creation.
  }
  return lines.join("\n");
}
export function createExecTool(
  defaults?: ExecToolDefaults,
  // oxlint-disable-next-line typescript/no-explicit-any
): AgentTool<any, ExecToolDetails> {
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
  const notifySessionKey = defaults?.sessionKey?.trim() || undefined;
  const approvalRunningNoticeMs = resolveApprovalRunningNoticeMs(defaults?.approvalRunningNoticeMs);
  // Derive agentId only when sessionKey is an agent session key.
  const parsedAgentSession = parseAgentSessionKey(defaults?.sessionKey);
  const agentId =
    defaults?.agentId ??
    (parsedAgentSession ? resolveAgentIdFromSessionKey(defaults?.sessionKey) : undefined);

  return {
    name: "exec",
    label: "exec",
    get description() {
      return buildExecToolDescription(agentId);
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
          const provider = defaults?.messageProvider?.trim();
          const sessionKey = defaults?.sessionKey?.trim();
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
      const target = resolveExecTarget({
        configuredTarget: defaults?.host,
        requestedTarget: normalizeExecTarget(params.host),
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
      const rawWorkdir = params.workdir?.trim() || defaults?.cwd || process.cwd();
      let workdir = rawWorkdir;
      let containerWorkdir = sandbox?.containerWorkdir;
      if (sandbox) {
        const resolved = await resolveSandboxWorkdir({
          workdir: rawWorkdir,
          sandbox,
          warnings,
        });
        workdir = resolved.hostWorkdir;
        containerWorkdir = resolved.containerWorkdir;
      } else if (host !== "node") {
        // Skip local workdir resolution for remote node execution: the remote node's
        // filesystem is not visible to the gateway, so resolveWorkdir() would incorrectly
        // fall back to the gateway's cwd. The node is responsible for validating its own cwd.
        workdir = resolveWorkdir(rawWorkdir, warnings);
      }
      rejectExecApprovalShellCommand(params.command);

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
          trustedSafeBinDirs,
        });
      }

      if (host === "gateway" && !bypassApprovals) {
        const gatewayResult = await processGatewayAllowlist({
          command: params.command,
          workdir,
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
      const backgroundTimeoutBypass =
        allowBackground && explicitTimeoutSec === null && (backgroundRequested || yieldRequested);
      const effectiveTimeout = backgroundTimeoutBypass
        ? null
        : (explicitTimeoutSec ?? defaultTimeoutSec);
      const getWarningText = () => (warnings.length ? `${warnings.join("\n")}\n\n` : "");
      const usePty = params.pty === true && !sandbox;

      // Preflight: catch a common model failure mode (shell syntax leaking into Python/JS sources)
      // before we execute and burn tokens in cron loops.
      await validateScriptFileForShellBleed({ command: params.command, workdir });

      const run = await runExecProcess({
        command: params.command,
        execCommand: execCommandOverride,
        workdir,
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
        timeoutSec: effectiveTimeout,
        onUpdate,
      });

      let yielded = false;
      let yieldTimer: NodeJS.Timeout | null = null;

      // Tool-call abort should not kill backgrounded sessions; timeouts still must.
      const onAbortSignal = () => {
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
