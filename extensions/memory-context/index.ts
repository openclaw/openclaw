import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { memoryContextConfigSchema, type MemoryContextConfig } from "./src/core/config.js";
import { createEmbeddingProvider } from "./src/core/embedding.js";
import { KnowledgeStore } from "./src/core/knowledge-store.js";
import { buildRecalledContextBlock } from "./src/core/recall-format.js";
import { maybeRedact } from "./src/core/redaction.js";
import { stripChannelPrefix } from "./src/core/shared.js";
import { WarmStore } from "./src/core/store.js";

type RuntimeState = {
  config: MemoryContextConfig;
  rawStore: WarmStore;
  knowledgeStore: KnowledgeStore;
};

const runtimes = new Map<string, Promise<RuntimeState>>();
const cachedPromptBySession = new Map<string, string>();
const RECALLED_CONTEXT_MARKER = '<recalled-context source="memory-context">';

type HookCtx = {
  sessionId?: string;
  sessionKey?: string;
};

function asMessageArray(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value as AgentMessage[];
}

function extractText(msg: AgentMessage): string {
  const raw = (msg as { content?: unknown }).content;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw
      .map((block) => {
        if (!block || typeof block !== "object") {
          return "";
        }
        const typed = block as { type?: unknown; text?: unknown };
        return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function resolveSessionId(ctx: HookCtx): string {
  return ctx.sessionId || ctx.sessionKey || "default";
}

function extractQueryFromRecentUserMessages(messages: AgentMessage[]): string {
  const userMessages: string[] = [];
  for (let i = messages.length - 1; i >= 0 && userMessages.length < 3; i--) {
    const msg = messages[i];
    if ((msg as { role?: string }).role !== "user") {
      continue;
    }
    const content = stripChannelPrefix(extractText(msg)).trim();
    if (!content || content.includes(RECALLED_CONTEXT_MARKER)) {
      continue;
    }
    userMessages.unshift(content);
  }
  return userMessages.join(" ").trim();
}

async function getOrCreateRuntime(api: OpenClawPluginApi, ctx: HookCtx): Promise<RuntimeState> {
  const sessionId = resolveSessionId(ctx);
  const existing = runtimes.get(sessionId);
  if (existing) {
    return existing;
  }

  const runtimePromise = (async () => {
    const config = memoryContextConfigSchema.parse(api.pluginConfig ?? {});
    const embedding = await createEmbeddingProvider(api.config, config.embeddingModel);
    const rawStore = new WarmStore({
      sessionId,
      sessionKey: ctx.sessionKey,
      embedding,
      coldStore: { path: `${config.storagePath}/raw` },
      maxSegments: config.maxSegments,
      crossSession: config.crossSession,
      eviction: {
        enabled: config.evictionDays > 0,
        maxAgeDays: config.evictionDays,
      },
      vectorPersist: config.vectorPersist,
    });
    const knowledgeStore = new KnowledgeStore(`${config.storagePath}/knowledge`);

    await rawStore.init();
    await knowledgeStore.init();

    return {
      config,
      rawStore,
      knowledgeStore,
    };
  })();

  runtimes.set(sessionId, runtimePromise);
  return runtimePromise;
}

const memoryContextPlugin = {
  id: "memory-context",
  name: "Memory (Context)",
  description: "Compaction-aware conversation memory with hybrid search and recall injection",
  kind: "memory" as const,
  configSchema: memoryContextConfigSchema,
  register(api: OpenClawPluginApi) {
    api.on("before_agent_start", (event, ctx) => {
      const sessionId = resolveSessionId(ctx);
      cachedPromptBySession.set(sessionId, stripChannelPrefix(event.prompt));
    });

    api.on("before_prompt_build", async (event, ctx) => {
      const runtime = await getOrCreateRuntime(api, ctx);
      if (!runtime.config.autoRecall) {
        return;
      }

      const sessionId = resolveSessionId(ctx);
      const messages = asMessageArray(event.messages);
      const query =
        cachedPromptBySession.get(sessionId)?.trim() ||
        extractQueryFromRecentUserMessages(messages) ||
        event.prompt.trim();
      if (query.length < 3) {
        return;
      }

      const filteredMessages = messages.filter((msg) => {
        const text = extractText(msg);
        return !text.includes(RECALLED_CONTEXT_MARKER);
      });
      if (filteredMessages.length !== messages.length) {
        messages.splice(0, messages.length, ...filteredMessages);
      }

      const details = await runtime.rawStore.hybridSearch(
        query,
        Math.max(8, Math.ceil(runtime.config.autoRecallMaxTokens / 500)),
        runtime.config.autoRecallMinScore,
        runtime.config.search,
      );
      const knowledge = runtime.knowledgeStore.search(query);
      const recalled = buildRecalledContextBlock(
        knowledge,
        details,
        runtime.config.autoRecallMaxTokens,
      );

      if (!recalled.block) {
        return;
      }

      return {
        prependContext: recalled.block,
      };
    });

    api.on("before_compaction", async (event, ctx) => {
      const runtime = await getOrCreateRuntime(api, ctx);
      const messages = asMessageArray(event.messages);
      if (messages.length === 0) {
        return;
      }

      for (const msg of messages) {
        const role = (msg as { role?: string }).role;
        if (role !== "user" && role !== "assistant") {
          continue;
        }
        const rawText = extractText(msg);
        if (!rawText.trim()) {
          continue;
        }
        if (rawText.includes(RECALLED_CONTEXT_MARKER)) {
          continue;
        }
        const cleaned = stripChannelPrefix(rawText);
        if (!cleaned) {
          continue;
        }
        const archived = maybeRedact(cleaned, runtime.config.redaction);
        if (runtime.rawStore.isArchived(role, archived)) {
          continue;
        }
        await runtime.rawStore.addSegmentLite({
          role,
          content: archived,
        });
      }
    });

    api.on("session_end", (_event, ctx) => {
      cachedPromptBySession.delete(ctx.sessionId);
      runtimes.delete(ctx.sessionId);
    });
  },
};

export default memoryContextPlugin;
