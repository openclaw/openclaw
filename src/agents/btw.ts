import {
  streamSimple,
  type Api,
  type AssistantMessageEvent,
  type ThinkingLevel as SimpleThinkingLevel,
  type Message,
  type Model,
} from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
} from "../config/sessions.js";
import { diagnosticLogger as diag } from "../logging/diagnostic.js";
import { resolveSessionAuthProfileOverride } from "./auth-profiles/session-override.js";
import { getApiKeyForModel, requireApiKey } from "./model-auth.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { EmbeddedBlockChunker, type BlockReplyChunking } from "./pi-embedded-block-chunker.js";
import { resolveModelWithRegistry } from "./pi-embedded-runner/model.js";
import { getActiveEmbeddedRunSnapshot } from "./pi-embedded-runner/runs.js";
import { mapThinkingLevel } from "./pi-embedded-runner/utils.js";
import { discoverAuthStorage, discoverModels } from "./pi-model-discovery.js";
import { stripToolResultDetails } from "./session-transcript-repair.js";

type SessionManagerLike = {
  getLeafEntry?: () => {
    id?: string;
    type?: string;
    parentId?: string | null;
    message?: { role?: string };
  } | null;
  branch?: (parentId: string) => void;
  resetLeaf?: () => void;
  buildSessionContext: () => { messages?: unknown[] };
};

function collectTextContent(content: Array<{ type?: string; text?: string }>): string {
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function collectThinkingContent(content: Array<{ type?: string; thinking?: string }>): string {
  return content
    .filter((part): part is { type: "thinking"; thinking: string } => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");
}

function buildBtwSystemPrompt(): string {
  return [
    "You are answering an ephemeral /btw side question about the current conversation.",
    "Use the conversation only as background context.",
    "Answer only the side question in the last user message.",
    "Do not continue, resume, or complete any unfinished task from the conversation.",
    "Do not emit tool calls, pseudo-tool calls, shell commands, file writes, patches, or code unless the side question explicitly asks for them.",
    "Do not say you will continue the main task after answering.",
    "If the question can be answered briefly, answer briefly.",
  ].join("\n");
}

function buildBtwQuestionPrompt(question: string, inFlightPrompt?: string): string {
  const lines = [
    "Answer this side question only.",
    "Ignore any unfinished task in the conversation while answering it.",
  ];
  const trimmedPrompt = inFlightPrompt?.trim();
  if (trimmedPrompt) {
    lines.push(
      "",
      "Current in-flight main task request for background context only:",
      "<in_flight_main_task>",
      trimmedPrompt,
      "</in_flight_main_task>",
      "Do not continue or complete that task while answering the side question.",
    );
  }
  lines.push("", "<btw_side_question>", question.trim(), "</btw_side_question>");
  return lines.join("\n");
}

function toSimpleContextMessages(messages: unknown[]): Message[] {
  const contextMessages = messages.filter((message): message is Message => {
    if (!message || typeof message !== "object") {
      return false;
    }
    const role = (message as { role?: unknown }).role;
    return role === "user" || role === "assistant";
  });
  return stripToolResultDetails(
    contextMessages as Parameters<typeof stripToolResultDetails>[0],
  ) as Message[];
}

function resolveSimpleThinkingLevel(level?: ThinkLevel): SimpleThinkingLevel | undefined {
  if (!level || level === "off") {
    return undefined;
  }
  return mapThinkingLevel(level) as SimpleThinkingLevel;
}

function resolveSessionTranscriptPath(params: {
  sessionId: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
}): string | undefined {
  try {
    const agentId = params.sessionKey?.split(":")[1];
    const pathOpts = resolveSessionFilePathOptions({
      agentId,
      storePath: params.storePath,
    });
    return resolveSessionFilePath(params.sessionId, params.sessionEntry, pathOpts);
  } catch (error) {
    diag.debug(
      `resolveSessionTranscriptPath failed: sessionId=${params.sessionId} err=${String(error)}`,
    );
    return undefined;
  }
}

async function resolveRuntimeModel(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentDir: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isNewSession: boolean;
}): Promise<{
  model: Model<Api>;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}> {
  await ensureOpenClawModelsJson(params.cfg, params.agentDir);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);
  const model = resolveModelWithRegistry({
    provider: params.provider,
    modelId: params.model,
    modelRegistry,
    cfg: params.cfg,
  });
  if (!model) {
    throw new Error(`Unknown model: ${params.provider}/${params.model}`);
  }

  const authProfileId = await resolveSessionAuthProfileOverride({
    cfg: params.cfg,
    provider: params.provider,
    agentDir: params.agentDir,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    isNewSession: params.isNewSession,
  });
  return {
    model,
    authProfileId,
    authProfileIdSource: params.sessionEntry?.authProfileOverrideSource,
  };
}

type RunBtwSideQuestionParams = {
  cfg: OpenClawConfig;
  agentDir: string;
  provider: string;
  model: string;
  question: string;
  sessionEntry: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  resolvedThinkLevel?: ThinkLevel;
  resolvedReasoningLevel: ReasoningLevel;
  blockReplyChunking?: BlockReplyChunking;
  resolvedBlockStreamingBreak?: "text_end" | "message_end";
  opts?: GetReplyOptions;
  isNewSession: boolean;
};

export async function runBtwSideQuestion(
  params: RunBtwSideQuestionParams,
): Promise<ReplyPayload | undefined> {
  const sessionId = params.sessionEntry.sessionId?.trim();
  if (!sessionId) {
    throw new Error("No active session context.");
  }

  const sessionFile = resolveSessionTranscriptPath({
    sessionId,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  if (!sessionFile) {
    throw new Error("No active session transcript.");
  }

  const sessionManager = SessionManager.open(sessionFile) as SessionManagerLike;
  const activeRunSnapshot = getActiveEmbeddedRunSnapshot(sessionId);
  let messages: Message[] = [];
  let inFlightPrompt: string | undefined;
  if (Array.isArray(activeRunSnapshot?.messages) && activeRunSnapshot.messages.length > 0) {
    messages = toSimpleContextMessages(activeRunSnapshot.messages);
    inFlightPrompt = activeRunSnapshot.inFlightPrompt;
  } else if (activeRunSnapshot) {
    inFlightPrompt = activeRunSnapshot.inFlightPrompt;
    if (activeRunSnapshot.transcriptLeafId && sessionManager.branch) {
      try {
        sessionManager.branch(activeRunSnapshot.transcriptLeafId);
      } catch (error) {
        diag.debug(
          `btw snapshot leaf unavailable: sessionId=${sessionId} leaf=${activeRunSnapshot.transcriptLeafId} err=${String(error)}`,
        );
        sessionManager.resetLeaf?.();
      }
    } else {
      sessionManager.resetLeaf?.();
    }
  } else {
    const leafEntry = sessionManager.getLeafEntry?.();
    if (leafEntry?.type === "message" && leafEntry.message?.role === "user") {
      if (leafEntry.parentId && sessionManager.branch) {
        sessionManager.branch(leafEntry.parentId);
      } else {
        sessionManager.resetLeaf?.();
      }
    }
  }
  if (messages.length === 0) {
    const sessionContext = sessionManager.buildSessionContext();
    messages = toSimpleContextMessages(
      Array.isArray(sessionContext.messages) ? sessionContext.messages : [],
    );
  }
  if (messages.length === 0 && !inFlightPrompt?.trim()) {
    throw new Error("No active session context.");
  }

  const { model, authProfileId } = await resolveRuntimeModel({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    agentDir: params.agentDir,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    isNewSession: params.isNewSession,
  });
  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: params.cfg,
    profileId: authProfileId,
    agentDir: params.agentDir,
  });
  const apiKey = requireApiKey(apiKeyInfo, model.provider);

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

  const stream = streamSimple(
    model,
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
          ],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey,
      reasoning: resolveSimpleThinkingLevel(params.resolvedThinkLevel),
      signal: params.opts?.abortSignal,
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
      if (chunker && params.resolvedBlockStreamingBreak === "text_end") {
        chunker.drain({ force: false, emit: (chunk) => void emitBlockChunk(chunk) });
      }
      continue;
    }

    if (event.type === "text_end" && chunker && params.resolvedBlockStreamingBreak === "text_end") {
      chunker.drain({ force: true, emit: (chunk) => void emitBlockChunk(chunk) });
      continue;
    }

    if (event.type === "thinking_delta") {
      reasoningText += event.delta;
      if (params.resolvedReasoningLevel !== "off") {
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
    const message = collectTextContent(finalEvent.error.content);
    throw new Error(message || finalEvent.error.errorMessage || "BTW failed.");
  }

  const finalMessage = finalEvent?.type === "done" ? finalEvent.message : undefined;
  if (finalMessage) {
    if (!sawTextEvent) {
      answerText = collectTextContent(finalMessage.content);
    }
    if (!reasoningText) {
      reasoningText = collectThinkingContent(finalMessage.content);
    }
  }

  const answer = answerText.trim();
  if (!answer) {
    throw new Error("No BTW response generated.");
  }

  if (emittedBlocks > 0) {
    return undefined;
  }

  return { text: answer };
}
