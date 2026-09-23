import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isOpenAIResponsesReplayContext } from "./openai-responses-compaction-replay.js";
import {
  responsesContinuationPrefixFingerprint,
  type ResponsesContinuationRequest,
} from "./openai-responses-continuation.js";
import {
  convertProviderResponsesMessages,
  convertResponsesMessages,
} from "./openai-responses-replay-messages-internal.js";
import {
  buildProviderReplayContext,
  providerReplayContextMatches,
} from "./provider-replay-context.js";
import { sha256Hex } from "./transport-utils.js";

type ReplayIdentity = { sessionId?: string; authProfileId?: string };
type Projection = "transport" | "provider";
const TOOL_CALL_PROVIDERS = new Set([
  "openai",
  "opencode",
  "azure-openai-responses",
  "github-copilot",
]);

function inputReplay(message: AssistantMessage) {
  const value =
    "openclawResponsesInputReplay" in message ? message.openclawResponsesInputReplay : undefined;
  return isRecord(value) ? value : undefined;
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
  return sha256Hex(
    stableStringify({ prefix: responsesContinuationPrefixFingerprint(input, output), reasoning }),
  );
}

/** Bind measured usage to the admitted replay prefix, without copying its content. */
export function recordResponsesContextUsage(
  message: AssistantMessage,
  model: Model,
  identity: ReplayIdentity | undefined,
  request: ResponsesContinuationRequest,
  output: readonly unknown[],
  projection: Projection,
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
  const replayOutput = convert(model, { messages: [message] }, TOOL_CALL_PROVIDERS, {
    ...identity,
    includeSystemPrompt: false,
  }).filter((item) => item.type !== "function_call_output");
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
    openclawResponsesInputReplay: { ...inputReplay(message), contextUsage },
  });
}

/** Only matching provider input may replace the conservative local pressure estimate. */
export function resolveResponsesContextUsageBoundary(
  messages: readonly { role: string }[],
  model: Model,
  identity: ReplayIdentity,
  systemPrompt?: string,
): { index: number; totalTokens: number; suffix: readonly unknown[] } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || !isAssistant(message)) {
      continue;
    }
    const state = inputReplay(message)?.contextUsage;
    const usage = message.usage.contextUsage;
    if (!isRecord(state) || usage?.state !== "available") {
      continue;
    }
    const { projection, prefixHash, prefixLength, promptTokens, totalTokens, includeSystemPrompt } =
      state;
    if (
      !isOpenAIResponsesReplayContext(state) ||
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
      TOOL_CALL_PROVIDERS,
      { ...identity, includeSystemPrompt: includeSystemPrompt === true },
    );
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
