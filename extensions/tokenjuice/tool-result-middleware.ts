// Tokenjuice plugin module implements tool result middleware behavior.
import process from "node:process";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "openclaw/plugin-sdk/agent-harness";
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

function normaliseDetails(
  event: AgentToolResultMiddlewareEvent,
  current: OpenClawAgentToolResult,
): unknown {
  const isExecLike = event.toolName === "exec" || event.toolName === "bash";
  const hasObjectDetails = current.details != null && typeof current.details === "object";

  if (!isExecLike || !readCommand(event.args)) {
    return current.details;
  }
  // Details already contain a completed/failed status — pass through unchanged.
  if (hasObjectDetails && "status" in (current.details as Record<string, unknown>)) {
    return current.details;
  }
  const aggregated = readTextContent(current.content);
  if (!aggregated.trim()) {
    return current.details;
  }
  const synthesized = {
    status: event.isError ? "failed" : "completed",
    aggregated,
    exitCode: event.isError ? 1 : 0,
    cwd: readCwd(event),
  };
  // Merge: preserve existing metadata fields, then overlay synthesized exec fields.
  return hasObjectDetails
    ? { ...(current.details as Record<string, unknown>), ...synthesized }
    : synthesized;
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
          details: normaliseDetails(event, current),
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
