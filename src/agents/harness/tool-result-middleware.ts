import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareContext,
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "../../plugins/agent-tool-result-middleware-types.js";
import { listAgentToolResultMiddlewares } from "../../plugins/agent-tool-result-middleware.js";
import { truncateUtf16Safe } from "../../utils.js";

const log = createSubsystemLogger("agents/harness");
const MAX_MIDDLEWARE_CONTENT_BLOCKS = 200;
const MAX_MIDDLEWARE_TEXT_CHARS = 100_000;
const MAX_MIDDLEWARE_IMAGE_DATA_CHARS = 5_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidMiddlewareContentBlock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "text") {
    return typeof value.text === "string" && value.text.length <= MAX_MIDDLEWARE_TEXT_CHARS;
  }
  if (value.type === "image") {
    return (
      typeof value.mimeType === "string" &&
      value.mimeType.trim().length > 0 &&
      typeof value.data === "string" &&
      value.data.length <= MAX_MIDDLEWARE_IMAGE_DATA_CHARS
    );
  }
  return false;
}

function isValidMiddlewareToolResult(value: unknown): value is OpenClawAgentToolResult {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return false;
  }
  if (value.content.length > MAX_MIDDLEWARE_CONTENT_BLOCKS) {
    return false;
  }
  return value.content.every(isValidMiddlewareContentBlock);
}

function buildMiddlewareFailureResult(): OpenClawAgentToolResult {
  return {
    content: [
      {
        type: "text",
        text: "Tool output unavailable due to post-processing error.",
      },
    ],
    details: {
      status: "failed",
      middlewareError: true,
    },
  };
}

export function createAgentToolResultMiddlewareRunner(
  ctx: AgentToolResultMiddlewareContext,
  handlers: AgentToolResultMiddleware[] = listAgentToolResultMiddlewares(ctx.harness),
) {
  return {
    async applyToolResultMiddleware(
      event: AgentToolResultMiddlewareEvent,
    ): Promise<OpenClawAgentToolResult> {
      let current = event.result;
      for (const handler of handlers) {
        try {
          const next = await handler({ ...event, result: current }, ctx);
          if (next?.result) {
            if (isValidMiddlewareToolResult(next.result)) {
              current = next.result;
            } else {
              log.warn(
                `[${ctx.harness}] discarded invalid tool result middleware output for ${truncateUtf16Safe(
                  event.toolName,
                  120,
                )}`,
              );
            }
          }
        } catch {
          log.warn(
            `[${ctx.harness}] tool result middleware failed for ${truncateUtf16Safe(
              event.toolName,
              120,
            )}`,
          );
          return buildMiddlewareFailureResult();
        }
      }
      return current;
    },
  };
}
