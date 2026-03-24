/**
 * ACP ↔ pi-ai stream bridge.
 *
 * This module bridges the `@mcpc-tech/acp-ai-provider` (which speaks Vercel AI
 * SDK `LanguageModelV2/V3`) into `@mariozechner/pi-ai`'s `StreamFn` protocol
 * used by the OpenClaw embedded runner.
 *
 * The `StreamFn` contract:
 *   `(model, context, options?) => AssistantMessageEventStream`
 *
 * `AssistantMessageEventStream` is an `EventStream<AssistantMessageEvent, AssistantMessage>`.
 * It must emit events: start → text_start → text_delta* → text_end → done.
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { createACPProvider } from "@mcpc-tech/acp-ai-provider";

/** Resolved ACP agent configuration consumed at runtime. */
export type AcpAgentConfig = {
  command: string;
  args: string[];
  cwd?: string;
  persistSession?: boolean;
};

/** Default ACP agent command when none is configured. */
const DEFAULT_ACP_COMMAND = "gemini";
const DEFAULT_ACP_ARGS = ["--experimental-acp"];

/**
 * Resolve ACP agent configuration from environment or config extra params.
 */
export function resolveAcpAgentConfig(extraParams?: Record<string, unknown>): AcpAgentConfig {
  const envCommand = process.env.ACP_COMMAND?.trim();
  const envArgs = process.env.ACP_ARGS?.trim();

  const command =
    (typeof extraParams?.acpCommand === "string" ? extraParams.acpCommand.trim() : undefined) ||
    envCommand ||
    DEFAULT_ACP_COMMAND;

  const args =
    (Array.isArray(extraParams?.acpArgs) ? (extraParams.acpArgs as string[]) : undefined) ||
    (envArgs ? envArgs.split(/\s+/) : undefined) ||
    DEFAULT_ACP_ARGS;

  const cwd =
    (typeof extraParams?.acpCwd === "string" ? extraParams.acpCwd.trim() : undefined) ||
    process.env.ACP_CWD?.trim() ||
    process.cwd();

  const persistSession =
    typeof extraParams?.acpPersistSession === "boolean"
      ? extraParams.acpPersistSession
      : process.env.ACP_PERSIST_SESSION === "1";

  return { command, args, cwd, persistSession };
}

// Provider instance cache keyed by "command args cwd" to avoid spawning
// duplicate subprocesses for the same agent configuration.
const providerCache = new Map<string, ReturnType<typeof createACPProvider>>();

function getOrCreateProvider(config: AcpAgentConfig) {
  const cacheKey = `${config.command}\0${config.args.join("\0")}\0${config.cwd ?? ""}`;
  const existing = providerCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const provider = createACPProvider({
    command: config.command,
    args: config.args,
    session: {
      cwd: config.cwd ?? process.cwd(),
      mcpServers: [],
    },
    persistSession: config.persistSession,
  });

  providerCache.set(cacheKey, provider);
  return provider;
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Convert pi-ai Context to a single prompt string for the ACP agent.
 *
 * ACP agents maintain their own conversation state internally, so we flatten
 * the pi-ai conversation context into the most recent user turn.
 */
function contextToPrompt(context: Context): string {
  const parts: string[] = [];

  if (context.systemPrompt) {
    parts.push(context.systemPrompt);
  }

  for (const message of context.messages) {
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter(
                  (block): block is { type: "text"; text: string } =>
                    typeof block === "object" && block !== null && block.type === "text",
                )
                .map((block) => block.text)
                .join("\n")
            : "";
      if (text) {
        parts.push(text);
      }
    }
  }

  return parts.join("\n\n");
}

/**
 * Build a partial AssistantMessage for streaming progress events.
 */
function buildPartialMessage(
  model: { api?: string; provider?: string; id?: string },
  textSoFar: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: textSoFar }],
    api: (model.api ?? "openai-completions") as AssistantMessage["api"],
    provider: model.provider ?? "acp",
    model: model.id ?? "acp/default",
    usage: EMPTY_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * Create an ACP stream function that replaces the normal pi-ai stream path.
 *
 * The returned `StreamFn` spawns an ACP agent subprocess (via
 * `@mcpc-tech/acp-ai-provider`), routes the prompt through it, and converts
 * the AI SDK stream back into pi-ai's `AssistantMessageEventStream`.
 */
export function createAcpStreamFn(
  _baseStreamFn: StreamFn | undefined,
  acpConfig: AcpAgentConfig,
): StreamFn {
  return (model, context, _options) => {
    const stream = createAssistantMessageEventStream();
    const prompt = contextToPrompt(context);

    // Run the ACP interaction asynchronously, pushing events into the pi-ai
    // event stream as chunks arrive.
    void (async () => {
      let textAccumulator = "";
      try {
        const provider = getOrCreateProvider(acpConfig);
        const acpModel = provider.languageModel();

        const { streamText } = await import("ai");
        const acpResult = streamText({
          model: acpModel,
          prompt,
          tools: provider.tools,
        });

        // Emit "start" event
        const startPartial = buildPartialMessage(model, "");
        stream.push({ type: "start", partial: startPartial });

        // Emit "text_start" for the first content block
        stream.push({ type: "text_start", contentIndex: 0, partial: startPartial });

        // Stream text deltas
        for await (const chunk of (await acpResult).textStream) {
          textAccumulator += chunk;
          const partial = buildPartialMessage(model, textAccumulator);
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: chunk,
            partial,
          });
        }

        // Emit "text_end"
        const endPartial = buildPartialMessage(model, textAccumulator);
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: textAccumulator,
          partial: endPartial,
        });

        // Emit "done"
        const finalMessage: AssistantMessage = {
          ...endPartial,
          stopReason: "stop",
        };
        stream.push({ type: "done", reason: "stop", message: finalMessage });
      } catch (error) {
        const errorText = `ACP agent error: ${error instanceof Error ? error.message : String(error)}`;
        const errorMessage: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: errorText }],
          api: (model.api ?? "openai-completions") as AssistantMessage["api"],
          provider: model.provider ?? "acp",
          model: model.id ?? "acp/default",
          usage: EMPTY_USAGE,
          stopReason: "error",
          errorMessage: errorText,
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: "error", error: errorMessage });
      }
    })();

    return stream;
  };
}

/**
 * Cleanup all cached ACP provider instances.
 * Should be called on process exit to terminate spawned agent subprocesses.
 */
export function cleanupAcpProviders(): void {
  for (const [key, provider] of providerCache) {
    try {
      provider.cleanup();
    } catch {
      // Best-effort cleanup
    }
    providerCache.delete(key);
  }
}

// Register cleanup on process exit
process.on("exit", cleanupAcpProviders);
process.on("SIGINT", () => {
  cleanupAcpProviders();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupAcpProviders();
  process.exit(0);
});
