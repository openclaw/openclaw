import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import {
  hasRuntimeContextMarker,
  supportsClaudeInHistorySystemMessages,
  type Context,
  type Model,
  type ToolResultMessage,
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
import { preparedRequestSuffix } from "../provider-options.js";
import type { AnthropicOptions, AnthropicThinkingDisplay } from "../provider-options.js";
import { transformProviderMessages } from "../provider-transcript-transform.js";
import {
  applyClaudeRequestContract,
  bindsClaudeThinkingPrefix,
  requiresClaudeAdaptiveThinking,
  requiresClaudeBetweenToolsThinking,
  resolveAnthropicThinkingEffort,
  resolveClaudeSonnet55ModelIdentity,
  resolveClaudeHaiku55ModelIdentity,
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
import { applyAnthropicPayloadHook } from "./anthropic-request-body.js";
import { resolveAnthropicMessagesMaxTokens } from "./anthropic-transport-options.js";
import { resolveProviderEndpoint } from "./host-policy.js";
import {
  coerceTransportToolCallArguments,
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

type AnthropicMessageProjection = {
  key: string;
  followingSources: Context["messages"];
  message: AnthropicWireMessage | undefined;
};

// Weak source ownership releases projections with history; route and grouped-result
// variants share the same bounded lifetime as Responses message projections.
const anthropicMessageProjections = new WeakMap<
  Context["messages"][number],
  AnthropicMessageProjection[]
>();

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";

async function convertContentBlocks(
  content: Readonly<ToolResultMessage["content"]>,
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
    const text = extractToolResultText(content);
    return text.trim()
      ? text
      : (mediaPlaceholder ??
          (profile === "transport" ? "(no output)" : isError ? "[tool error with no output]" : ""));
  }
  const blocks: Array<TextBlockParam | ImageBlockParam> = [];
  for (const block of content) {
    if (!asOptionalObjectRecord(block)) {
      continue;
    }
    const blockText = extractToolResultBlockText(block);
    if (blockText) {
      blocks.push({ type: "text", text: blockText });
    }
    if (!isImageWithMediaPayload(block)) {
      continue;
    }
    const [normalizedImage] = await normalizeAnthropicInlineContent(
      [
        typeof block.mimeType === "string"
          ? block
          : { ...block, mimeType: profile === "provider" ? "image/jpeg" : "image/png" },
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
  if (!blocks.some((block) => block.type === "text")) {
    blocks.unshift({ type: "text", text: mediaPlaceholder ?? "(see attached image)" });
  }
  return blocks;
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
    context.preparedSystemPrompt,
  );
  let toolProjection: AnthropicToolProjection | undefined;
  let eagerToolInputStreaming = false;
  if (context.tools) {
    const tools = context.tools;
    eagerToolInputStreaming =
      !managed && (model.compat?.supportsEagerToolInputStreaming ?? model.provider !== "fireworks");
    toolProjection = projectAnthropicTools(tools, (name) =>
      isOAuthToken ? toClaudeCodeToolName(name) : name,
    );
  }
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
        { preserveUnframedToolResults: preparedRequestSuffix.has(context) },
      )
    : transformProviderMessages(replayPlan.messages, model, normalizeAnthropicToolCallId);
  const allowReasoningContentReplay =
    managed && resolveProviderEndpoint(model).endpointClass === "xiaomi-native";
  const allowEmptySignature = model.compat?.allowEmptySignature;
  const compaction = replayPlan.compaction;
  const replayThinkingEnabled =
    requiresClaudeAdaptiveThinking(model) || options?.thinkingEnabled === true;
  const messages: AnthropicWireMessage[] = [];
  const appendMessage = (message: AnthropicWireMessage) => {
    if (message.role === "system" && (!messages.length || messages.at(-1)?.role === "assistant")) {
      // Replay can exclude a consult's user anchor. Preserve its updates in place
      // without moving them into the pinned system prompt or dropping instructions.
      messages.push({ role: "user", content: "." });
    }
    // Interrupted turns can leave a system update last; retain it before the next user turn.
    if (message.role === "user" && messages.at(-1)?.role === "system") {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
      });
    }
    messages.push(message);
  };
  const modelRetainsRuntimeContext = bindsClaudeThinkingPrefix(model);
  const inHistorySystemUpdates =
    !isOAuthToken && isDirectAnthropicModel(model) && supportsClaudeInHistorySystemMessages(model);
  const imageBudget = createAnthropicInlineImageBudget();
  const activeToolTurnAssistantIndex = replayThinkingEnabled
    ? -1
    : findActiveAnthropicToolTurnAssistantIndex(transformed);
  const convertMessage = async (
    msg: Context["messages"][number],
    i: number,
    end: number,
  ): Promise<AnthropicWireMessage | undefined> => {
    if (msg.role === "user") {
      const operatorMessage = inHistorySystemUpdates ? msg.operatorMessage : undefined;
      const sourceContent = msg.content;
      let content: AnthropicWireMessage["content"];
      if (typeof sourceContent === "string") {
        if (sourceContent.trim().length === 0) {
          return undefined;
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
          return undefined;
        }
      }
      return {
        role: operatorMessage ? "system" : "user",
        content: operatorMessage
          ? typeof content === "string"
            ? [{ type: "text", text: content }]
            : content.filter((block) => block.type === "text")
          : content,
        ...(operatorMessage?.turnScoped ? { clear_at: "next_user_message" as const } : {}),
      };
    }
    if (msg.role === "assistant") {
      const blocks: AnthropicReplayBlock[] = i === 0 && compaction ? [compaction] : [];
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
          if (!thinkingSignature && !allowEmptySignature) {
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
        return assistantMsg;
      }
      return undefined;
    }
    if (msg.role === "toolResult") {
      const toolResults: ToolResultBlockParam[] = [];
      for (let j = i; j < end; j++) {
        const nextMsg = transformed.at(j);
        if (nextMsg?.role !== "toolResult") {
          break;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: preparedRequestSuffix.has(context)
            ? preparedRequestSuffix.toolCallId(
                context,
                nextMsg.toolCallId,
                normalizeAnthropicToolCallId(nextMsg.toolCallId),
              )
            : nextMsg.toolCallId,
          content: await convertContentBlocks(
            nextMsg.content,
            model,
            imageBudget,
            profile,
            nextMsg.isError,
          ),
          is_error: nextMsg.isError,
        });
      }
      return {
        role: "user",
        content: toolResults,
      };
    }
    return undefined;
  };
  const immutable = getAiTransportHost().immutableData;
  const projectionKey = JSON.stringify([
    profile,
    model.provider,
    model.api,
    model.id,
    model.baseUrl,
    model.input.includes("image"),
    isOAuthToken,
    allowReasoningContentReplay,
    allowEmptySignature,
    replayThinkingEnabled,
    inHistorySystemUpdates,
  ]);
  const activeProjectionKey = `${projectionKey}:active`;
  const canReuse = (message: Context["messages"][number]) =>
    Boolean(immutable?.isPlainData) &&
    immutable?.isDeeplyFrozenPlainData(message) &&
    (typeof message.content === "string" ||
      !message.content.some((block) => block.type === "image"));
  for (let i = 0; i < transformed.length;) {
    const msg = transformed[i];
    if (!msg) {
      i++;
      continue;
    }
    let end = i + 1;
    if (msg.role === "toolResult") {
      while (transformed[end]?.role === "toolResult") {
        end++;
      }
    }
    // Image budgets and prepared suffix IDs are request-scoped. Compaction inserts
    // a request-owned block before replay; none of these enter the projection cache.
    let reusable = !compaction && !preparedRequestSuffix.has(context) && canReuse(msg);
    for (let j = i + 1; reusable && j < end; j++) {
      const following = transformed[j];
      reusable = following !== undefined && canReuse(following);
    }
    const key = i === activeToolTurnAssistantIndex ? activeProjectionKey : projectionKey;
    let projections = reusable ? anthropicMessageProjections.get(msg) : undefined;
    const projection = projections?.find(
      (entry) =>
        entry.key === key &&
        entry.followingSources.length === end - i - 1 &&
        entry.followingSources.every((source, index) => source === transformed[i + index + 1]),
    );
    let output = projection?.message;
    if (!projection) {
      output = await convertMessage(msg, i, end);
      if (reusable && immutable) {
        immutable.freezeJsonSnapshot(output);
        if (!projections) {
          projections = [];
          anthropicMessageProjections.set(msg, projections);
        }
        if (projections.length >= 8) {
          projections.shift();
        }
        projections.push({ key, followingSources: transformed.slice(i + 1, end), message: output });
      }
    }
    if (output) {
      appendMessage(output);
      if (msg.role === "user") {
        const runtimeContextRetained =
          msg.runtimeContext !== undefined
            ? msg.runtimeContext.retained
            : msg.runtimeContextCarrierRetained;
        if (
          hasRuntimeContextMarker(msg) &&
          !(runtimeContextRetained ?? modelRetainsRuntimeContext)
        ) {
          cacheBreakpointOptOutMessageIndexes.add(messages.length - 1);
        }
      }
    }
    i = end;
  }
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
  const generationParams: Pick<
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
    generationParams.temperature = options.temperature;
  }

  if (options?.stop !== undefined && options.stop.length > 0) {
    generationParams.stop_sequences = options.stop;
  }

  if (toolProjection && toolProjection.tools.length > 0) {
    generationParams.tools = toolProjection.tools.map((tool) => ({
      name: tool.wireName,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...(eagerToolInputStreaming ? { eager_input_streaming: true } : {}),
    }));
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
        generationParams.thinking = { type: "adaptive", display };
        const effort =
          options?.effort ??
          (mandatoryAdaptiveThinking
            ? resolveAnthropicThinkingEffort(model, undefined)
            : undefined);
        if (effort) {
          generationParams.output_config = { effort };
        }
      } else {
        generationParams.thinking = {
          type: "enabled",
          budget_tokens: options?.thinkingBudgetTokens ?? 1024,
          ...(profile === "provider" ? { display } : {}),
        };
      }
    } else if (options?.thinkingEnabled === false) {
      generationParams.thinking = requiresClaudeBetweenToolsThinking(model)
        ? { type: "between_tools" }
        : { type: "disabled" };
    }
  }

  if (options?.metadata) {
    const userId = options.metadata.user_id;
    if (typeof userId === "string") {
      generationParams.metadata = { user_id: userId };
    }
  }

  if (options?.toolChoice) {
    const normalizedToolChoice = normalizeAnthropicToolChoice(
      resolveClaudeHaiku55ModelIdentity(model) === undefined &&
        (mandatoryAdaptiveThinking ||
          options?.thinkingEnabled === true ||
          resolveClaudeSonnet55ModelIdentity(model) !== undefined),
      options.toolChoice,
    );
    const projectedToolChoice = toolProjection
      ? reconcileAnthropicToolChoice(normalizedToolChoice, toolProjection)
      : normalizedToolChoice;
    if (projectedToolChoice) {
      generationParams.tool_choice = projectedToolChoice;
    }
  }

  Object.assign(params, generationParams);
  applyAnthropicRequestCacheControl(
    params,
    cacheControl,
    supportsCacheControlOnTools,
    cacheBreakpointOptOutMessageIndexes,
  );
  return { params, toolProjection, replayedCompaction: replayPlan.compaction };
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
  const hooked = await applyAnthropicPayloadHook(params, model, options);
  params = hooked.params;
  applyClaudeRequestContract(params, model);
  const betaHeader = resolveAnthropicRequestBetaHeader(params, directApiKeyBetaHeader);
  const headers =
    applyAnthropicThinkingBindingControls(params, betaHeader) ??
    (betaHeader ? { "anthropic-beta": betaHeader } : undefined);
  return { params, headers, messageSources: hooked.messageSources };
}
