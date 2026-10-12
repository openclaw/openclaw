import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  streamSimple,
  type AssistantMessage,
  type Context,
  type ProviderStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

// Ollama 0.40.1 tools.findTool searches the retained envelope before the JSON
// name. Remove this workaround when supported servers parse structural names.
const TOOL_CALL_ENVELOPES = [
  "<tool_call>",
  "<tool_calls>",
  "[TOOL_CALLS]",
  "<|tool▁calls▁begin|><|tool▁call▁begin|>function<|tool▁sep|>",
  '{"name":"","arguments":',
];
const TOOL_CALL_REFERENCE_RE =
  /(?<![\p{L}\p{N}_./:-])tool_call(?![\p{L}\p{N}_/:-]|\.[\p{L}\p{N}_])/gu;

export function normalizeOllamaToolCallName(
  rawName: string,
  options: { availableToolNames?: ReadonlySet<string> } = {},
): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return trimmed;
  }
  const availableToolNames = options.availableToolNames;
  if (availableToolNames?.has(trimmed)) {
    return trimmed;
  }
  const strippedAnySeparator = trimmed.replace(/^(?:functions?|tools?)[./_-]+/iu, "").trim();
  if (
    availableToolNames &&
    strippedAnySeparator !== trimmed &&
    availableToolNames.has(strippedAnySeparator)
  ) {
    return strippedAnySeparator;
  }
  if (availableToolNames) {
    return trimmed;
  }
  return trimmed.replace(/^(?:functions?|tools?)[./]+/iu, "").trim();
}

function collectToolNames(context: Context): Set<string> {
  const names = new Set(context.tools?.map((tool) => tool.name));
  for (const message of context.messages) {
    if (message.role === "toolResult") {
      names.add(message.toolName);
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") {
          names.add(block.name);
        }
      }
    }
  }
  return names;
}

function mapAssistantNames(
  message: AssistantMessage,
  mapName: (name: string) => string,
): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === "toolCall" ? { ...block, name: mapName(block.name) } : block,
    ),
  };
}

function restoreStreamNames(
  stream: Awaited<ReturnType<StreamFn>>,
  fromWire: ReadonlyMap<string, string>,
): Awaited<ReturnType<StreamFn>> {
  const mapName = (name: string) => fromWire.get(name) ?? name;
  const result = stream.result.bind(stream);
  stream.result = async () => mapAssistantNames(await result(), mapName);
  const iterate = stream[Symbol.asyncIterator].bind(stream);
  // Keep the producer stream identity and settlement tracking. The shared message
  // transformer does not cover standalone toolcall_end or error event payloads.
  stream[Symbol.asyncIterator] = async function* () {
    for await (const event of { [Symbol.asyncIterator]: iterate }) {
      if (event.type === "done") {
        yield { ...event, message: mapAssistantNames(event.message, mapName) };
      } else if (event.type === "error") {
        yield { ...event, error: mapAssistantNames(event.error, mapName) };
      } else if (event.type === "toolcall_end") {
        yield {
          ...event,
          toolCall: { ...event.toolCall, name: mapName(event.toolCall.name) },
          partial: mapAssistantNames(event.partial, mapName),
        };
      } else {
        yield event.partial
          ? { ...event, partial: mapAssistantNames(event.partial, mapName) }
          : event;
      }
    }
  };
  return stream;
}

function mapToolChoice(choice: unknown, mapName: (name: string) => string): unknown {
  const mapFunction = (entry: unknown) =>
    isRecord(entry) &&
    entry.type === "function" &&
    isRecord(entry.function) &&
    typeof entry.function.name === "string"
      ? { ...entry, function: { ...entry.function, name: mapName(entry.function.name) } }
      : entry;
  if (
    isRecord(choice) &&
    choice.type === "allowed_tools" &&
    isRecord(choice.allowed_tools) &&
    Array.isArray(choice.allowed_tools.tools)
  ) {
    return {
      ...choice,
      allowed_tools: {
        ...choice.allowed_tools,
        tools: choice.allowed_tools.tools.map(mapFunction),
      },
    };
  }
  return mapFunction(choice);
}

export function wrapOllamaToolNames(baseFn: StreamFn | undefined): StreamFn {
  const underlying = baseFn ?? streamSimple;
  return (model, context, options) => {
    const names = collectToolNames(context);
    const toWire = new Map<string, string>();
    for (const name of [...names].toSorted()) {
      if (!name || !TOOL_CALL_ENVELOPES.some((envelope) => envelope.includes(name))) {
        continue;
      }
      let alias = `openclaw_${name}`;
      while (names.has(alias)) {
        alias = `openclaw_${alias}`;
      }
      toWire.set(name, alias);
      names.add(alias);
    }
    if (toWire.size === 0) {
      return underlying(model, context, options);
    }
    const activeNames = new Set(context.tools?.map((tool) => tool.name));
    const mapName = (name: string) =>
      toWire.get(
        normalizeOllamaToolCallName(name, {
          availableToolNames: activeNames.size ? activeNames : undefined,
        }),
      ) ?? name;
    const instructions = [...toWire]
      .filter(([name]) => activeNames.has(name))
      .map(([name, alias]) => `${name}: use ${alias}`);
    const toolCallAlias = activeNames.has("tool_call") ? toWire.get("tool_call") : undefined;
    if (toolCallAlias) {
      instructions.push(
        `Invoke deferred tools only through ${toolCallAlias} with {"id":"<catalog ID or name>","args":{<tool parameters>}}. Never call a deferred name or tool_call directly.`,
      );
    }
    const wireContext: Context = {
      ...context,
      systemPrompt: instructions.length
        ? [
            context.systemPrompt,
            "## Tool wire names\nUse these function names for the tools referenced in instructions; arguments and tool IDs are unchanged:",
            ...instructions,
          ]
            .filter(Boolean)
            .join("\n")
        : context.systemPrompt,
      tools: context.tools?.map((tool) => ({
        ...tool,
        name: mapName(tool.name),
        description:
          toolCallAlias && (tool.name === "tool_search" || tool.name === "tool_describe")
            ? tool.description.replace(TOOL_CALL_REFERENCE_RE, toolCallAlias)
            : tool.description,
      })),
      messages: context.messages.map((message) => {
        if (message.role === "assistant") {
          return mapAssistantNames(message, mapName);
        }
        return message.role === "toolResult"
          ? { ...message, toolName: mapName(message.toolName) }
          : message;
      }),
    };
    const providerOptions: ProviderStreamOptions = { ...options };
    if ("toolChoice" in providerOptions) {
      providerOptions.toolChoice = mapToolChoice(providerOptions.toolChoice, mapName);
    }
    const maybeStream = underlying(model, wireContext, {
      ...providerOptions,
      onPayload: async (payload, selectedModel) => {
        const replacement = await options?.onPayload?.(payload, selectedModel);
        const request = replacement === undefined ? payload : replacement;
        // OpenAI-compatible callers can choose a function through a payload hook.
        if (isRecord(request) && "tool_choice" in request) {
          request.tool_choice = mapToolChoice(request.tool_choice, mapName);
        }
        return replacement;
      },
    });
    const fromWire = new Map([...toWire].map(([name, alias]) => [alias, name]));
    return "then" in maybeStream
      ? maybeStream.then((stream) => restoreStreamNames(stream, fromWire))
      : restoreStreamNames(maybeStream, fromWire);
  };
}
