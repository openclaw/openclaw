import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { transformProviderMessages as transformMessages } from "./provider-transcript-transform.js";
import type { ProviderMessage } from "./provider-types.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultText,
  isImageWithMediaPayload,
} from "./providers/tool-result-text.js";
import type { ResolvedOpenAICompletionsCompat } from "./transports/openai-completions-compat.js";
import type { Context, Model, ThinkingContent, ToolCall } from "./types.js";
import { sanitizeSurrogates } from "./utils/sanitize-unicode.js";
import {
  splitSystemPromptRelocatableBoundary,
  stripSystemPromptCacheBoundary,
  stripSystemPromptRelocatableBoundary,
} from "./utils/system-prompt-cache-boundary.js";

const EMPTY_TOOL_RESULT_TEXT = "(no output)";
type ChatCompletionContentPartVideo = {
  type: "video_url";
  video_url: { url: string };
};

function sanitizeToolResultText(text: string, fallback: string): string {
  const sanitized = sanitizeSurrogates(text);
  return sanitized.trim().length > 0 ? sanitized : fallback;
}

/** Whether replayed messages require a tools marker for proxy compatibility. */
export function hasToolCallHistory(messages: Context["messages"]): boolean {
  return messages.some(
    (message) =>
      message.role === "toolResult" ||
      (message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === "toolCall")),
  );
}

/** Convert a normalized transcript to OpenAI Chat Completions messages. */
export function convertMessages(
  model: Model<"openai-completions">,
  context: Context,
  compat: ResolvedOpenAICompletionsCompat,
  options: {
    cacheOptOutIndexes?: Set<number>;
    preserveSystemPromptCacheBoundary?: boolean;
  } = {},
): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];

  const normalizeToolCallId = (id: string): string => {
    // Responses ids can contain a pipe plus a long provider item id. Chat
    // Completions accepts only the call id prefix and caps it at 40 chars.
    if (id.includes("|")) {
      const callId = id.slice(0, id.indexOf("|"));
      return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    }

    if (model.provider === "openai") {
      return id.length > 40 ? truncateUtf16Safe(id, 40) : id;
    }
    return id;
  };

  const transformedMessages = transformMessages(context.messages, model, (id) =>
    normalizeToolCallId(id),
  ) as ProviderMessage[];

  // Local chat templates can place tools after system content. Move only the
  // bounded Runtime facts so session identifiers do not split that prefix.
  let relocatableSplit: { remainingPrompt: string; relocatable: string } | undefined;
  let systemParamIndex: number | undefined;
  if (context.systemPrompt) {
    const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
    const role = useDeveloperRole ? "developer" : "system";
    let systemPrompt: string;
    if (options.preserveSystemPromptCacheBoundary) {
      // Explicit message breakpoints retain the existing system layout.
      systemPrompt = stripSystemPromptRelocatableBoundary(context.systemPrompt);
    } else {
      const split = splitSystemPromptRelocatableBoundary(context.systemPrompt);
      if (split && split.relocatable.length > 0) {
        relocatableSplit = split;
      }
      systemPrompt = stripSystemPromptCacheBoundary(context.systemPrompt);
    }
    systemParamIndex = params.length;
    params.push({ role, content: sanitizeSurrogates(systemPrompt) });
  }

  let lastRole: string | null = null;

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    if (!msg) {
      continue;
    }
    if (
      compat.requiresAssistantAfterToolResult &&
      lastRole === "toolResult" &&
      msg.role === "user"
    ) {
      params.push({ role: "assistant", content: "I have processed the tool results." });
    }

    if (msg.role === "user") {
      const isRuntimeContextCarrier = msg.runtimeContextCarrier === true;
      if (typeof msg.content === "string") {
        const userParam: ChatCompletionMessageParam = {
          role: "user",
          content: sanitizeSurrogates(msg.content),
        };
        if (isRuntimeContextCarrier) {
          options.cacheOptOutIndexes?.add(params.length);
        }
        params.push(userParam);
      } else {
        const content: Array<ChatCompletionContentPart | ChatCompletionContentPartVideo> =
          msg.content.map((item) => {
            if (item.type === "text") {
              return {
                type: "text",
                text: sanitizeSurrogates(item.text),
              } satisfies ChatCompletionContentPartText;
            }
            if (item.type === "video") {
              return {
                type: "video_url",
                video_url: { url: `data:${item.mimeType};base64,${item.data}` },
              } satisfies ChatCompletionContentPartVideo;
            }
            return {
              type: "image_url",
              image_url: { url: `data:${item.mimeType};base64,${item.data}` },
            } satisfies ChatCompletionContentPartImage;
          });
        if (content.length === 0) {
          continue;
        }
        const userParam = { role: "user", content } as ChatCompletionMessageParam;
        if (isRuntimeContextCarrier) {
          options.cacheOptOutIndexes?.add(params.length);
        }
        params.push(userParam);
      }
    } else if (msg.role === "assistant") {
      const assistantMsg: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: compat.requiresAssistantAfterToolResult ? "" : null,
      };

      const assistantTexts: string[] = [];
      const nonEmptyThinkingBlocks: ThinkingContent[] = [];
      const toolCalls: ToolCall[] = [];
      msg.content.forEach((block) => {
        if (block.type === "text" && block.text.trim().length > 0) {
          assistantTexts.push(sanitizeSurrogates(block.text));
        } else if (block.type === "thinking" && block.thinking.trim().length > 0) {
          nonEmptyThinkingBlocks.push(block);
        } else if (block.type === "toolCall") {
          toolCalls.push(block);
        }
      });
      if (nonEmptyThinkingBlocks.length > 0 && compat.requiresThinkingAsText) {
        const thinkingText = nonEmptyThinkingBlocks
          .map((block) => sanitizeSurrogates(block.thinking))
          .join("\n\n");
        assistantMsg.content = [
          { type: "text", text: thinkingText },
          ...assistantTexts.map((text): ChatCompletionContentPartText => ({
            type: "text",
            text,
          })),
        ];
      } else {
        // Keep separate utterances apart in the interoperable string replay shape.
        const assistantText = assistantTexts.join("\n");
        if (assistantText.length > 0) {
          assistantMsg.content = assistantText;
        }
        if (nonEmptyThinkingBlocks.length > 0) {
          let signature = nonEmptyThinkingBlocks.at(0)?.thinkingSignature;
          if (model.provider === "opencode-go" && signature === "reasoning") {
            signature = "reasoning_content";
          }
          if (signature && signature.length > 0) {
            (assistantMsg as typeof assistantMsg & Record<string, unknown>)[signature] =
              nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
          }
        }
      }

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function" as const,
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          },
        }));
        const reasoningDetails = toolCalls.flatMap((toolCall) => {
          const signature = toolCall.thoughtSignature;
          if (!signature) {
            return [];
          }
          try {
            const parsed: unknown = JSON.parse(signature);
            return parsed ? [parsed] : [];
          } catch {
            return [];
          }
        });
        if (reasoningDetails.length > 0) {
          (
            assistantMsg as typeof assistantMsg & { reasoning_details?: unknown }
          ).reasoning_details = reasoningDetails;
        }
      }
      if (
        compat.requiresReasoningContentOnAssistantMessages &&
        model.reasoning &&
        (assistantMsg as { reasoning_content?: string }).reasoning_content === undefined
      ) {
        (assistantMsg as { reasoning_content?: string }).reasoning_content = "";
      }
      const content = assistantMsg.content;
      const hasContent = content !== null && content !== undefined && content.length > 0;
      if (!hasContent && !assistantMsg.tool_calls) {
        continue;
      }
      params.push(assistantMsg);
    } else if (msg.role === "toolResult") {
      const imageContentParts: Array<
        ChatCompletionContentPartText | { type: "image_url"; image_url: { url: string } }
      > = [];
      let j = i;

      while (j < transformedMessages.length) {
        const toolMsg = transformedMessages.at(j);
        if (toolMsg?.role !== "toolResult") {
          break;
        }

        const textResult = extractToolResultText(toolMsg.content);
        const mediaPlaceholder = describeToolResultMediaPlaceholder(toolMsg.content);
        const images = toolMsg.content.filter(isImageWithMediaPayload);
        const content = sanitizeToolResultText(
          textResult,
          mediaPlaceholder ?? EMPTY_TOOL_RESULT_TEXT,
        );
        const toolResultMsg: ChatCompletionToolMessageParam = {
          role: "tool",
          content,
          tool_call_id: toolMsg.toolCallId,
        };
        if (compat.requiresToolResultName && toolMsg.toolName) {
          (toolResultMsg as typeof toolResultMsg & { name?: string }).name = toolMsg.toolName;
        }
        params.push(toolResultMsg);

        if (images.length > 0 && model.input.includes("image")) {
          const boundedToolName = sanitizeSurrogates(truncateUtf16Safe(toolMsg.toolName ?? "", 64));
          // Count text-only replies too: names and bounded call IDs can collide.
          imageContentParts.push({
            type: "text",
            text: `Image(s) from tool result #${j - i + 1}${boundedToolName ? ` (${boundedToolName})` : ""}:`,
          });
          for (const block of images) {
            imageContentParts.push({
              type: "image_url",
              image_url: { url: `data:${block.mimeType};base64,${block.data}` },
            });
          }
        }
        j += 1;
      }

      i = j - 1;

      if (imageContentParts.length > 0) {
        if (compat.requiresAssistantAfterToolResult) {
          params.push({ role: "assistant", content: "I have processed the tool results." });
        }
        params.push({
          role: "user",
          content: imageContentParts,
        });
        lastRole = "user";
      } else {
        lastRole = "toolResult";
      }
      continue;
    }

    lastRole = msg.role;
  }

  if (relocatableSplit !== undefined && systemParamIndex !== undefined) {
    relocateNonBehavioralRegion({
      params,
      systemParamIndex,
      split: relocatableSplit,
      cacheOptOutIndexes: options.cacheOptOutIndexes,
    });
  }

  return params;
}

/** Commit relocation only after finding an emitted carrier. */
function relocateNonBehavioralRegion(args: {
  params: ChatCompletionMessageParam[];
  systemParamIndex: number;
  split: { remainingPrompt: string; relocatable: string };
  cacheOptOutIndexes?: Set<number>;
}): void {
  const text = sanitizeSurrogates(stripSystemPromptCacheBoundary(args.split.relocatable));
  // A trailing carrier would rewrite the earlier user turn on every follow-up.
  for (let index = args.systemParamIndex + 1; index < args.params.length; index++) {
    const param = args.params[index];
    if (!param || param.role !== "user") {
      continue;
    }
    if (typeof param.content === "string") {
      param.content = `${param.content}\n\n${text}`;
    } else if (Array.isArray(param.content)) {
      param.content = [
        ...param.content,
        { type: "text", text } satisfies ChatCompletionContentPartText,
      ];
    } else {
      continue;
    }
    // Shrink the system message only once a carrier turn is secured, so a
    // projected-away user turn leaves the region where it already is.
    const systemParam = args.params[args.systemParamIndex];
    if (systemParam) {
      systemParam.content = sanitizeSurrogates(
        stripSystemPromptCacheBoundary(args.split.remainingPrompt),
      );
    }
    // The turn now carries volatile text, so it must not anchor a cache breakpoint.
    args.cacheOptOutIndexes?.add(index);
    return;
  }
}
