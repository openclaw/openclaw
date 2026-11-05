import { isRecord } from "@openclaw/normalization-core/record-coerce";
/**
 * Plugin-defined text replacement transforms for stream boundaries.
 *
 * Provider and CLI plugins can rewrite prompt/event text without owning the transport implementation.
 */
import type { AssistantMessage, AssistantMessageEvent } from "../llm/types.js";
import { mapAssistantMessageStream } from "../llm/utils/stream-wrapper.js";
import type { PluginTextReplacement, PluginTextTransforms } from "../plugins/cli-backend.types.js";
import { mapNestedStrings } from "../shared/map-nested-strings.js";
import type { StreamFn } from "./runtime/index.js";
import type { MutableAssistantMessageEventStream } from "./stream-compat.js";
import { createStreamIteratorWrapper } from "./stream-iterator-wrapper.js";

export function mergePluginTextTransforms(
  ...transforms: Array<PluginTextTransforms | undefined>
): PluginTextTransforms | undefined {
  const input = transforms.flatMap((entry) => entry?.input ?? []);
  const output = transforms.flatMap((entry) => entry?.output ?? []);
  if (input.length === 0 && output.length === 0) {
    return undefined;
  }
  return {
    ...(input.length > 0 ? { input } : {}),
    ...(output.length > 0 ? { output } : {}),
  };
}

export function applyPluginTextReplacements(
  text: string,
  replacements?: PluginTextReplacement[],
): string {
  if (!replacements || replacements.length === 0 || !text) {
    return text;
  }
  let next = text;
  for (const replacement of replacements) {
    next = next.replace(replacement.from, replacement.to);
  }
  return next;
}

function transformContentText(
  content: unknown,
  replacements?: PluginTextReplacement[],
  mode: "content" | "arguments" | "message" = "content",
): unknown {
  if (mode === "arguments") {
    return mapNestedStrings(content, (value) => applyPluginTextReplacements(value, replacements));
  }
  if (mode === "message" && !isRecord(content)) {
    return content;
  }
  if (typeof content === "string") {
    return applyPluginTextReplacements(content, replacements);
  }
  if (Array.isArray(content)) {
    return content.map((entry) => transformContentText(entry, replacements, mode));
  }
  if (!isRecord(content)) {
    return content;
  }
  const next = { ...content };
  if (mode === "content" && typeof next.text === "string") {
    next.text = applyPluginTextReplacements(next.text, replacements);
  }
  if (Object.hasOwn(next, "content")) {
    next.content = transformContentText(next.content, replacements);
  }
  if (mode === "content" && next.type === "toolCall" && Object.hasOwn(next, "arguments")) {
    next.arguments = transformContentText(next.arguments, replacements, "arguments");
  }
  if (mode === "message" && typeof next.errorMessage === "string") {
    next.errorMessage = applyPluginTextReplacements(next.errorMessage, replacements);
  }
  return next;
}

function transformAssistantEventText(
  event: unknown,
  replacements?: PluginTextReplacement[],
): AssistantMessageEvent {
  if (!isRecord(event) || !replacements || replacements.length === 0) {
    return event as AssistantMessageEvent;
  }
  const next = { ...event };
  if (next.type === "text_delta" && typeof next.delta === "string") {
    next.delta = applyPluginTextReplacements(next.delta, replacements);
  }
  if (next.type === "text_end" && typeof next.content === "string") {
    next.content = applyPluginTextReplacements(next.content, replacements);
  }
  if (
    next.type === "toolcall_end" &&
    isRecord(next.toolCall) &&
    Object.hasOwn(next.toolCall, "arguments")
  ) {
    // Tool names are routing identifiers; only argument values are text.
    next.toolCall = {
      ...next.toolCall,
      arguments: transformContentText(next.toolCall.arguments, replacements, "arguments"),
    };
  }
  for (const field of ["partial", "message", "error"]) {
    if (Object.hasOwn(next, field)) {
      next[field] = transformContentText(next[field], replacements, "message");
    }
  }
  return next as AssistantMessageEvent;
}

function wrapStreamTextTransforms(
  stream: MutableAssistantMessageEventStream,
  replacements?: PluginTextReplacement[],
): MutableAssistantMessageEventStream {
  if (!replacements || replacements.length === 0) {
    return stream;
  }
  const originalResult = stream.result.bind(stream);
  stream.result = async () =>
    transformContentText(await originalResult(), replacements, "message") as AssistantMessage;

  // Wrap async iteration so streamed deltas and the final result receive the
  // same output replacement policy.
  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  stream[Symbol.asyncIterator] = function () {
    return createStreamIteratorWrapper({
      iterator: originalAsyncIterator(),
      next: async (streamIterator) => {
        const result = await streamIterator.next();
        return result.done
          ? result
          : {
              done: false as const,
              value: transformAssistantEventText(result.value, replacements),
            };
      },
    });
  };
  return stream;
}

export function wrapStreamFnTextTransforms(params: {
  streamFn: StreamFn;
  input?: PluginTextReplacement[];
  output?: PluginTextReplacement[];
  transformSystemPrompt?: boolean;
}): StreamFn {
  return (model, context, options) => {
    const nextContext = params.input?.length
      ? ({
          ...context,
          systemPrompt:
            params.transformSystemPrompt !== false && context.systemPrompt !== undefined
              ? applyPluginTextReplacements(context.systemPrompt, params.input)
              : context.systemPrompt,
          messages: context.messages.map((message) =>
            transformContentText(message, params.input, "message"),
          ),
        } as Parameters<StreamFn>[1])
      : context;
    return mapAssistantMessageStream(params.streamFn(model, nextContext, options), (stream) =>
      wrapStreamTextTransforms(stream, params.output),
    );
  };
}
