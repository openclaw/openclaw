import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { EmbedFn } from "./log-memory/types.js";

// No-op embedder: returns zero-length vectors so capture (which never calls
// embed) works without a real model. buildPinnedContext also works because it
// filters by payload.pinned rather than by score. Keyword matching still
// functions correctly; only cosine similarity is lost.
const noopEmbed: EmbedFn = async (texts) => texts.map(() => new Float32Array(0));

// Per-workspace instance cache so hooks share one store across calls.
interface LogMemoryComponents {
  capture: import("./log-memory/knowledge-capture.js").KnowledgeCapture;
  injector: import("./log-memory/context-injector.js").ContextInjector;
}
const componentCache = new Map<string, LogMemoryComponents>();

async function getComponents(workspaceDir: string): Promise<LogMemoryComponents> {
  const cached = componentCache.get(workspaceDir);
  if (cached) return cached;

  const [{ LogMemoryStore }, { KnowledgeCapture }, { LogIngestor }, { ContextInjector }] =
    await Promise.all([
      import("./log-memory/store.js"),
      import("./log-memory/knowledge-capture.js"),
      import("./log-memory/ingestor.js"),
      import("./log-memory/context-injector.js"),
    ]);

  const store = new LogMemoryStore({ workspaceDir });
  const capture = new KnowledgeCapture({ workspaceDir, store, embed: noopEmbed });
  const ingestor = new LogIngestor({ store, embed: noopEmbed });
  const injector = new ContextInjector(ingestor);

  const components: LogMemoryComponents = { capture, injector };
  componentCache.set(workspaceDir, components);
  return components;
}

export function registerLogMemoryHooks(api: OpenClawPluginApi): void {
  // Capture: scan every incoming user message for rules/conventions and write
  // them to KNOWLEDGE.md immediately, pinned so they never decay.
  api.on("message_received", async (event, ctx) => {
    const workspaceDir = ctx.workspaceDir;
    if (!workspaceDir || !event.content?.trim()) return;
    try {
      const { capture } = await getComponents(workspaceDir);
      await capture.maybeCapture({ message: event.content });
    } catch (err) {
      api.logger.warn(
        `log-memory: capture failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // Inject: prepend all pinned rules to the system prompt before each LLM call
  // so the model always sees active conventions regardless of query relevance.
  api.on("before_prompt_build", async (_event, ctx) => {
    const workspaceDir = ctx.workspaceDir;
    if (!workspaceDir) return undefined;
    try {
      const { injector } = await getComponents(workspaceDir);
      const pinnedCtx = await injector.buildPinnedContext();
      if (!pinnedCtx) return undefined;
      return { prependSystemContext: pinnedCtx };
    } catch (err) {
      api.logger.warn(
        `log-memory: context injection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  });
}
