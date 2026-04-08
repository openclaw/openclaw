import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";

const TOOL_CALLS_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const TOOL_CALLS_SECTION_END = "<|tool_calls_section_end|>";
const TOOL_CALL_BEGIN = "<|tool_call_begin|>";
const TOOL_CALL_ARGUMENT_BEGIN = "<|tool_call_argument_begin|>";
const TOOL_CALL_END = "<|tool_call_end|>";

type KimiToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type KimiParsedTextBlock = {
  content: Array<KimiToolCallBlock | { type: "text"; text: string }>;
  changed: boolean;
};

function stripTaggedToolCallCounter(value: string): string {
  return value.trim().replace(/:\d+$/, "");
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&#60;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#62;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&");
}

function parseKimiTaggedToolCalls(text: string): KimiToolCallBlock[] | null {
  const trimmed = text.trim();
  // Kimi emits tagged tool-call sections as standalone text blocks on this path.
  if (!trimmed.startsWith(TOOL_CALLS_SECTION_BEGIN) || !trimmed.endsWith(TOOL_CALLS_SECTION_END)) {
    return null;
  }

  let cursor = TOOL_CALLS_SECTION_BEGIN.length;
  const sectionEndIndex = trimmed.length - TOOL_CALLS_SECTION_END.length;
  const toolCalls: KimiToolCallBlock[] = [];

  while (cursor < sectionEndIndex) {
    while (cursor < sectionEndIndex && /\s/.test(trimmed[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor >= sectionEndIndex) {
      break;
    }
    if (!trimmed.startsWith(TOOL_CALL_BEGIN, cursor)) {
      return null;
    }

    const nameStart = cursor + TOOL_CALL_BEGIN.length;
    const argMarkerIndex = trimmed.indexOf(TOOL_CALL_ARGUMENT_BEGIN, nameStart);
    if (argMarkerIndex < 0 || argMarkerIndex >= sectionEndIndex) {
      return null;
    }

    const rawId = trimmed.slice(nameStart, argMarkerIndex).trim();
    if (!rawId) {
      return null;
    }

    const argsStart = argMarkerIndex + TOOL_CALL_ARGUMENT_BEGIN.length;
    const callEndIndex = trimmed.indexOf(TOOL_CALL_END, argsStart);
    if (callEndIndex < 0 || callEndIndex > sectionEndIndex) {
      return null;
    }

    const rawArgs = trimmed.slice(argsStart, callEndIndex).trim();
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      return null;
    }
    if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
      return null;
    }

    const name = stripTaggedToolCallCounter(rawId);
    if (!name) {
      return null;
    }

    toolCalls.push({
      type: "toolCall",
      id: rawId,
      name,
      arguments: parsedArgs as Record<string, unknown>,
    });

    cursor = callEndIndex + TOOL_CALL_END.length;
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

function parseKimiXmlToolCalls(xml: string): KimiToolCallBlock[] | null {
  const invokeRe = /<invoke\s+name=(["'])([^"']+)\1\s*>([\s\S]*?)<\/invoke>/gi;
  const parameterRe = /<parameter\s+name=(["'])([^"']+)\1\s*>([\s\S]*?)<\/parameter>/gi;
  const toolCalls: KimiToolCallBlock[] = [];
  let invokeMatch: RegExpExecArray | null = null;

  while ((invokeMatch = invokeRe.exec(xml)) !== null) {
    const rawName = decodeXmlText(invokeMatch[2] ?? "").trim();
    if (!rawName) {
      return null;
    }

    const invokeBody = invokeMatch[3] ?? "";
    const argumentsRecord: Record<string, unknown> = {};
    let sawParameter = false;
    let parameterMatch: RegExpExecArray | null = null;
    parameterRe.lastIndex = 0;

    while ((parameterMatch = parameterRe.exec(invokeBody)) !== null) {
      const paramName = decodeXmlText(parameterMatch[2] ?? "").trim();
      if (!paramName) {
        return null;
      }
      argumentsRecord[paramName] = decodeXmlText(parameterMatch[3] ?? "").trim();
      sawParameter = true;
    }

    if (!sawParameter) {
      return null;
    }

    toolCalls.push({
      type: "toolCall",
      id: `${rawName}:${toolCalls.length}`,
      name: rawName,
      arguments: argumentsRecord,
    });
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

function parseKimiXmlToolCallsInText(text: string): KimiParsedTextBlock | null {
  const functionCallsRe = /<function_calls\b[^>]*>([\s\S]*?)<\/function_calls>/gi;
  const content: Array<KimiToolCallBlock | { type: "text"; text: string }> = [];
  let lastIndex = 0;
  let changed = false;
  let match: RegExpExecArray | null = null;

  while ((match = functionCallsRe.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before) {
      content.push({ type: "text", text: before });
    }

    const parsed = parseKimiXmlToolCalls(match[1] ?? "");
    if (!parsed) {
      return null;
    }

    content.push(...parsed);
    changed = true;
    lastIndex = match.index + match[0].length;
  }

  if (!changed) {
    return null;
  }

  const after = text.slice(lastIndex);
  if (after) {
    content.push({ type: "text", text: after });
  }

  return { content, changed };
}

function parseKimiSimpleTaggedToolCallsInText(text: string): KimiParsedTextBlock | null {
  const simpleToolRe = /<exec>([\s\S]*?)<\/exec>/gi;
  const content: Array<KimiToolCallBlock | { type: "text"; text: string }> = [];
  let lastIndex = 0;
  let changed = false;
  let match: RegExpExecArray | null = null;

  while ((match = simpleToolRe.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before) {
      content.push({ type: "text", text: before });
    }

    const command = decodeXmlText(match[1] ?? "").trim();
    if (!command) {
      return null;
    }

    content.push({
      type: "toolCall",
      id: `exec:${content.filter((entry) => entry.type === "toolCall").length}`,
      name: "exec",
      arguments: { command },
    });
    changed = true;
    lastIndex = match.index + match[0].length;
  }

  if (!changed) {
    return null;
  }

  const after = text.slice(lastIndex);
  if (after) {
    content.push({ type: "text", text: after });
  }

  return { content, changed };
}

function parseKimiToolCallsInText(text: string): KimiParsedTextBlock | null {
  const tagged = parseKimiTaggedToolCalls(text);
  if (tagged) {
    return { content: tagged, changed: true };
  }
  const xml = parseKimiXmlToolCallsInText(text);
  if (xml) {
    return xml;
  }
  return parseKimiSimpleTaggedToolCallsInText(text);
}

function rewriteKimiTaggedToolCallsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }

  let changed = false;
  const nextContent: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      nextContent.push(block);
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type !== "text" || typeof typedBlock.text !== "string") {
      nextContent.push(block);
      continue;
    }

    const parsed = parseKimiToolCallsInText(typedBlock.text);
    if (!parsed) {
      nextContent.push(block);
      continue;
    }

    for (const nextBlock of parsed.content) {
      if (nextBlock.type === "text" && !nextBlock.text) {
        continue;
      }
      nextContent.push(nextBlock);
    }
    changed = changed || parsed.changed;
  }

  if (!changed) {
    return;
  }

  (message as { content: unknown[] }).content = nextContent;
  const typedMessage = message as { stopReason?: unknown };
  if (typedMessage.stopReason === "stop") {
    typedMessage.stopReason = "toolUse";
  }
}

function stripKimiAnthropicToolPayloadCompat<TModel extends { api?: unknown; compat?: unknown }>(
  model: TModel,
): TModel {
  if (model.api !== "anthropic-messages") {
    return model;
  }
  if (!model.compat || typeof model.compat !== "object" || Array.isArray(model.compat)) {
    return model;
  }

  const compat = model.compat as Record<string, unknown>;
  if (compat.requiresOpenAiAnthropicToolPayload !== true) {
    return model;
  }

  const nextCompat = { ...compat };
  delete nextCompat.requiresOpenAiAnthropicToolPayload;
  return {
    ...model,
    compat: Object.keys(nextCompat).length > 0 ? nextCompat : undefined,
  } as TModel;
}

function wrapKimiTaggedToolCalls(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    rewriteKimiTaggedToolCallsInMessage(message);
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as {
              partial?: unknown;
              message?: unknown;
            };
            rewriteKimiTaggedToolCallsInMessage(event.partial);
            rewriteKimiTaggedToolCallsInMessage(event.message);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };

  return stream;
}

export function createKimiToolCallMarkupWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const maybeStream = underlying(stripKimiAnthropicToolPayloadCompat(model), context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) => wrapKimiTaggedToolCalls(stream));
    }
    return wrapKimiTaggedToolCalls(maybeStream);
  };
}

export function wrapKimiProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  return createKimiToolCallMarkupWrapper(ctx.streamFn);
}
