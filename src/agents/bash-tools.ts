import type { AgentTool, AgentToolResult } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  addSession,
  appendOutput,
  deleteSession,
  drainSession,
  getFinishedSession,
  getSession,
  listFinishedSessions,
  listRunningSessions,
  markBackgrounded,
  markExited,
} from "./bash-process-registry.js";
import { getShellConfig, killProcessTree, sanitizeBinaryOutput } from "./shell-utils.js";

const CHUNK_LIMIT = 8 * 1024;
const DEFAULT_YIELD_MS = clampNumber(
  readEnvInt("PI_BASH_YIELD_MS"),
  20_000,
  10,
  120_000,
);
const DEFAULT_MAX_OUTPUT = clampNumber(
  readEnvInt("PI_BASH_MAX_OUTPUT_CHARS"),
  30_000,
  1_000,
  150_000,
);

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  workdir: Type.Optional(
    Type.String({ description: "Working directory (defaults to cwd)" }),
  ),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before backgrounding (default 20000)",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({ description: "Run in background immediately" }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, kills process on expiry)",
    }),
  ),
  stdinMode: Type.Optional(
    StringEnum(["pipe", "pty"] as const, {
      description: "Only pipe is supported",
    }),
  ),
});

export type BashToolDetails =
  | {
      status: "running";
      sessionId: string;
      pid?: number;
      startedAt: number;
      tail?: string;
    }
  | {
      status: "completed" | "failed";
      exitCode: number | null;
      durationMs: number;
      aggregated: string;
    };

export const bashTool: AgentTool<typeof bashSchema, BashToolDetails> = {
  name: "bash",
  label: "bash",
  description:
    "Execute bash with background continuation. Use yieldMs/background to continue later via process tool.",
  parameters: bashSchema,
  execute: async (toolCallId, args, signal, onUpdate) => {
    const params = args as {
      command: string;
      workdir?: string;
      env?: Record<string, string>;
      yieldMs?: number;
      background?: boolean;
      timeout?: number;
      stdinMode?: "pipe" | "pty";
    };

    if (!params.command) {
      throw new Error("Provide a command to start.");
    }
    if (params.stdinMode && params.stdinMode !== "pipe") {
      throw new Error('Only stdinMode "pipe" is supported right now.');
    }

    const yieldWindow = params.background
      ? 0
      : clampNumber(params.yieldMs, DEFAULT_YIELD_MS, 10, 120_000);
    const maxOutput = DEFAULT_MAX_OUTPUT;
    const startedAt = Date.now();
    const sessionId = randomUUID();
    const workdir = params.workdir?.trim() || process.cwd();

    const { shell, args: shellArgs } = getShellConfig();
    const child: ChildProcessWithoutNullStreams = spawn(
      shell,
      [...shellArgs, params.command],
      {
        cwd: workdir,
        env: { ...process.env, ...(params.env ?? {}) },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const session = {
      id: sessionId,
      command: params.command,
      child,
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
    let timedOut = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const onAbort = () => {
      if (child.pid) {
        killProcessTree(child.pid);
      }
    };

    if (signal?.aborted) onAbort();
    else if (signal) signal.addEventListener("abort", onAbort, { once: true });

    if (typeof params.timeout === "number" && params.timeout > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, params.timeout * 1000);
    }

    const emitUpdate = () => {
      if (!onUpdate) return;
      const tailText = session.tail || session.aggregated;
      onUpdate({
        content: [{ type: "text", text: tailText || "" }],
        details: {
          status: "running",
          sessionId,
          pid: child.pid ?? undefined,
          startedAt,
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

    return new Promise<AgentToolResult<BashToolDetails>>((resolve, reject) => {
      const resolveRunning = () => {
        settle(() =>
          resolve({
            content: [
              {
                type: "text",
                text:
                  `Command still running (session ${sessionId}, pid ${child.pid ?? "n/a"}). ` +
                  "Use process (list/poll/log/write/kill/clear) for follow-up.",
              },
            ],
            details: {
              status: "running",
              sessionId,
              pid: child.pid ?? undefined,
              startedAt,
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

      child.once("exit", (code, exitSignal) => {
        if (yieldTimer) clearTimeout(yieldTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const durationMs = Date.now() - startedAt;
        const wasSignal = exitSignal != null;
        const isSuccess = code === 0 && !wasSignal && !signal?.aborted && !timedOut;
        const status: "completed" | "failed" = isSuccess ? "completed" : "failed";
        markExited(session, code, exitSignal, status);

        if (yielded || session.backgrounded) return;

        const aggregated = session.aggregated.trim();
        if (!isSuccess) {
          const reason = timedOut
            ? `Command timed out after ${params.timeout} seconds`
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
            content: [{ type: "text", text: aggregated || "(no output)" }],
            details: {
              status: "completed",
              exitCode: code ?? 0,
              durationMs,
              aggregated,
            },
          }),
        );
      });

      child.once("error", (err) => {
        if (yieldTimer) clearTimeout(yieldTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        markExited(session, null, null, "failed");
        settle(() => reject(err));
      });
    });
  },
};

const processSchema = Type.Object({
  action: StringEnum(
    ["list", "poll", "log", "write", "kill", "clear", "remove"] as const,
    {
      description: "Process action",
    },
  ),
  sessionId: Type.Optional(
    Type.String({ description: "Session id for actions other than list" }),
  ),
  data: Type.Optional(Type.String({ description: "Data to write for write" })),
  eof: Type.Optional(Type.Boolean({ description: "Close stdin after write" })),
  offset: Type.Optional(Type.Number({ description: "Log offset" })),
  limit: Type.Optional(Type.Number({ description: "Log length" })),
});

export const processTool: AgentTool<typeof processSchema> = {
  name: "process",
  label: "process",
  description: "Manage running bash sessions: list, poll, log, write, kill.",
  parameters: processSchema,
  execute: async (_toolCallId, args) => {
    const params = args as {
      action: "list" | "poll" | "log" | "write" | "kill" | "clear" | "remove";
      sessionId?: string;
      data?: string;
      eof?: boolean;
      offset?: number;
      limit?: number;
    };

    if (params.action === "list") {
      const running = listRunningSessions().map((s) => ({
        sessionId: s.id,
        status: "running",
        pid: s.child.pid ?? undefined,
        startedAt: s.startedAt,
        runtimeMs: Date.now() - s.startedAt,
        cwd: s.cwd,
        command: s.command,
        tail: s.tail,
        truncated: s.truncated,
      }));
      const finished = listFinishedSessions().map((s) => ({
        sessionId: s.id,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        runtimeMs: s.endedAt - s.startedAt,
        cwd: s.cwd,
        command: s.command,
        tail: s.tail,
        truncated: s.truncated,
        exitCode: s.exitCode ?? undefined,
        exitSignal: s.exitSignal ?? undefined,
      }));
      const lines = [...running, ...finished]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(
          (s) =>
            `${s.sessionId.slice(0, 8)} ${pad(s.status, 9)} ${formatDuration(
              s.runtimeMs,
            )} :: ${truncateMiddle(s.command, 120)}`,
        );
      return {
        content: [
          { type: "text", text: lines.join("\n") || "No running or recent sessions." },
        ],
        details: { status: "completed", sessions: [...running, ...finished] },
      };
    }

    if (!params.sessionId) {
      return {
        content: [{ type: "text", text: "sessionId is required for this action." }],
        details: { status: "failed" },
      };
    }

    const session = getSession(params.sessionId);
    const finished = getFinishedSession(params.sessionId);

    switch (params.action) {
      case "poll": {
        if (!session) {
          if (finished) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    (finished.tail ||
                      `(no output recorded${
                        finished.truncated ? " — truncated to cap" : ""
                      })`) +
                    `\n\nProcess exited with ${
                      finished.exitSignal
                        ? `signal ${finished.exitSignal}`
                        : `code ${finished.exitCode ?? 0}`
                    }.`,
                },
              ],
              details: {
                status: finished.status === "completed" ? "completed" : "failed",
                sessionId: params.sessionId,
                exitCode: finished.exitCode ?? undefined,
                aggregated: finished.aggregated,
              },
            };
          }
          return {
            content: [
              { type: "text", text: `No session found for ${params.sessionId}` },
            ],
            details: { status: "failed" },
          };
        }
        if (!session.backgrounded) {
          return {
            content: [
              {
                type: "text",
                text: `Session ${params.sessionId} is not backgrounded.`,
              },
            ],
            details: { status: "failed" },
          };
        }
        const { stdout, stderr } = drainSession(session);
        const exited = session.exited;
        const exitCode = session.exitCode ?? 0;
        const exitSignal = session.exitSignal ?? undefined;
        if (exited) {
          const status =
            exitCode === 0 && exitSignal == null ? "completed" : "failed";
          markExited(session, session.exitCode ?? null, session.exitSignal ?? null, status);
        }
        const status = exited
          ? exitCode === 0 && exitSignal == null
            ? "completed"
            : "failed"
          : "running";
        const output = [stdout.trimEnd(), stderr.trimEnd()]
          .filter(Boolean)
          .join("\n")
          .trim();
        return {
          content: [
            {
              type: "text",
              text:
                (output || "(no new output)") +
                (exited
                  ? `\n\nProcess exited with ${
                      exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`
                    }.`
                  : "\n\nProcess still running."),
            },
          ],
          details: {
            status,
            sessionId: params.sessionId,
            exitCode: exited ? exitCode : undefined,
            aggregated: session.aggregated,
          },
        };
      }

      case "log": {
        if (session) {
          if (!session.backgrounded) {
            return {
              content: [
                {
                  type: "text",
                  text: `Session ${params.sessionId} is not backgrounded.`,
                },
              ],
              details: { status: "failed" },
            };
          }
          const total = session.aggregated.length;
          const slice = session.aggregated.slice(
            params.offset ?? 0,
            params.limit
              ? (params.offset ?? 0) + params.limit
              : undefined,
          );
          return {
            content: [{ type: "text", text: slice || "(no output yet)" }],
            details: {
              status: session.exited ? "completed" : "running",
              sessionId: params.sessionId,
              total,
              truncated: session.truncated,
            },
          };
        }
        if (finished) {
          const total = finished.aggregated.length;
          const slice = finished.aggregated.slice(
            params.offset ?? 0,
            params.limit
              ? (params.offset ?? 0) + params.limit
              : undefined,
          );
          const status = finished.status === "completed" ? "completed" : "failed";
          return {
            content: [
              { type: "text", text: slice || "(no output recorded)" },
            ],
            details: {
              status,
              sessionId: params.sessionId,
              total,
              truncated: finished.truncated,
              exitCode: finished.exitCode ?? undefined,
              exitSignal: finished.exitSignal ?? undefined,
            },
          };
        }
        return {
          content: [
            { type: "text", text: `No session found for ${params.sessionId}` },
          ],
          details: { status: "failed" },
        };
      }

      case "write": {
        if (!session) {
          return {
            content: [
              { type: "text", text: `No active session found for ${params.sessionId}` },
            ],
            details: { status: "failed" },
          };
        }
        if (!session.backgrounded) {
          return {
            content: [
              {
                type: "text",
                text: `Session ${params.sessionId} is not backgrounded.`,
              },
            ],
            details: { status: "failed" },
          };
        }
        if (!session.child.stdin || session.child.stdin.destroyed) {
          return {
            content: [
              {
                type: "text",
                text: `Session ${params.sessionId} stdin is not writable.`,
              },
            ],
            details: { status: "failed" },
          };
        }
        await new Promise<void>((resolve, reject) => {
          session.child.stdin.write(params.data ?? "", (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        if (params.eof) {
          session.child.stdin.end();
        }
        return {
          content: [
            {
              type: "text",
              text: `Wrote ${(params.data ?? "").length} bytes to session ${
                params.sessionId
              }${params.eof ? " (stdin closed)" : ""}.`,
            },
          ],
          details: { status: "running", sessionId: params.sessionId },
        };
      }

      case "kill": {
        if (!session) {
          return {
            content: [
              { type: "text", text: `No active session found for ${params.sessionId}` },
            ],
            details: { status: "failed" },
          };
        }
        if (!session.backgrounded) {
          return {
            content: [
              {
                type: "text",
                text: `Session ${params.sessionId} is not backgrounded.`,
              },
            ],
            details: { status: "failed" },
          };
        }
        if (session.child.pid) {
          killProcessTree(session.child.pid);
        }
        markExited(session, null, "SIGKILL", "failed");
        return {
          content: [
            { type: "text", text: `Killed session ${params.sessionId}.` },
          ],
          details: { status: "failed" },
        };
      }

      case "clear": {
        if (finished) {
          deleteSession(params.sessionId);
          return {
            content: [
              { type: "text", text: `Cleared session ${params.sessionId}.` },
            ],
            details: { status: "completed" },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `No finished session found for ${params.sessionId}`,
            },
          ],
          details: { status: "failed" },
        };
      }

      case "remove": {
        if (session) {
          if (session.child.pid) {
            killProcessTree(session.child.pid);
          }
          markExited(session, null, "SIGKILL", "failed");
          return {
            content: [
              { type: "text", text: `Removed session ${params.sessionId}.` },
            ],
            details: { status: "failed" },
          };
        }
        if (finished) {
          deleteSession(params.sessionId);
          return {
            content: [
              { type: "text", text: `Removed session ${params.sessionId}.` },
            ],
            details: { status: "completed" },
          };
        }
        return {
          content: [
            { type: "text", text: `No session found for ${params.sessionId}` },
          ],
          details: { status: "failed" },
        };
      }
    }

    return {
      content: [
        { type: "text", text: `Unknown action ${params.action as string}` },
      ],
      details: { status: "failed" },
    };
  },
};

function clampNumber(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
) {
  if (value === undefined || Number.isNaN(value)) return defaultValue;
  return Math.min(Math.max(value, min), max);
}

function readEnvInt(key: string) {
  const raw = process.env[key];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function chunkString(input: string, limit = CHUNK_LIMIT) {
  const chunks: string[] = [];
  for (let i = 0; i < input.length; i += limit) {
    chunks.push(input.slice(i, i + limit));
  }
  return chunks;
}

function truncateMiddle(str: string, max: number) {
  if (str.length <= max) return str;
  const half = Math.floor((max - 3) / 2);
  return `${str.slice(0, half)}...${str.slice(str.length - half)}`;
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m${rem.toString().padStart(2, "0")}s`;
}

function pad(str: string, width: number) {
  if (str.length >= width) return str;
  return str + " ".repeat(width - str.length);
}
