import { createRequire } from "node:module";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessageEvent, ToolCall } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { log } from "./logger.js";

/**
 * Returns true only for a plain object with zero own keys (`{}`).
 */
export function isEmptyObject(v: unknown): boolean {
  return (
    v !== null &&
    v !== undefined &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v as Record<string, unknown>).length === 0
  );
}

/**
 * Pure function that normalizes a single AssistantMessageEvent.
 *
 * On `toolcall_delta`: if the `delta` field is a non-string object, captures
 * it in `capturedArgs` keyed by `contentIndex`. The event is returned as-is.
 *
 * On `toolcall_end`: if `toolCall.arguments` is `{}` and we have a captured
 * object for that `contentIndex`, replaces the arguments with the captured value.
 *
 * On `done`: repairs any tool calls in `message.content` that have empty
 * arguments but have a captured value.
 */
export function normalizeEvent(
  event: AssistantMessageEvent,
  capturedArgs: Map<number, Record<string, unknown>>,
): AssistantMessageEvent {
  if (event.type === "toolcall_delta") {
    const delta = (event as { delta: unknown }).delta;
    if (
      typeof delta !== "string" &&
      delta !== null &&
      delta !== undefined &&
      typeof delta === "object"
    ) {
      capturedArgs.set(event.contentIndex, delta as Record<string, unknown>);
    }
    return event;
  }

  if (event.type === "toolcall_end") {
    const captured = capturedArgs.get(event.contentIndex);
    if (captured && isEmptyObject(event.toolCall.arguments)) {
      log.debug(
        `[tool-args-normalizer] repairing empty arguments for tool "${event.toolCall.name}" ` +
          `(contentIndex=${event.contentIndex})`,
      );
      const repairedToolCall: ToolCall = {
        ...event.toolCall,
        arguments: captured,
      };
      const repairedPartial = { ...event.partial };
      if (Array.isArray(repairedPartial.content)) {
        repairedPartial.content = repairedPartial.content.map((c, i) =>
          i === event.contentIndex && c.type === "toolCall" ? { ...c, arguments: captured } : c,
        );
      }
      return {
        ...event,
        toolCall: repairedToolCall,
        partial: repairedPartial,
      };
    }
    return event;
  }

  if (event.type === "done") {
    if (capturedArgs.size === 0) {
      return event;
    }
    const message = event.message;
    let repaired = false;
    const repairedContent = message.content.map((c, i) => {
      if (c.type === "toolCall" && isEmptyObject(c.arguments)) {
        const captured = capturedArgs.get(i);
        if (captured) {
          repaired = true;
          log.debug(
            `[tool-args-normalizer] repairing empty arguments in done event for tool "${c.name}" ` +
              `(contentIndex=${i})`,
          );
          return { ...c, arguments: captured };
        }
      }
      return c;
    });
    if (repaired) {
      return {
        ...event,
        message: { ...message, content: repairedContent },
      };
    }
    return event;
  }

  return event;
}

/**
 * Creates a StreamFn wrapper that fixes tool call arguments being dropped to `{}`
 * when providers return `function.arguments` as an object instead of a JSON string.
 *
 * The pi-ai streaming parser accumulates arguments via string concatenation:
 *   `partialArgs += toolCall.function.arguments`
 * When a non-standard provider returns an object, this produces `"[object Object]"`
 * which `parseStreamingJson()` can't parse, yielding `{}`.
 *
 * The original object leaks through the `toolcall_delta` event's `delta` field.
 * This wrapper captures it and repairs the empty `{}` at `toolcall_end` and `done`.
 */
export function createToolArgsNormalizerWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  if (!baseStreamFn) {
    // Nothing to wrap — return a passthrough that would need a real streamFn.
    // This shouldn't happen in practice since applyExtraParamsToAgent always
    // has a streamFn by this point, but handle gracefully.
    return (...args) => {
      const esmRequire = createRequire(import.meta.url);
      const { streamSimple } = esmRequire(
        "@mariozechner/pi-ai",
      ) as typeof import("@mariozechner/pi-ai");
      return streamSimple(...args);
    };
  }

  return (...args) => {
    const maybeStream = baseStreamFn(...args);

    // baseStreamFn can return sync or Promise<AssistantMessageEventStream>
    const wrap = (originalStream: Awaited<ReturnType<StreamFn>>) => {
      const proxy = createAssistantMessageEventStream();
      const capturedArgs = new Map<number, Record<string, unknown>>();

      void (async () => {
        try {
          for await (const event of originalStream) {
            const normalized = normalizeEvent(event, capturedArgs);
            proxy.push(normalized);
          }
        } catch (err) {
          // If the original stream errors, push an error event to the proxy
          proxy.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: err instanceof Error ? err.message : String(err),
              api: "",
              provider: "",
              model: "",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              timestamp: Date.now(),
            },
          });
        }
      })();

      return proxy;
    };

    if (maybeStream instanceof Promise) {
      return maybeStream.then(wrap) as unknown as ReturnType<StreamFn>;
    }
    return wrap(maybeStream);
  };
}
