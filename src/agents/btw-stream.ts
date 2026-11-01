import { isAnthropicOAuthApiKey } from "@openclaw/ai/internal/anthropic";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { streamWithPayloadPatch } from "../llm/providers/stream-wrappers/stream-payload-utils.js";
import type { AssistantMessageEvent, Message, Model } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import { buildBtwQuestionPrompt, buildBtwSystemPrompt } from "./btw-prompts.js";
import type { RunBtwSideQuestionParams } from "./btw-runtime.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";
import { applyExtraParamsToAgent } from "./embedded-agent-runner/extra-params.js";
import { materializeProviderContext } from "./embedded-agent-runner/run/images.js";
import { wrapStreamFnWithMessageTransform } from "./embedded-agent-runner/run/message-transform-stream-wrapper.js";
import { prepareEmbeddedSessionForkContext } from "./embedded-agent-runner/session-fork-context.js";
import { runEmbeddedSessionFork } from "./embedded-agent-runner/session-fork.js";
import { resolveEmbeddedAgentStream } from "./embedded-agent-runner/stream-resolution.js";
import { mapThinkingLevelForProvider, mapThinkingLevel } from "./embedded-agent-runner/utils.js";
import type { ImageSanitizationLimits } from "./image-sanitization.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import { getModelRegistryRuntime } from "./sessions/model-registry-runtime.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "./tool-fs-policy.js";
import { sanitizeImageBlocks } from "./tool-images.js";
import { normalizeUsage, type NormalizedUsage } from "./usage.js";

const log = createSubsystemLogger("agents/btw");

type SideQuestionStreamInput = {
  params: RunBtwSideQuestionParams;
  modelRegistry: Parameters<typeof getModelRegistryRuntime>[0];
  runtimeModel: Model;
  auth: Parameters<typeof registerProviderStreamForModel>[0]["auth"];
  apiKey?: string;
  resolvedAuthProfileId?: string;
  sessionId: string;
  workspaceDir: string;
};

function resolveSideQuestionStream(input: SideQuestionStreamInput) {
  const {
    params,
    modelRegistry,
    runtimeModel,
    auth,
    apiKey,
    resolvedAuthProfileId,
    sessionId,
    workspaceDir,
  } = input;
  const modelRegistryRuntime = getModelRegistryRuntime(modelRegistry);

  // Use the provider's own stream fn so providers like Ollama (which build
  // `/api/chat` or `/v1/chat/completions` paths based on api mode) construct
  // URLs correctly. Without this, streamSimple hits the provider's baseUrl
  // directly and 404s on endpoints like Ollama Cloud (#68336).
  const providerStreamFn = registerProviderStreamForModel({
    model: runtimeModel,
    cfg: params.cfg,
    agentDir: params.agentDir,
    workspaceDir,
    env: process.env,
    wrapProviderStream: params.toolCalls !== "deny",
    auth,
    apiRegistry: modelRegistryRuntime.apiRegistry,
  });
  const { streamFn } = resolveEmbeddedAgentStream({
    llmRuntime: modelRegistryRuntime.llmRuntime,
    currentStreamFn: modelRegistryRuntime.llmRuntime.streamSimple,
    providerStreamFn,
    sessionId,
    signal: params.opts?.abortSignal,
    model: runtimeModel,
    resolvedApiKey: apiKey,
    authProfileId: resolvedAuthProfileId,
  });

  if (params.toolCalls !== "deny") {
    return streamFn;
  }
  const workspaceOnly = resolveEffectiveToolFsWorkspaceOnly({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const agent = {
    streamFn: wrapStreamFnWithMessageTransform(
      streamFn,
      (messages) => messages,
      ({ context, signal }) =>
        materializeProviderContext({
          context,
          signal,
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceOnly,
          localRoots: workspaceOnly
            ? undefined
            : getAgentScopedMediaLocalRoots(params.cfg, params.agentId),
        }),
    ),
  };
  const thinkingLevel = mapThinkingLevelForProvider(params.resolvedThinkLevel, runtimeModel);
  applyExtraParamsToAgent(
    agent,
    params.cfg,
    runtimeModel.provider,
    runtimeModel.id,
    undefined,
    thinkingLevel,
    params.agentId,
    workspaceDir,
    runtimeModel,
    params.agentDir,
    undefined,
    { auth },
  );
  const preparedStream = agent.streamFn;
  return (
    model: Model,
    context: Parameters<typeof streamFn>[1],
    options: Parameters<typeof streamFn>[2],
  ) => preparedStream(model, context, { reasoning: mapThinkingLevel(thinkingLevel), ...options });
}

export async function runBtwSessionFork(
  input: SideQuestionStreamInput & {
    sessionFile: string;
    assertCurrent: () => void;
  },
): Promise<string> {
  const { params, runtimeModel, apiKey, sessionId, workspaceDir, assertCurrent } = input;
  const delivery = params.sessionEntry.delivery;
  const externalDelivery = delivery?.kind === "external" ? delivery : undefined;
  const context = await prepareEmbeddedSessionForkContext({
    target: {
      agentId: params.agentId,
      sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    sessionFile: input.sessionFile,
    model: runtimeModel,
    directApiKey: Boolean(apiKey) && !isAnthropicOAuthApiKey(apiKey),
    config: params.cfg,
    workspaceDir,
    agentId: params.agentId,
    agentDir: params.agentDir,
    chatType: params.chatType ?? params.sessionEntry.chatType,
    accountId: params.agentAccountId ?? externalDelivery?.route.accountId,
    peerId: externalDelivery?.origin.nativeDirectUserId,
    signal: params.opts?.abortSignal,
    assertCurrent,
  });
  assertCurrent();
  return runEmbeddedSessionFork({
    context,
    streamFn: resolveSideQuestionStream(input),
    question: params.question,
    model: runtimeModel,
    apiKey,
    signal: params.opts?.abortSignal,
    assertCurrent,
    onUsage: params.onUsage,
  });
}

export async function runLightweightBtwStream(
  input: SideQuestionStreamInput & {
    imageLimits: ImageSanitizationLimits;
    messages: Message[];
    inFlightPrompt?: string;
    recordBtwUsage: (model: Model, usage?: NormalizedUsage) => void;
  },
): Promise<ReplyPayload | undefined> {
  const { params, runtimeModel, apiKey, imageLimits, messages, inFlightPrompt, recordBtwUsage } =
    input;
  const streamFn = resolveSideQuestionStream(input);

  const chunker =
    params.opts?.onBlockReply && params.blockReplyChunking
      ? new EmbeddedBlockChunker(params.blockReplyChunking)
      : undefined;
  let emittedBlocks = 0;
  let blockEmitChain: Promise<void> = Promise.resolve();
  let blockEmitFailed = false;
  let answerText = "";
  let reasoningText = "";
  let assistantStarted = false;
  let sawTextEvent = false;
  const flushAtTextEnd = params.resolvedBlockStreamingBreak === "text_end";

  const emitBlockChunk = (text: string) => {
    if (!text.trim() || !params.opts?.onBlockReply) {
      return;
    }
    emittedBlocks += 1;
    blockEmitChain = blockEmitChain
      .then(() =>
        params.opts?.onBlockReply?.({
          text,
          btw: { question: params.question },
        }),
      )
      .catch((error: unknown) => {
        blockEmitFailed = true;
        log.warn(`Block reply delivery failed: ${String(error)}`);
      });
  };

  const { images } = await sanitizeImageBlocks(params.images ?? [], "btw:question", imageLimits);
  const stream = await streamWithPayloadPatch(
    streamFn,
    runtimeModel,
    {
      systemPrompt: buildBtwSystemPrompt(),
      messages: [
        ...messages,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildBtwQuestionPrompt(params.question, inFlightPrompt),
            },
            ...images,
          ],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey,
      // BTW is intentionally a lightweight side question path. Keep provider
      // reasoning off so we reliably receive answer text instead of thinking-only output.
      reasoning: undefined,
      signal: params.opts?.abortSignal,
    },
    (payloadObj) => {
      // BTW is intentionally tool-less. Some OpenAI-compatible providers reject
      // the empty tools arrays injected for generic tool-history replay.
      if (Array.isArray(payloadObj.tools) && payloadObj.tools.length === 0) {
        delete payloadObj.tools;
      }
    },
  );

  let finalEvent:
    | Extract<AssistantMessageEvent, { type: "done" }>
    | Extract<AssistantMessageEvent, { type: "error" }>
    | undefined;

  try {
    for await (const event of stream) {
      finalEvent = event.type === "done" || event.type === "error" ? event : finalEvent;

      if (!assistantStarted && (event.type === "text_start" || event.type === "start")) {
        assistantStarted = true;
        await params.opts?.onAssistantMessageStart?.();
      }

      if (event.type === "text_delta") {
        sawTextEvent = true;
        answerText += event.delta;
        chunker?.append(event.delta);
        if (chunker && flushAtTextEnd) {
          chunker.drain({ force: false, emit: emitBlockChunk });
        }
        continue;
      }

      if (event.type === "text_end" && chunker && flushAtTextEnd) {
        chunker.drain({ force: true, emit: emitBlockChunk });
        continue;
      }

      if (event.type === "thinking_delta") {
        if (params.resolvedReasoningLevel !== "off") {
          reasoningText += event.delta;
          await params.opts?.onReasoningStream?.({ text: reasoningText, isReasoning: true });
        }
        continue;
      }

      if (event.type === "thinking_end" && params.resolvedReasoningLevel !== "off") {
        await params.opts?.onReasoningEnd?.();
      }
    }

    if (chunker && params.resolvedBlockStreamingBreak !== "text_end" && chunker.hasBuffered()) {
      chunker.drain({ force: true, emit: emitBlockChunk });
    }
  } finally {
    // A stream or hook failure must not release the turn's resources while an
    // already-started block callback is still using them.
    await blockEmitChain;
  }
  if (finalEvent?.type === "error") {
    const message = collectTextContentBlocks(finalEvent.error.content).join("");
    throw new Error(message || finalEvent.error.errorMessage || "BTW failed.");
  }

  const finalMessage = finalEvent?.type === "done" ? finalEvent.message : undefined;
  if (finalMessage && !sawTextEvent) {
    answerText = collectTextContentBlocks(finalMessage.content).join("");
  }

  const answer = answerText.trim();
  if (!answer) {
    throw new Error("No BTW response generated.");
  }

  recordBtwUsage(runtimeModel, normalizeUsage(finalMessage?.usage));

  // Preserve the complete answer when streaming could not deliver every block.
  if (emittedBlocks > 0 && !blockEmitFailed) {
    return undefined;
  }

  return { text: answer };
}
