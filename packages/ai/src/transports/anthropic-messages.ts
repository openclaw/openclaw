import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  Tool as AnthropicTool,
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import {
  hasRuntimeContextMarker,
  supportsClaudeInHistorySystemMessages,
  type Context,
  type Model,
  type Tool,
} from "@openclaw/llm-core";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { getAiTransportHost } from "../host.js";
import {
  createAnthropicInlineImageBudget,
  normalizeAnthropicInlineContent,
  resolveAnthropicImageMediaType,
  type AnthropicInlineImageBudget,
} from "../internal/anthropic-inline-images.js";
import { isImageWithMediaPayload } from "../media-payload.js";
import type { AnthropicOptions, AnthropicThinkingDisplay } from "../provider-options.js";
import { transformProviderMessages } from "../provider-transcript-transform.js";
import {
  applyClaudeRequestContract,
  bindsClaudeThinkingPrefix,
  requiresClaudeAdaptiveThinking,
  requiresClaudeBetweenToolsThinking,
  resolveAnthropicThinkingEffort,
  resolveClaudeSonnet55ModelIdentity,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeXhighEffort,
} from "../providers/anthropic-model-contract.js";
import { ANTHROPIC_SERVER_SIDE_FALLBACKS } from "../providers/anthropic-server-fallback.js";
import {
  applyAnthropicThinkingBindingControls,
  ANTHROPIC_OMITTED_REASONING_TEXT,
  findActiveAnthropicToolTurnAssistantIndex,
} from "../providers/anthropic-thinking-replay.js";
import {
  normalizeAnthropicToolCallId,
  toClaudeCodeToolName,
  normalizeAnthropicToolChoice,
  reconcileAnthropicToolChoice,
  projectAnthropicTools,
  type AnthropicToolProjection,
} from "../providers/anthropic-tool-projection.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultBlockText,
  extractToolResultText,
} from "../providers/tool-result-text.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../replay-turn-classification.js";
import {
  buildAnthropicReplayPlan,
  type AnthropicCompactionBlock,
} from "./anthropic-compaction-replay.js";
import {
  applyAnthropicContextManagementToRequest,
  applyAnthropicRequestCacheControl,
  buildAnthropicSystemBlocks,
  isDirectAnthropicModel,
  resolveAnthropicCacheOptions,
  resolveAnthropicRequestBetaHeader,
} from "./anthropic-payload-policy.js";
import { resolveAnthropicMessagesMaxTokens } from "./anthropic-transport-options.js";
import { resolveProviderEndpoint } from "./host-policy.js";
import {
  coerceTransportToolCallArguments,
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

type AnthropicReplayBlock =
  | ContentBlockParam
  | AnthropicCompactionBlock
  | {
      type: "redacted_thinking";
      data?: string;
    };

type AnthropicWireMessage = {
  role: "user" | "assistant" | "system";
  content: string | AnthropicReplayBlock[];
  reasoning_content?: string;
  clear_at?: "next_user_message";
};

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";

async function convertContentBlocks(
  content: readonly unknown[],
  model: { input: readonly string[] },
  imageBudget: AnthropicInlineImageBudget,
  profile: "provider" | "transport",
  isError: boolean,
) {
  const mediaPlaceholder = describeToolResultMediaPlaceholder(content);
  const hasImages =
    (profile === "provider" || model.input.includes("image")) &&
    content.some(isImageWithMediaPayload);
  if (!hasImages) {
    return sanitizeNonEmptyTransportPayloadText(
      extractToolResultText(content),
      mediaPlaceholder ??
        (profile === "transport" ? "(no output)" : isError ? "[tool error with no output]" : ""),
    );
  }
  const blocks: Array<TextBlockParam | ImageBlockParam> = [];
  let hasTextBlock = false;
  for (const block of content) {
    const record = asOptionalObjectRecord(block);
    if (!record) {
      continue;
    }
    const blockText = extractToolResultBlockText(block);
    if (blockText) {
      blocks.push({ type: "text", text: sanitizeTransportPayloadText(blockText) });
      hasTextBlock = true;
    }
    if (!isImageWithMediaPayload(record)) {
      continue;
    }
    const [normalizedImage] = await normalizeAnthropicInlineContent(
      [
        {
          type: "image" as const,
          data: typeof record.data === "string" ? record.data : "",
          mimeType:
            typeof record.mimeType === "string"
              ? record.mimeType
              : profile === "provider"
                ? "image/jpeg"
                : "image/png",
        },
      ],
      imageBudget,
    );
    if (normalizedImage?.type !== "image") {
      continue;
    }
    blocks.push({
      type: "image" as const,
      source: {
        type: "base64",
        media_type: resolveAnthropicImageMediaType(normalizedImage.mimeType),
        data: normalizedImage.data,
      },
    });
  }
  if (!hasTextBlock) {
    blocks.unshift({ type: "text", text: mediaPlaceholder ?? "(see attached image)" });
  }
  return blocks;
}

async function convertAnthropicMessages(
  transformedMessages: Context["messages"],
  model: Model<"anthropic-messages">,
  isOAuthToken: boolean,
  options: {
    allowReasoningContentReplay?: boolean;
    compaction?: AnthropicCompactionBlock;
    replayThinkingEnabled?: boolean;
    allowEmptySignature?: boolean;
    profile: "provider" | "transport";
    /** Emitted indexes of transient carriers that cannot anchor the cached prefix. */
    cacheBreakpointOptOutMessageIndexes?: Set<number>;
  },
): Promise<AnthropicWireMessage[]> {
  const params: AnthropicWireMessage[] = [];
  const appendMessage = (message: AnthropicWireMessage) => {
    // Interrupted turns can leave a system update last; retain it before the next user turn.
    if (message.role === "user" && params.at(-1)?.role === "system") {
      params.push({
        role: "assistant",
        content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
      });
    }
    params.push(message);
  };
  const modelRetainsRuntimeContext = bindsClaudeThinkingPrefix(model);
  const inHistorySystemUpdates =
    !isOAuthToken && isDirectAnthropicModel(model) && supportsClaudeInHistorySystemMessages(model);
  const imageBudget = createAnthropicInlineImageBudget();
  const allowReasoningContentReplay = options.allowReasoningContentReplay === true;
  const replayThinkingEnabled = options.replayThinkingEnabled !== false;
  const managed = options.profile === "transport";
  const activeToolTurnAssistantIndex = replayThinkingEnabled
    ? -1
    : findActiveAnthropicToolTurnAssistantIndex(transformedMessages);
  for (let i = 0; i < transformedMessages.length; i += 1) {
    const msg = transformedMessages[i];
    if (!msg) {
      continue;
    }
    if (msg.role === "user") {
      const operatorMessage = inHistorySystemUpdates ? msg.operatorMessage : undefined;
      const sourceContent = msg.content;
      let content: AnthropicWireMessage["content"];
      if (typeof sourceContent === "string") {
        if (sourceContent.trim().length === 0) {
          continue;
        }
        content = sanitizeTransportPayloadText(sourceContent);
      } else {
        const normalizedContent =
          !managed || model.input.includes("image")
            ? await normalizeAnthropicInlineContent(sourceContent, imageBudget)
            : sourceContent.map((item) =>
                item.type === "image"
                  ? { type: "text" as const, text: NON_VISION_USER_IMAGE_PLACEHOLDER }
                  : item,
              );
        const blocks: Array<TextBlockParam | ImageBlockParam> = normalizedContent.map((item) =>
          item.type === "text"
            ? {
                type: "text",
                text: sanitizeTransportPayloadText(item.text),
              }
            : {
                type: "image",
                source: {
                  type: "base64",
                  media_type: resolveAnthropicImageMediaType(item.mimeType),
                  data: item.data,
                },
              },
        );
        content = blocks.filter((block) =>
          block.type === "text"
            ? block.text.trim().length > 0
            : !managed || model.input.includes("image"),
        );
        if (content.length === 0) {
          continue;
        }
      }
      appendMessage({
        role: operatorMessage ? "system" : "user",
        content: operatorMessage
          ? typeof content === "string"
            ? [{ type: "text", text: content }]
            : content.filter((block) => block.type === "text")
          : content,
        ...(operatorMessage?.turnScoped ? { clear_at: "next_user_message" as const } : {}),
      });
      const runtimeContextRetained =
        msg.runtimeContext !== undefined
          ? msg.runtimeContext.retained
          : msg.runtimeContextCarrierRetained;
      if (hasRuntimeContextMarker(msg) && !(runtimeContextRetained ?? modelRetainsRuntimeContext)) {
        options.cacheBreakpointOptOutMessageIndexes?.add(params.length - 1);
      }
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: AnthropicReplayBlock[] =
        i === 0 && options.compaction ? [options.compaction] : [];
      const reasoningContent: string[] = [];
      let omittedThinking = false;
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) {
            blocks.push({
              type: "text",
              text: sanitizeTransportPayloadText(block.text),
            });
          }
          continue;
        }
        if (block.type === "thinking") {
          const thinkingSignature = block.thinkingSignature?.trim();
          const isReasoningContent = thinkingSignature === "reasoning_content";
          if (
            !replayThinkingEnabled &&
            i !== activeToolTurnAssistantIndex &&
            (!managed || !isReasoningContent)
          ) {
            omittedThinking = true;
            continue;
          }
          if (block.redacted) {
            if (!managed && !block.thinkingSignature) {
              throw new Error("redacted thinking block is missing its opaque signature");
            }
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature,
            });
            continue;
          }
          const hasNativeThinkingSignature = Boolean(thinkingSignature) && !isReasoningContent;
          if (block.thinking.trim().length === 0 && !hasNativeThinkingSignature) {
            continue;
          }
          if (!thinkingSignature && !options.allowEmptySignature) {
            blocks.push({
              type: "text",
              text: sanitizeTransportPayloadText(block.thinking),
            });
          } else if (!isReasoningContent || allowReasoningContentReplay) {
            const thinking = isReasoningContent
              ? sanitizeTransportPayloadText(block.thinking)
              : block.thinking;
            blocks.push({ type: "thinking", thinking, signature: thinkingSignature ?? "" });
            if (isReasoningContent) {
              reasoningContent.push(thinking);
            }
          }
          continue;
        }
        if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: isOAuthToken ? toClaudeCodeToolName(block.name) : block.name,
            input: managed
              ? coerceTransportToolCallArguments(block.arguments)
              : (block.arguments ?? {}),
          });
        }
      }
      if (blocks.length === 0 && omittedThinking) {
        blocks.push({ type: "text", text: ANTHROPIC_OMITTED_REASONING_TEXT });
      }
      if (blocks.length > 0) {
        const assistantMsg: AnthropicWireMessage = { role: "assistant", content: blocks };
        if (reasoningContent.length > 0) {
          assistantMsg.reasoning_content = reasoningContent.join("\n");
        } else if (allowReasoningContentReplay) {
          blocks.unshift({
            type: "thinking",
            thinking: "",
            signature: "reasoning_content",
          });
        }
        params.push(assistantMsg);
      }
      continue;
    }
    if (msg.role === "toolResult") {
      const toolResults: ToolResultBlockParam[] = [];
      let j = i;
      while (j < transformedMessages.length) {
        const nextMsg = transformedMessages.at(j);
        if (nextMsg?.role !== "toolResult") {
          break;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: await convertContentBlocks(
            nextMsg.content,
            model,
            imageBudget,
            options.profile,
            nextMsg.isError,
          ),
          is_error: nextMsg.isError,
        });
        j += 1;
      }
      i = j - 1;
      appendMessage({
        role: "user",
        content: toolResults,
      });
    }
  }
  return params;
}

/** Shared generation contract, after each entry point resolves its defaults and tool policy. */
function buildAnthropicGenerationParams({
  model,
  options,
  tools,
  toolProjection,
  profile,
}: {
  model: Model<"anthropic-messages">;
  options?: AnthropicOptions;
  tools?: AnthropicTool[];
  toolProjection?: AnthropicToolProjection;
  profile: "provider" | "transport";
}) {
  const params: Pick<
    MessageCreateParamsStreaming,
    "temperature" | "stop_sequences" | "tools" | "output_config" | "metadata" | "tool_choice"
  > & {
    // SDK 0.127.0 does not yet include Sonnet 5.5's between_tools setting.
    thinking?: MessageCreateParamsStreaming["thinking"] | { type: "between_tools" };
  } = {};
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  // Thinking and post-4.6 Claude models reject custom temperature values.
  if (
    options?.temperature !== undefined &&
    !options?.thinkingEnabled &&
    !supportsClaudeNativeXhighEffort(model)
  ) {
    params.temperature = options.temperature;
  }

  if (options?.stop !== undefined && options.stop.length > 0) {
    params.stop_sequences = options.stop;
  }

  if (tools && tools.length > 0) {
    params.tools = tools;
  }

  // Configure thinking mode: always-on adaptive (Fable 5 and Mythos 5),
  // adaptive (Opus 4.6+ and Sonnet 4.6),
  // budget-based (older models), or explicitly disabled.
  if (mandatoryAdaptiveThinking || model.reasoning || supportsClaudeAdaptiveThinking(model)) {
    if (mandatoryAdaptiveThinking || options?.thinkingEnabled) {
      // Default to "summarized" so Opus 4.7+ and Mythos Preview behave like
      // older Claude 4 models (whose API default is also "summarized").
      const display: AnthropicThinkingDisplay = options?.thinkingDisplay ?? "summarized";
      if (supportsClaudeAdaptiveThinking(model)) {
        params.thinking = { type: "adaptive", display };
        const effort =
          options?.effort ??
          (mandatoryAdaptiveThinking
            ? resolveAnthropicThinkingEffort(model, undefined)
            : undefined);
        if (effort) {
          params.output_config = { effort };
        }
      } else {
        params.thinking = {
          type: "enabled",
          budget_tokens: options?.thinkingBudgetTokens ?? 1024,
          ...(profile === "provider" ? { display } : {}),
        };
      }
    } else if (options?.thinkingEnabled === false) {
      params.thinking = requiresClaudeBetweenToolsThinking(model)
        ? { type: "between_tools" }
        : { type: "disabled" };
    }
  }

  if (options?.metadata) {
    const userId = options.metadata.user_id;
    if (typeof userId === "string") {
      params.metadata = { user_id: userId };
    }
  }

  if (options?.toolChoice) {
    const normalizedToolChoice = normalizeAnthropicToolChoice(
      mandatoryAdaptiveThinking ||
        options?.thinkingEnabled === true ||
        resolveClaudeSonnet55ModelIdentity(model) !== undefined,
      options.toolChoice,
    );
    const projectedToolChoice = toolProjection
      ? reconcileAnthropicToolChoice(normalizedToolChoice, toolProjection)
      : normalizedToolChoice;
    if (projectedToolChoice) {
      params.tool_choice = projectedToolChoice;
    }
  }

  return params;
}

function convertAnthropicTools(
  tools: Tool[],
  isOAuthTokenLocal: boolean,
  supportsEagerToolInputStreaming = false,
): {
  projection: AnthropicToolProjection;
  tools: AnthropicTool[];
} {
  const projection = projectAnthropicTools(tools, (name) =>
    isOAuthTokenLocal ? toClaudeCodeToolName(name) : name,
  );
  return {
    projection,
    tools: projection.tools.map((tool) => {
      const projected: AnthropicTool = {
        name: tool.wireName,
        description: tool.description,
        input_schema: tool.inputSchema,
      };
      if (supportsEagerToolInputStreaming) {
        projected.eager_input_streaming = true;
      }
      return projected;
    }),
  };
}

/** Assemble both public Messages routes without changing their replay/default profiles. */
export async function buildAnthropicRequest(
  model: Model<"anthropic-messages">,
  context: Context,
  options: (AnthropicOptions & { authProfileId?: string }) | undefined,
  profile: "provider" | "transport",
  isOAuthToken: boolean,
  serverSideFallback: boolean,
  claudeCodeVersion?: string,
) {
  const managed = profile === "transport";
  const maxTokens = managed
    ? resolveAnthropicMessagesMaxTokens({
        modelContextWindow: model.contextWindow,
        modelMaxTokens: model.maxTokens,
        requestedMaxTokens: options?.maxTokens,
      })
    : (options?.maxTokens ?? model.maxTokens);
  if (managed && maxTokens === undefined) {
    throw new Error(
      `Anthropic Messages transport requires a positive maxTokens value for ${model.provider}/${model.id}`,
    );
  }
  const { cacheControl, supportsCacheControlOnTools } = resolveAnthropicCacheOptions(
    model,
    options?.cacheRetention,
  );
  const system = buildAnthropicSystemBlocks(
    context.systemPrompt,
    isOAuthToken,
    cacheControl,
    claudeCodeVersion,
  );
  const convertedTools = context.tools
    ? convertAnthropicTools(
        context.tools,
        isOAuthToken,
        !managed &&
          (model.compat?.supportsEagerToolInputStreaming ?? model.provider !== "fireworks"),
      )
    : undefined;
  const toolProjection = convertedTools?.projection;
  const replayPlan = buildAnthropicReplayPlan(context.messages, model, {
    enabled: !isOAuthToken && options?.anthropicServerCompaction === true,
    authProfileId: options?.authProfileId,
    sessionId: options?.sessionId,
  });
  const cacheBreakpointOptOutMessageIndexes = new Set<number>();
  const transformed = managed
    ? getAiTransportHost().transformTransportMessages(
        replayPlan.messages,
        model,
        normalizeAnthropicToolCallId,
        undefined,
      )
    : transformProviderMessages(replayPlan.messages, model, normalizeAnthropicToolCallId);
  const messages = await convertAnthropicMessages(transformed, model, isOAuthToken, {
    profile,
    allowReasoningContentReplay:
      managed && resolveProviderEndpoint(model).endpointClass === "xiaomi-native",
    allowEmptySignature: model.compat?.allowEmptySignature,
    compaction: replayPlan.compaction,
    replayThinkingEnabled:
      requiresClaudeAdaptiveThinking(model) || options?.thinkingEnabled === true,
    cacheBreakpointOptOutMessageIndexes,
  });
  if (managed && messages.length === 0) {
    messages.push({ role: "user", content: "." });
  }
  const params: MessageCreateParamsStreaming = {
    model:
      managed && isDirectAnthropicModel(model) ? model.id.replace(/^anthropic\//i, "") : model.id,
    // SAFETY: the API accepts in-history system messages and compaction blocks absent from the SDK union.
    messages: messages as MessageParam[],
    max_tokens: maxTokens ?? model.maxTokens,
    stream: true,
  };
  if (system) {
    params.system = system;
  }
  if (serverSideFallback) {
    Object.assign(params, { fallbacks: ANTHROPIC_SERVER_SIDE_FALLBACKS });
  }
  Object.assign(
    params,
    buildAnthropicGenerationParams({
      model,
      options,
      tools: convertedTools?.tools,
      toolProjection,
      profile,
    }),
  );
  applyAnthropicRequestCacheControl(
    params,
    cacheControl,
    supportsCacheControlOnTools,
    cacheBreakpointOptOutMessageIndexes,
  );
  return { params, toolProjection, usedCompactionReplay: replayPlan.compaction !== undefined };
}

/** Apply caller payload edits before restoring required request contracts and beta headers. */
export async function prepareAnthropicRequest(
  initialParams: MessageCreateParamsStreaming,
  model: Model<"anthropic-messages">,
  options: AnthropicOptions | undefined,
  directApiKeyBetaHeader: string | undefined,
) {
  let params = initialParams;
  applyAnthropicContextManagementToRequest(params, model, options, directApiKeyBetaHeader);
  const nextParams = await options?.onPayload?.(params, model);
  if (nextParams !== undefined) {
    // SAFETY: the public payload hook owns the replacement request shape.
    params = nextParams as MessageCreateParamsStreaming;
  }
  applyClaudeRequestContract(params, model);
  const betaHeader = resolveAnthropicRequestBetaHeader(params, directApiKeyBetaHeader);
  const headers =
    applyAnthropicThinkingBindingControls(params, betaHeader) ??
    (betaHeader ? { "anthropic-beta": betaHeader } : undefined);
  return { params, headers };
}
