// Tokenjuice plugin module implements tool result middleware behavior.
import process from "node:process";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "openclaw/plugin-sdk/agent-harness";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createTokenjuiceOpenClawEmbeddedExtension } from "./runtime-api.js";

type TokenjuiceToolResultHandler = (
  event: {
    toolName: string;
    input: Record<string, unknown>;
    content: OpenClawAgentToolResult["content"];
    details: unknown;
    isError?: boolean;
  },
  ctx: { cwd: string },
) => Promise<Partial<OpenClawAgentToolResult> | void> | Partial<OpenClawAgentToolResult> | void;

function readCwd(event: AgentToolResultMiddlewareEvent): string {
  if (event.cwd?.trim()) {
    return event.cwd;
  }
  const workdir = event.args.workdir;
  if (typeof workdir === "string" && workdir.trim()) {
    return workdir;
  }
  return process.cwd();
}

function readTextContent(content: OpenClawAgentToolResult["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
        return item.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function readCommand(args: Record<string, unknown>): string {
  const command = args.command;
  return typeof command === "string" ? command : "";
}

function hasStatus(details: Record<string, unknown>): boolean {
  const status = details.status;
  return typeof status === "string" && status.trim() !== "";
}

function hasFailureState(
  event: AgentToolResultMiddlewareEvent,
  details: Record<string, unknown> | undefined,
): boolean {
  const exitCode = details?.exitCode;
  return (
    event.isError === true ||
    details?.ok === false ||
    details?.success === false ||
    details?.timedOut === true ||
    Boolean(details?.error) ||
    (typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0)
  );
}

function normalizeDetails(
  event: AgentToolResultMiddlewareEvent,
  current: OpenClawAgentToolResult,
): unknown {
  const isExecLike = event.toolName === "exec" || event.toolName === "bash";
  const details = isRecord(current.details) ? current.details : undefined;

  if (!isExecLike || !readCommand(event.args)) {
    return current.details;
  }
  // A concrete status is already canonical. Other terminal hints are preserved below
  // while supplying only the completed/failed status Tokenjuice requires.
  if (details && hasStatus(details)) {
    return current.details;
  }
  const aggregated = readTextContent(current.content);
  if (!aggregated.trim()) {
    return current.details;
  }
  const failed = hasFailureState(event, details);
  const existingExitCode = details?.exitCode;
  const exitCode =
    typeof existingExitCode === "number" && Number.isFinite(existingExitCode)
      ? existingExitCode
      : failed
        ? 1
        : 0;
  const synthesized = {
    status: failed ? "failed" : "completed",
    aggregated,
    exitCode,
  };
  if (!details) {
    return synthesized;
  }
  return {
    ...synthesized,
    ...details,
    status: synthesized.status,
    exitCode: synthesized.exitCode,
  };
}

export function createTokenjuiceAgentToolResultMiddleware(): AgentToolResultMiddleware {
  const handlers: TokenjuiceToolResultHandler[] = [];
  createTokenjuiceOpenClawEmbeddedExtension()({
    on(event, handler) {
      if (event === "tool_result") {
        handlers.push(handler as TokenjuiceToolResultHandler);
      }
    },
  });

  return async (event) => {
    let current = event.result;
    for (const handler of handlers) {
      const next = await handler(
        {
          toolName: event.toolName,
          input: event.args,
          content: current.content,
          details: normalizeDetails(event, current),
          isError: event.isError,
        },
        { cwd: readCwd(event) },
      );
      if (next) {
        current = Object.assign({}, current, {
          content: next.content ?? current.content,
          details: next.details ?? current.details,
        });
      }
    }
    return current === event.result ? undefined : { result: current };
  };
}
