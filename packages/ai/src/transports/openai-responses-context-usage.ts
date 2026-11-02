import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseInput } from "openai/resources/responses/responses.js";
import { preparedRequestSuffix } from "../provider-options.js";
import {
  responsesContinuationPrefixFingerprint,
  type ResponsesContinuationRequest,
} from "./openai-responses-continuation.js";
import { OPENAI_RESPONSES_TOOL_CALL_PROVIDERS } from "./openai-responses-contracts.js";
import { readResponsesInputReplayState } from "./openai-responses-input-replay.js";
import {
  cloneResponsesInputForPayloadHook,
  convertProviderResponsesMessages,
  convertResponsesMessages,
  type ConvertResponsesMessagesOptions,
} from "./openai-responses-replay-messages-internal.js";
import {
  buildProviderReplayContext,
  isProviderReplayContext,
  providerReplayContextMatches,
} from "./provider-replay-context.js";

type ReplayIdentity = NonNullable<Parameters<typeof buildProviderReplayContext>[1]>;

const preparedInput = Symbol("responsesContextUsageInput");
type PreparedContext = Context & {
  [preparedInput]?: {
    model: Model;
    messages: Context["messages"];
    systemPrompt: string | undefined;
    identity: ReplayIdentity;
    projection: "transport" | "provider";
    includeSystemPrompt: boolean;
    input: ResponseInput;
  };
};

/** Consume admission's projection once; context-replacing transforms do not inherit it. */
export function takeResponsesContextUsageInput(
  model: Model,
  context: PreparedContext,
  options: ConvertResponsesMessagesOptions,
): ResponseInput | undefined {
  const prepared = context[preparedInput];
  delete context[preparedInput];
  if (
    !prepared ||
    prepared.model !== model ||
    prepared.messages !== context.messages ||
    prepared.systemPrompt !== context.systemPrompt ||
    prepared.identity.sessionId !== options.sessionId ||
    prepared.identity.authProfileId !== options.authProfileId ||
    prepared.projection !== "transport" ||
    prepared.includeSystemPrompt !== options.includeSystemPrompt ||
    options.replayResponsesItemIds !== true ||
    options.replayMode !== "checkpoint" ||
    options.retainUserProvenance ||
    preparedRequestSuffix.has(context) ||
    (prepared.includeSystemPrompt && context.preparedSystemPrompt)
  ) {
    return undefined;
  }
  return options.mutableInput ? cloneResponsesInputForPayloadHook(prepared.input) : prepared.input;
}

function contextFingerprint(input: readonly unknown[], output: readonly unknown[] = []): string {
  // Continuation normalizes provider output into replayable input. Context accounting
  // additionally binds reasoning bytes, which continuation intentionally ignores.
  const reasoning = [...input, ...output].flatMap((item) => {
    if (!isRecord(item) || item.type !== "reasoning") {
      return [];
    }
    const { id: _id, status: _status, ...content } = item;
    return [content];
  });
  return sha256StableValue({
    prefix: responsesContinuationPrefixFingerprint(input, output),
    reasoning,
  }).digest;
}

/** Bind measured usage to the admitted replay prefix, without copying its content. */
export function recordResponsesContextUsage(
  message: AssistantMessage,
  model: Model,
  identity: ReplayIdentity | undefined,
  request: ResponsesContinuationRequest,
  output: readonly unknown[],
  projection: "transport" | "provider",
): void {
  const usage = message.usage.contextUsage;
  if (
    usage?.state !== "available" ||
    !Number.isSafeInteger(usage.totalTokens) ||
    usage.totalTokens <= 0 ||
    message.stopReason === "error" ||
    message.stopReason === "aborted" ||
    message.providerReplay ||
    request.previous_response_id ||
    !Array.isArray(request.input) ||
    !request.input.some((item: unknown) => isRecord(item) && item.type === "compaction") ||
    !Array.isArray(output) ||
    output.some((item) => isRecord(item) && item.type === "compaction")
  ) {
    return;
  }
  // A terminal snapshot may re-encrypt reasoning already emitted by the stream.
  // Bind the producer's persisted representation, which future requests replay.
  const convert =
    projection === "transport" ? convertResponsesMessages : convertProviderResponsesMessages;
  // Standalone projection repairs unmatched calls; those synthetic results are
  // not response output and remain outside the measured prefix.
  const replayOutput = convert(
    model,
    { messages: [message] },
    OPENAI_RESPONSES_TOOL_CALL_PROVIDERS,
    {
      ...identity,
      includeSystemPrompt: false,
    },
  ).filter((item) => item.type !== "function_call_output");
  const firstInput = request.input[0];
  const contextUsage = {
    ...buildProviderReplayContext(model, identity),
    projection,
    includeSystemPrompt:
      request.instructions === undefined &&
      firstInput?.type === "message" &&
      (firstInput.role === "developer" || firstInput.role === "system"),
    prefixHash: contextFingerprint(request.input, replayOutput),
    prefixLength: request.input.length + replayOutput.length,
    promptTokens: usage.promptTokens,
    totalTokens: usage.totalTokens,
  };
  Object.assign(message, {
    openclawResponsesInputReplay: { ...readResponsesInputReplayState(message), contextUsage },
  });
}

/** Only matching provider input may replace the conservative local pressure estimate. */
export function resolveResponsesContextUsageBoundary(
  messages: readonly { role: string }[],
  model: Model,
  identity: ReplayIdentity,
  systemPrompt?: string,
  requestContext?: Context,
): { index: number; totalTokens: number; suffix: readonly unknown[] } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || !isAssistant(message)) {
      continue;
    }
    const state = readResponsesInputReplayState(message)?.contextUsage;
    const usage = message.usage.contextUsage;
    if (!isRecord(state) || usage?.state !== "available") {
      continue;
    }
    const { projection, prefixHash, prefixLength, promptTokens, totalTokens, includeSystemPrompt } =
      state;
    if (
      !isProviderReplayContext(state) ||
      !providerReplayContextMatches(state, buildProviderReplayContext(model, identity)) ||
      message.provider !== model.provider ||
      message.api !== model.api ||
      message.model !== model.id ||
      (projection !== "transport" && projection !== "provider") ||
      typeof prefixHash !== "string" ||
      typeof prefixLength !== "number" ||
      !Number.isSafeInteger(prefixLength) ||
      prefixLength <= 0 ||
      promptTokens !== usage.promptTokens ||
      totalTokens !== usage.totalTokens ||
      !Number.isSafeInteger(usage.totalTokens) ||
      usage.totalTokens <= 0
    ) {
      return undefined;
    }
    const convert =
      projection === "transport" ? convertResponsesMessages : convertProviderResponsesMessages;
    const input = convert(
      model,
      { messages: messages.filter(isProviderMessage), systemPrompt },
      OPENAI_RESPONSES_TOOL_CALL_PROVIDERS,
      { ...identity, includeSystemPrompt: includeSystemPrompt === true },
    );
    if (requestContext) {
      // Non-enumerable: text/media/history transforms replace context via spreads.
      // Their different source contract must retain its own wire conversion.
      Object.defineProperty(requestContext, preparedInput, {
        configurable: true,
        value: {
          model,
          messages: requestContext.messages,
          systemPrompt,
          identity,
          projection,
          includeSystemPrompt: includeSystemPrompt === true,
          input,
        } satisfies NonNullable<PreparedContext[typeof preparedInput]>,
      });
    }
    if (
      input.length < prefixLength ||
      contextFingerprint(input.slice(0, prefixLength)) !== prefixHash
    ) {
      return undefined;
    }
    return { index, totalTokens: usage.totalTokens, suffix: input.slice(prefixLength) };
  }
  return undefined;
}

function isAssistant(message: { role: string }): message is AssistantMessage {
  return message.role === "assistant";
}

function isProviderMessage(message: { role: string }): message is Context["messages"][number] {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}
