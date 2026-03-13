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
import { resolveSessionAuthProfileOverride } from "./auth-profiles/session-override.js";
import { getApiKeyForModel, requireApiKey } from "./model-auth.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { EmbeddedBlockChunker, type BlockReplyChunking } from "./pi-embedded-block-chunker.js";
import { resolveModelWithRegistry } from "./pi-embedded-runner/model.js";
import {
  getActiveEmbeddedRunSnapshot,
  waitForEmbeddedPiRunEnd,
} from "./pi-embedded-runner/runs.js";
import { mapThinkingLevel } from "./pi-embedded-runner/utils.js";
import { discoverAuthStorage, discoverModels } from "./pi-model-discovery.js";
import { acquireSessionWriteLock } from "./session-write-lock.js";

const BTW_CUSTOM_TYPE = "openclaw:btw";
const BTW_PERSIST_TIMEOUT_MS = 250;
const BTW_PERSIST_RETRY_WAIT_MS = 30_000;
const BTW_PERSIST_RETRY_LOCK_MS = 10_000;

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

type BtwCustomEntryData = {
  timestamp: number;
  question: string;
  answer: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkLevel | "off";
  reasoningLevel: ReasoningLevel;
  sessionKey?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  usage?: unknown;
};

async function appendBtwCustomEntry(params: {
  sessionFile: string;
  timeoutMs: number;
  entry: BtwCustomEntryData;
}) {
  const lock = await acquireSessionWriteLock({
    sessionFile: params.sessionFile,
    timeoutMs: params.timeoutMs,
    allowReentrant: false,
  });
  try {
    const persisted = SessionManager.open(params.sessionFile);
    persisted.appendCustomEntry(BTW_CUSTOM_TYPE, params.entry);
  } finally {
    await lock.release();
  }
}

function isSessionLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("session file locked");
}

function deferBtwCustomEntryPersist(params: {
  sessionId: string;
  sessionFile: string;
  entry: BtwCustomEntryData;
}) {
  void (async () => {
    try {
      await waitForEmbeddedPiRunEnd(params.sessionId, BTW_PERSIST_RETRY_WAIT_MS);
      await appendBtwCustomEntry({
        sessionFile: params.sessionFile,
        timeoutMs: BTW_PERSIST_RETRY_LOCK_MS,
        entry: params.entry,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[btw] skipped transcript persistence: ${message}`);
    }
  })();
}

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

function toSimpleContextMessages(messages: unknown[]): Message[] {
  return messages.filter((message): message is Message => {
    if (!message || typeof message !== "object") {
      return false;
    }
    const role = (message as { role?: unknown }).role;
    return role === "user" || role === "assistant" || role === "toolResult";
  });
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
  } catch {
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
  if (activeRunSnapshot) {
    if (activeRunSnapshot.transcriptLeafId && sessionManager.branch) {
      sessionManager.branch(activeRunSnapshot.transcriptLeafId);
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
  const sessionContext = sessionManager.buildSessionContext();
  const messages = toSimpleContextMessages(
    Array.isArray(sessionContext.messages) ? sessionContext.messages : [],
  );
  if (messages.length === 0) {
    throw new Error("No active session context.");
  }

  const { model, authProfileId, authProfileIdSource } = await resolveRuntimeModel({
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
      await params.opts?.onBlockReply?.({ text });
    });
    await blockEmitChain;
  };

  const stream = streamSimple(
    model,
    {
      messages: [
        ...messages,
        {
          role: "user",
          content: [{ type: "text", text: params.question }],
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

  const customEntry = {
    timestamp: Date.now(),
    question: params.question,
    answer,
    provider: model.provider,
    model: model.id,
    thinkingLevel: params.resolvedThinkLevel ?? "off",
    reasoningLevel: params.resolvedReasoningLevel,
    sessionKey: params.sessionKey,
    authProfileId,
    authProfileIdSource,
    usage: finalMessage?.usage,
  } satisfies BtwCustomEntryData;

  try {
    await appendBtwCustomEntry({
      sessionFile,
      timeoutMs: BTW_PERSIST_TIMEOUT_MS,
      entry: customEntry,
    });
  } catch (error) {
    if (!isSessionLockError(error)) {
      throw error;
    }
    deferBtwCustomEntryPersist({
      sessionId,
      sessionFile,
      entry: customEntry,
    });
  }

  if (emittedBlocks > 0) {
    return undefined;
  }

  return { text: answer };
}

export { BTW_CUSTOM_TYPE };
