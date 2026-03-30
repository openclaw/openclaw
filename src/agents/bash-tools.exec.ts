import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type ExecHost, loadExecApprovals, maxAsk, minSecurity } from "../infra/exec-approvals.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { sanitizeHostExecEnvWithDiagnostics } from "../infra/host-env-security.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import { logInfo } from "../logger.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
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

/**
 * The regex used to detect /approve slash commands.
 * Case-insensitive, supports optional @mention suffix.
 * Anchored to the start of a *segment* (after splitting on shell separators).
 */
const APPROVE_COMMAND_RE = /^\s*\/approve(?:@[^\s]*)?(\s|$)/i;

/**
 * Split a single shell line into command segments separated by
 * `&&`, `||`, `;`, `|`, or `&` (background operator). This is a best-effort
 * heuristic — it does not handle quoted strings containing these operators,
 * but that is acceptable for a safety guard (false positives are safe,
 * false negatives are the risk).
 */
function splitShellSegments(line: string): string[] {
  return line.split(/\s*(?:&&|\|\||[;&|])\s*/);
}

/**
 * Detect a heredoc opening on a line. Returns the delimiter word or null.
 * Supports: <<EOF  <<'EOF'  <<"EOF"  <<-EOF  <<-'EOF-1'  <<"EOF_2"
 * Uses [\w-]+ to cover delimiters with hyphens (e.g. END-OF-DATA).
 *
 * To avoid false positives on quoted text like `echo " <<EOF"`, we first
 * strip content inside single and double quotes before testing for `<<`.
 */
function detectHeredocDelimiter(line: string): string | null {
  // Remove quoted strings so that `echo " <<EOF"` does not match,
  // but preserve quotes that are part of heredoc syntax (e.g. <<'EOF').
  const stripped = line.replace(/(?<!<<-?\s*)(['"])(?:(?!\1).)*\1/g, "");
  const m = stripped.match(/(?:^|\s)<<-?\s*['"]?([\w-]+)['"]?/);
  return m ? m[1] : null;
}

/**
 * Check whether any *executable* segment in a shell command contains /approve.
 *
 * This is a **best-effort defence layer** (layer 3 of 3). The primary fixes
 * are in the system prompt (layer 1) and the approval-pending tool output
 * (layer 2). A perfect check would require a full shell parser, which is
 * out of scope; this guard catches the realistic attack vectors produced
 * by LLM-generated commands.
 *
 * - Lines inside heredoc bodies are skipped (no false positives on data).
 * - Each executable line is split on shell separators (`&&`, `||`, `;`, `|`, `&`)
 *   so that `/approve` after a separator is detected.
 */
export function containsApproveCommand(command: string): boolean {
  const lines = command.split("\n");
  let heredocDelimiter: string | null = null;
  for (const line of lines) {
    // If we are inside a heredoc body, check for the closing delimiter.
    if (heredocDelimiter !== null) {
      if (line.trim() === heredocDelimiter) {
        heredocDelimiter = null;
      }
      continue; // skip data lines
    }
    // Detect heredoc start on this line.
    const delim = detectHeredocDelimiter(line);
    if (delim) {
      heredocDelimiter = delim;
    }
    // Test every segment of the line (split on shell operators).
    for (const segment of splitShellSegments(line)) {
      if (APPROVE_COMMAND_RE.test(segment)) {
        return true;
      }
    }
  }
  return false;
}

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
    description:
      "Execute shell commands with background continuation. Use yieldMs/background to continue later via process tool. Use pty=true for TTY-required commands (terminal UIs, coding agents).",
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

      // Guard: /approve is a slash command for the chat input, not a shell command.
      // Executing it via exec triggers a new approval-pending, causing an infinite loop.
      // See: https://github.com/openclaw/openclaw/issues/57432
      //
      // All executable lines are checked. Heredoc/here-string bodies are skipped
      // so that `/approve` literals inside data blocks do not false-positive.
      // Flag: i (case-insensitive) matches /APPROVE, /Approve, etc. aligned with
      //       the slash-command parser in commands-approve.ts.
      // The optional @mention group covers `/approve@botname ...` foreign-mention syntax.
      if (containsApproveCommand(params.command)) {
        throw new Error(
          "/approve is a chat slash command, not a shell command. " +
            "Show the /approve command to the user as a chat message instead of executing it via exec.",
        );
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

      const configuredSecurity = defaults?.security ?? (host === "sandbox" ? "deny" : "allowlist");
      const requestedSecurity = normalizeExecSecurity(params.security);
      let security = minSecurity(configuredSecurity, requestedSecurity ?? configuredSecurity);
      if (elevatedRequested && elevatedMode === "full") {
        security = "full";
      }
      // Keep local exec defaults in sync with exec-approvals.json when tools.exec.ask is unset.
      const configuredAsk = defaults?.ask ?? loadExecApprovals().defaults?.ask ?? "on-miss";
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
