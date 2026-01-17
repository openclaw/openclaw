import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { logInfo } from "../logger.js";
import { addSession, appendOutput, markBackgrounded, markExited } from "./bash-process-registry.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import {
  buildDockerExecArgs,
  buildSandboxEnv,
  chunkString,
  clampNumber,
  coerceEnv,
  killSession,
  readEnvInt,
  resolveSandboxWorkdir,
  resolveWorkdir,
  truncateMiddle,
} from "./bash-tools.shared.js";
import { getShellConfig, sanitizeBinaryOutput } from "./shell-utils.js";

const DEFAULT_MAX_OUTPUT = clampNumber(
  readEnvInt("PI_BASH_MAX_OUTPUT_CHARS"),
  30_000,
  1_000,
  150_000,
);
const DEFAULT_PATH =
  process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export type ExecToolDefaults = {
  backgroundMs?: number;
  timeoutSec?: number;
  sandbox?: BashSandboxConfig;
  elevated?: ExecElevatedDefaults;
  allowBackground?: boolean;
  scopeKey?: string;
  cwd?: string;
};

export type { BashSandboxConfig } from "./bash-tools.shared.js";

export type ExecElevatedDefaults = {
  enabled: boolean;
  allowed: boolean;
  defaultLevel: "on" | "off";
};

const execSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before backgrounding (default 10000)",
    }),
  ),
  background: Type.Optional(Type.Boolean({ description: "Run in background immediately" })),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, kills process on expiry)",
    }),
  ),
  elevated: Type.Optional(
    Type.Boolean({
      description: "Run on the host with elevated permissions (if allowed)",
    }),
  ),
});

export type ExecToolDetails =
  | {
      status: "running";
      sessionId: string;
      pid?: number;
      startedAt: number;
      cwd?: string;
      tail?: string;
    }
  | {
      status: "completed" | "failed";
      exitCode: number | null;
      durationMs: number;
      aggregated: string;
      cwd?: string;
    };

export function createExecTool(
  defaults?: ExecToolDefaults,
  // biome-ignore lint/suspicious/noExplicitAny: TypeBox schema type from pi-agent-core uses a different module instance.
): AgentTool<any, ExecToolDetails> {
  const defaultBackgroundMs = clampNumber(
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

  return {
    name: "exec",
    label: "exec",
    description:
      "Execute shell commands with background continuation. Use yieldMs/background to continue later via process tool. For real TTY mode, use the tmux skill.",
    parameters: execSchema,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      const params = args as {
        command: string;
        workdir?: string;
        env?: Record<string, string>;
        yieldMs?: number;
        background?: boolean;
        timeout?: number;
        elevated?: boolean;
      };

      if (!params.command) {
        throw new Error("Provide a command to start.");
      }

      const maxOutput = DEFAULT_MAX_OUTPUT;
      const startedAt = Date.now();
      const sessionId = randomUUID();
      const warnings: string[] = [];
      const backgroundRequested = params.background === true;
      const yieldRequested = typeof params.yieldMs === "number";
      if (!allowBackground && (backgroundRequested || yieldRequested)) {
        warnings.push("Warning: background execution is disabled; running synchronously.");
      }
      const yieldWindow = allowBackground
        ? backgroundRequested
          ? 0
          : clampNumber(params.yieldMs ?? defaultBackgroundMs, defaultBackgroundMs, 10, 120_000)
        : null;
      const elevatedDefaults = defaults?.elevated;
      const elevatedDefaultOn =
        elevatedDefaults?.defaultLevel === "on" &&
        elevatedDefaults.enabled &&
        elevatedDefaults.allowed;
      const elevatedRequested =
        typeof params.elevated === "boolean" ? params.elevated : elevatedDefaultOn;
      if (elevatedRequested) {
        if (!elevatedDefaults?.enabled || !elevatedDefaults.allowed) {
          const runtime = defaults?.sandbox ? "sandboxed" : "direct";
          const gates: string[] = [];
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
              "Fix-it keys:",
              "- tools.elevated.enabled",
              "- tools.elevated.allowFrom.<provider>",
              "- agents.list[].tools.elevated.enabled",
              "- agents.list[].tools.elevated.allowFrom.<provider>",
            ].join("\n"),
          );
        }
        logInfo(
          `exec: elevated command (${sessionId.slice(0, 8)}) ${truncateMiddle(
            params.command,
            120,
          )}`,
        );
      }

      const sandbox = elevatedRequested ? undefined : defaults?.sandbox;
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
      } else {
        workdir = resolveWorkdir(rawWorkdir, warnings);
      }

      const { shell, args: shellArgs } = getShellConfig();
      const baseEnv = coerceEnv(process.env);
      const mergedEnv = params.env ? { ...baseEnv, ...params.env } : baseEnv;
      const env = sandbox
        ? buildSandboxEnv({
            defaultPath: DEFAULT_PATH,
            paramsEnv: params.env,
            sandboxEnv: sandbox.env,
            containerWorkdir: containerWorkdir ?? sandbox.containerWorkdir,
          })
        : mergedEnv;
      const child = sandbox
        ? spawn(
            "docker",
            buildDockerExecArgs({
              containerName: sandbox.containerName,
              command: params.command,
              workdir: containerWorkdir ?? sandbox.containerWorkdir,
              env,
              tty: false,
            }),
            {
              cwd: workdir,
              env: process.env,
              detached: process.platform !== "win32",
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            },
          )
        : spawn(shell, [...shellArgs, params.command], {
            cwd: workdir,
            env,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });

      const session = {
        id: sessionId,
        command: params.command,
        scopeKey: defaults?.scopeKey,
        child,
        pid: child?.pid,
        startedAt,
        cwd: workdir,
        maxOutputChars: maxOutput,
        totalOutputChars: 0,
        pendingStdout: [],
        pendingStderr: [],
        aggregated: "",
        tail: "",
        exited: false,
        exitCode: undefined as number | null | undefined,
        exitSignal: undefined as NodeJS.Signals | number | null | undefined,
        truncated: false,
        backgrounded: false,
      };
      addSession(session);

      let settled = false;
      let yielded = false;
      let yieldTimer: NodeJS.Timeout | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let timeoutFinalizeTimer: NodeJS.Timeout | null = null;
      let timedOut = false;
      const timeoutFinalizeMs = 1000;
      let rejectFn: ((err: Error) => void) | null = null;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const effectiveTimeout =
        typeof params.timeout === "number" ? params.timeout : defaultTimeoutSec;
      const finalizeTimeout = () => {
        if (session.exited) return;
        markExited(session, null, "SIGKILL", "failed");
        if (settled || !rejectFn) return;
        const aggregated = session.aggregated.trim();
        const reason = `Command timed out after ${effectiveTimeout} seconds`;
        const message = aggregated ? `${aggregated}\n\n${reason}` : reason;
        settle(() => rejectFn?.(new Error(message)));
      };

      // Tool-call abort should not kill backgrounded sessions; timeouts still must.
      const onAbortSignal = () => {
        if (yielded || session.backgrounded) return;
        killSession(session);
      };

      // Timeouts always terminate, even for backgrounded sessions.
      const onTimeout = () => {
        timedOut = true;
        killSession(session);
        if (!timeoutFinalizeTimer) {
          timeoutFinalizeTimer = setTimeout(() => {
            finalizeTimeout();
          }, timeoutFinalizeMs);
        }
      };

      if (signal?.aborted) onAbortSignal();
      else if (signal) {
        signal.addEventListener("abort", onAbortSignal, { once: true });
      }
      if (effectiveTimeout > 0) {
        timeoutTimer = setTimeout(() => {
          onTimeout();
        }, effectiveTimeout * 1000);
      }

      const emitUpdate = () => {
        if (!onUpdate) return;
        const tailText = session.tail || session.aggregated;
        const warningText = warnings.length ? `${warnings.join("\n")}\n\n` : "";
        onUpdate({
          content: [{ type: "text", text: warningText + (tailText || "") }],
          details: {
            status: "running",
            sessionId,
            pid: session.pid ?? undefined,
            startedAt,
            cwd: session.cwd,
            tail: session.tail,
          },
        });
      };

      child.stdout.on("data", (data) => {
        const str = sanitizeBinaryOutput(data.toString());
        for (const chunk of chunkString(str)) {
          appendOutput(session, "stdout", chunk);
          emitUpdate();
        }
      });

      child.stderr.on("data", (data) => {
        const str = sanitizeBinaryOutput(data.toString());
        for (const chunk of chunkString(str)) {
          appendOutput(session, "stderr", chunk);
          emitUpdate();
        }
      });

      return new Promise<AgentToolResult<ExecToolDetails>>((resolve, reject) => {
        rejectFn = reject;
        const resolveRunning = () => {
          settle(() =>
            resolve({
              content: [
                {
                  type: "text",
                  text:
                    `${warnings.length ? `${warnings.join("\n")}\n\n` : ""}` +
                    `Command still running (session ${sessionId}, pid ${session.pid ?? "n/a"}). ` +
                    "Use process (list/poll/log/write/kill/clear/remove) for follow-up.",
                },
              ],
              details: {
                status: "running",
                sessionId,
                pid: session.pid ?? undefined,
                startedAt,
                cwd: session.cwd,
                tail: session.tail,
              },
            }),
          );
        };

        const onYieldNow = () => {
          if (yieldTimer) clearTimeout(yieldTimer);
          if (settled) return;
          yielded = true;
          markBackgrounded(session);
          resolveRunning();
        };

        if (allowBackground && yieldWindow !== null) {
          if (yieldWindow === 0) {
            onYieldNow();
          } else {
            yieldTimer = setTimeout(() => {
              if (settled) return;
              yielded = true;
              markBackgrounded(session);
              resolveRunning();
            }, yieldWindow);
          }
        }

        const handleExit = (code: number | null, exitSignal: NodeJS.Signals | number | null) => {
          if (yieldTimer) clearTimeout(yieldTimer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (timeoutFinalizeTimer) clearTimeout(timeoutFinalizeTimer);
          const durationMs = Date.now() - startedAt;
          const wasSignal = exitSignal != null;
          const isSuccess = code === 0 && !wasSignal && !signal?.aborted && !timedOut;
          const status: "completed" | "failed" = isSuccess ? "completed" : "failed";
          markExited(session, code, exitSignal, status);

          if (yielded || session.backgrounded) return;

          const aggregated = session.aggregated.trim();
          if (!isSuccess) {
            const reason = timedOut
              ? `Command timed out after ${effectiveTimeout} seconds`
              : wasSignal && exitSignal
                ? `Command aborted by signal ${exitSignal}`
                : code === null
                  ? "Command aborted before exit code was captured"
                  : `Command exited with code ${code}`;
            const message = aggregated ? `${aggregated}\n\n${reason}` : reason;
            settle(() => reject(new Error(message)));
            return;
          }

          settle(() =>
            resolve({
              content: [
                {
                  type: "text",
                  text:
                    `${warnings.length ? `${warnings.join("\n")}\n\n` : ""}` +
                    (aggregated || "(no output)"),
                },
              ],
              details: {
                status: "completed",
                exitCode: code ?? 0,
                durationMs,
                aggregated,
                cwd: session.cwd,
              },
            }),
          );
        };

        // `exit` can fire before stdio fully flushes (notably on Windows).
        // `close` waits for streams to close, so aggregated output is complete.
        child.once("close", (code, exitSignal) => {
          handleExit(code, exitSignal);
        });

        child.once("error", (err) => {
          if (yieldTimer) clearTimeout(yieldTimer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (timeoutFinalizeTimer) clearTimeout(timeoutFinalizeTimer);
          markExited(session, null, null, "failed");
          settle(() => reject(err));
        });
      });
    },
  };
}

export const execTool = createExecTool();
