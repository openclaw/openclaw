import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareContext,
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "../../plugins/agent-tool-result-middleware-types.js";
import { createLazyPromiseLoader } from "../../shared/lazy-promise.js";
import { truncateUtf16Safe } from "../../utils.js";
import { readEmbeddedMessageDeliveryFact } from "../embedded-agent-message-delivery.js";
import { isDeliveredMessagingToolResult } from "../embedded-agent-message-tool-source-reply.js";
import { isMessagingToolSendAction } from "../embedded-agent-messaging.js";
import { isToolResultError } from "../tool-result-error.js";

const log = createSubsystemLogger("agents/harness");
const MAX_MIDDLEWARE_CONTENT_BLOCKS = 200;
const MAX_MIDDLEWARE_TEXT_CHARS = 100_000;
const MAX_MIDDLEWARE_CONTENT_DEPTH = 20;
const NESTED_TOOL_RESULT_BLOCK_TYPES = new Set(["toolresult", "tool_result"]);

type MiddlewareContentBlock = OpenClawAgentToolResult["content"][number];

function serializeMiddlewareValue(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") {
        return val.toString();
      }
      if (typeof val === "function" || typeof val === "symbol" || val === undefined) {
        return undefined;
      }
      if (val !== null && typeof val === "object") {
        if (seen.has(val)) {
          return undefined;
        }
        seen.add(val);
      }
      return val;
    });
  } catch {
    return undefined;
  }
}

function coerceMiddlewareText(value: unknown, depth: number): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (!isRecord(value) || depth >= MAX_MIDDLEWARE_CONTENT_DEPTH) {
    return undefined;
  }
  for (const key of ["text", "output", "result", "message"]) {
    const text = coerceMiddlewareText(value[key], depth + 1);
    if (text !== undefined) {
      return text;
    }
  }
  if (Array.isArray(value.content)) {
    const text = coerceMiddlewareContentArray(value.content, depth + 1)
      .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
      .join("\n");
    return text || undefined;
  }
  return serializeMiddlewareValue(value);
}

function appendMiddlewareContentBlock(
  blocks: MiddlewareContentBlock[],
  block: MiddlewareContentBlock,
): void {
  if (blocks.length >= MAX_MIDDLEWARE_CONTENT_BLOCKS) {
    return;
  }
  if (block.type !== "text") {
    blocks.push(block);
    return;
  }
  if (!block.text) {
    return;
  }
  const previous = blocks.at(-1);
  if (previous?.type !== "text") {
    blocks.push({
      type: "text",
      text: truncateUtf16Safe(block.text, MAX_MIDDLEWARE_TEXT_CHARS),
    });
    return;
  }
  const remainingChars = MAX_MIDDLEWARE_TEXT_CHARS - previous.text.length - 1;
  if (remainingChars > 0) {
    previous.text = `${previous.text}\n${truncateUtf16Safe(block.text, remainingChars)}`;
  }
}

function coerceMiddlewareContentArray(
  content: unknown[],
  depth: number,
  level: "result" | "nested" = "nested",
): MiddlewareContentBlock[] {
  const blocks: MiddlewareContentBlock[] = [];
  for (const entry of content.slice(0, MAX_MIDDLEWARE_CONTENT_BLOCKS)) {
    if (blocks.length >= MAX_MIDDLEWARE_CONTENT_BLOCKS) {
      break;
    }
    const coerced = coerceMiddlewareContentBlocks(entry, depth);
    if (level === "result") {
      blocks.push(...coerced.slice(0, MAX_MIDDLEWARE_CONTENT_BLOCKS - blocks.length));
      continue;
    }
    const text = coerced.length === 0 ? coerceMiddlewareText(entry, depth) : undefined;
    for (const block of text
      ? [{ type: "text" as const, text: truncateUtf16Safe(text, MAX_MIDDLEWARE_TEXT_CHARS) }]
      : coerced) {
      appendMiddlewareContentBlock(blocks, block);
    }
  }
  return blocks;
}

function coerceMiddlewareContentBlocks(value: unknown, depth: number): MiddlewareContentBlock[] {
  if (!isRecord(value) || typeof value.type !== "string") {
    return [];
  }
  if (value.type === "text" && typeof value.text === "string") {
    return [
      { ...value, type: "text", text: truncateUtf16Safe(value.text, MAX_MIDDLEWARE_TEXT_CHARS) },
    ];
  }
  if (
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  ) {
    return [{ ...value, type: "image", data: value.data, mimeType: value.mimeType }];
  }
  const normalizedType = value.type.toLowerCase();
  if (!NESTED_TOOL_RESULT_BLOCK_TYPES.has(normalizedType)) {
    return [];
  }
  const content = value.content;
  if (Array.isArray(content) && content.length > 0) {
    return depth < MAX_MIDDLEWARE_CONTENT_DEPTH
      ? coerceMiddlewareContentArray(content, depth + 1)
      : [];
  }
  const text = coerceMiddlewareText(content, depth) ?? coerceMiddlewareText(value, depth);
  if (!text) {
    return [];
  }
  return [
    {
      type: "text",
      text: truncateUtf16Safe(text, MAX_MIDDLEWARE_TEXT_CHARS),
    },
  ];
}

/** Older native runtimes wrap content in toolResult blocks (issue #82912). */
function normalizeNativeToolResult(value: OpenClawAgentToolResult): OpenClawAgentToolResult {
  if (
    !Array.isArray(value.content) ||
    !value.content.some(
      (block) =>
        isRecord(block) &&
        typeof block.type === "string" &&
        NESTED_TOOL_RESULT_BLOCK_TYPES.has(block.type.toLowerCase()),
    )
  ) {
    return value;
  }
  const content = coerceMiddlewareContentArray(value.content, 0, "result");
  if (content.length === 0) {
    throw new Error("Native tool result contains no usable content");
  }
  return { ...value, content };
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
      status: "error",
      middlewareError: true,
    },
  };
}

function buildDeliveredMessagingFailureFallback(
  event: AgentToolResultMiddlewareEvent,
  result: OpenClawAgentToolResult,
): OpenClawAgentToolResult | undefined {
  const deliveryFact = readEmbeddedMessageDeliveryFact(
    isRecord(result.details) ? result.details.messageDelivery : undefined,
  );
  const delivered = deliveryFact
    ? deliveryFact.status === "settled"
    : isDeliveredMessagingToolResult({
        toolName: event.toolName,
        args: event.args,
        result,
        requirePluginDeliveryId: true,
      });
  if (
    event.isError === true ||
    isToolResultError(result) ||
    !isMessagingToolSendAction(event.toolName, event.args) ||
    !delivered
  ) {
    return undefined;
  }
  return {
    content: [{ type: "text", text: "Message delivered, but result post-processing failed." }],
    details: {
      ok: true,
      deliveryStatus: "sent",
      middlewareWarning: "post-processing failed",
    },
  };
}

function reconcileDeliveredMessagingFailure(
  result: OpenClawAgentToolResult,
  fallback: OpenClawAgentToolResult | undefined,
): OpenClawAgentToolResult {
  return fallback && isRecord(result.details) && result.details.middlewareError === true
    ? fallback
    : result;
}

export function createAgentToolResultMiddlewareRunner(
  ctx: AgentToolResultMiddlewareContext,
  handlers?: AgentToolResultMiddleware[],
) {
  const resolvedHandlersLoader = createLazyPromiseLoader(async () => {
    const { loadAgentToolResultMiddlewaresForRuntime } =
      await import("../../plugins/agent-tool-result-middleware-loader.js");
    return loadAgentToolResultMiddlewaresForRuntime({
      runtime: ctx.runtime,
    });
  });
  return {
    async applyToolResultMiddleware(
      event: AgentToolResultMiddlewareEvent,
    ): Promise<OpenClawAgentToolResult> {
      const handlersForRun = await (handlers ?? resolvedHandlersLoader.load());
      if (handlersForRun.length === 0) {
        return event.result;
      }
      // Retain confirmed delivery before middleware can change its presentation.
      const deliveredMessagingFallback = buildDeliveredMessagingFailureFallback(
        event,
        event.result,
      );
      const fail = (message: string) => {
        log.warn(`[${ctx.runtime}] ${message} for ${truncateUtf16Safe(event.toolName, 120)}`);
        return reconcileDeliveredMessagingFailure(
          buildMiddlewareFailureResult(),
          deliveredMessagingFallback,
        );
      };
      try {
        // Loaded middleware follows the SDK's by-reference value contract;
        // only the legacy native content wrapper needs adaptation here.
        let current = normalizeNativeToolResult(event.result);
        for (const handler of handlersForRun) {
          const next = await handler({ ...event, result: current }, ctx);
          current = normalizeNativeToolResult(next?.result ?? current);
        }
        return reconcileDeliveredMessagingFailure(current, deliveredMessagingFallback);
      } catch {
        return fail("tool result middleware failed");
      }
    },
  };
}
