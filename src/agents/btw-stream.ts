import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { streamWithPayloadPatch } from "../llm/providers/stream-wrappers/stream-payload-utils.js";
import type { AssistantMessageEvent, Message, Model } from "../llm/types.js";
import { buildBtwQuestionPrompt, buildBtwSystemPrompt } from "./btw-prompts.js";
import type { RunBtwSideQuestionParams } from "./btw-runtime.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";
import { resolveEmbeddedAgentStream } from "./embedded-agent-runner/stream-resolution.js";
import type { ImageSanitizationLimits } from "./image-sanitization.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import { getModelRegistryRuntime } from "./sessions/model-registry-runtime.js";
import { sanitizeImageBlocks } from "./tool-images.js";
import { normalizeUsage, type NormalizedUsage } from "./usage.js";

export async function runLightweightBtwStream(input: {
  params: RunBtwSideQuestionParams;
  modelRegistry: Parameters<typeof getModelRegistryRuntime>[0];
  runtimeModel: Model;
  auth: Parameters<typeof registerProviderStreamForModel>[0]["auth"];
  apiKey?: string;
  resolvedAuthProfileId?: string;
  sessionId: string;
  workspaceDir: string;
  imageLimits: ImageSanitizationLimits;
  messages: Message[];
  inFlightPrompt?: string;
  recordBtwUsage: (model: Model, usage?: NormalizedUsage) => void;
}): Promise<ReplyPayload | undefined> {
  const {
    params,
    modelRegistry,
    runtimeModel,
    auth,
    apiKey,
    resolvedAuthProfileId,
    sessionId,
    workspaceDir,
    imageLimits,
    messages,
    inFlightPrompt,
    recordBtwUsage,
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
    wrapProviderStream: true,
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

  const chunker =
    params.opts?.onBlockReply && params.blockReplyChunking
      ? new EmbeddedBlockChunker(params.blockReplyChunking)
      : undefined;
  let emittedBlocks = 0;
  let blockEmitChain: Promise<void> = Promise.resolve();
  let answerText = "";
  let reasoningText = "";
  let assistantStarted = false;
  let sawTextEvent = false;
  const flushAtTextEnd = params.resolvedBlockStreamingBreak === "text_end";

  const emitBlockChunk = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !params.opts?.onBlockReply) {
      return;
    }
    emittedBlocks += 1;
    blockEmitChain = blockEmitChain.then(async () => {
      await params.opts?.onBlockReply?.({
        text,
        btw: { question: params.question },
      });
    });
    await blockEmitChain;
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
        chunker.drain({ force: false, emit: (chunk) => void emitBlockChunk(chunk) });
      }
      continue;
    }

    if (event.type === "text_end" && chunker && flushAtTextEnd) {
      chunker.drain({ force: true, emit: (chunk) => void emitBlockChunk(chunk) });
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
    chunker.drain({ force: true, emit: (chunk) => void emitBlockChunk(chunk) });
  }
  await blockEmitChain;

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

  if (emittedBlocks > 0) {
    return undefined;
  }

  return { text: answer };
}
