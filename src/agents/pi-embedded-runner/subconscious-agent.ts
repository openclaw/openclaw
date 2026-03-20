/**
 * Shared subconscious agent factory used by both run.ts and compact.ts.
 *
 * Creates a lightweight LLM client that streams a single prompt through
 * the configured model, with error-event detection and Copilot failover.
 */

import {
  streamSimple,
  type Model,
  type Api,
  type Context,
  type ThinkingLevel,
} from "@mariozechner/pi-ai";
import type {
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
} from "@mariozechner/pi-coding-agent";

export interface SubconsciousAgent {
  complete: (prompt: string, systemPrompt?: string) => Promise<{ text: string }>;
  autoBootstrapHistory?: boolean;
}

export interface SubconsciousAgentOptions {
  model: Model<Api>;
  authStorage: PiAuthStorage;
  modelRegistry: PiModelRegistry;
  debug?: boolean;
  autoBootstrapHistory?: boolean;
  fallbacks?: string[];
  reasoning?: ThinkingLevel;
  /** Explicitly disable thinking in the API payload. Use for latency-sensitive tasks like query generation. */
  disableThinking?: boolean;
}

interface StreamResult {
  text: string;
  streamError?: string;
}

/**
 * Consume a pi-ai stream, collecting text and detecting error events.
 * Error events are emitted as regular chunks with `type === "error"`.
 */
type StreamChunk = {
  type?: string;
  error?: { errorMessage?: string; message?: string };
  reason?: string;
  content?: string;
  text?: string;
  delta?: string | { text?: string; content?: Array<{ text?: string }> };
  partial?: { content?: Array<{ text?: string }> };
};

async function consumeStream(s: AsyncIterable<unknown>, debug: boolean): Promise<StreamResult> {
  let collected = "";
  let streamError: string | undefined;
  const startTime = Date.now();
  let ttft: number | undefined;

  for await (const chunk of s) {
    const ch = chunk as StreamChunk;

    // Detect error events emitted by the stream (not thrown as exceptions)
    if (ch.type === "error") {
      streamError =
        ch.error?.errorMessage || ch.error?.message || ch.reason || "unknown stream error";
      if (debug) {
        process.stderr.write(`  🧩 [DEBUG] Subconscious stream error event: ${streamError}\n`);
      }
      break;
    }

    let text = "";
    if (ch.content) {
      collected = ch.content;
    } else if (ch.text) {
      collected = ch.text;
    } else if (typeof ch.delta === "object" && ch.delta !== null && "text" in ch.delta) {
      text = ch.delta.text ?? "";
    } else if (typeof ch.delta === "string") {
      text = ch.delta;
    } else if (
      typeof ch.delta === "object" &&
      ch.delta !== null &&
      "content" in ch.delta &&
      Array.isArray(ch.delta.content) &&
      ch.delta.content[0]?.text
    ) {
      text = ch.delta.content[0].text;
    } else if (ch.partial?.content?.[0]?.text) {
      text = ch.partial.content[0].text;
    }

    if (text) {
      if (ttft === undefined) {
        ttft = Date.now() - startTime;
        process.stderr.write(`  ⏱️ [MIND] TTFT: ${ttft}ms\n`);
      }
      collected += text;
    } else if (!ch.content && !ch.text && ch.type !== "start" && ch.type !== "done" && debug) {
      if (collected.length === 0) {
        process.stderr.write(
          `  🧩 [DEBUG] Subconscious chunk: ${JSON.stringify(ch).substring(0, 100)}...\n`,
        );
      }
    }
  }
  return { text: collected, streamError };
}

/**
 * Build a subconscious agent for narrative / consolidation LLM calls.
 */
export function createSubconsciousAgent(opts: SubconsciousAgentOptions): SubconsciousAgent {
  const { model, authStorage, modelRegistry, debug = false } = opts;

  return {
    complete: async (prompt: string, systemPrompt?: string) => {
      let fullText = "";
      try {
        const key = (await authStorage.getApiKey(model.provider)) as string;
        if (!key) {
          if (debug) {
            process.stderr.write(`  ⚠️ [DEBUG] Subconscious: No API key for ${model.provider}\n`);
          }
          return { text: "" };
        }

        if (debug) {
          let baseUrl = model.baseUrl || "default";
          if (!model.baseUrl && key && key.includes("proxy-ep=")) {
            const match = key.match(/proxy-ep=([^;]+)/);
            if (match) {
              baseUrl = `[Derived] ${match[1]}`;
            }
          }
          process.stderr.write(
            `  🧩 [DEBUG] Subconscious stream open: ${model.provider}/${model.id} (API: ${model.api}) @ ${baseUrl}\n`,
          );
        }

        const messages: Array<{ role: string; content: string }> = [];
        if (systemPrompt?.trim()) {
          messages.push({ role: "system", content: systemPrompt.trim() });
        }
        messages.push({ role: "user", content: prompt });

        let stream = streamSimple(
          model,
          {
            messages,
          } as Context,
          {
            apiKey: key,
            maxTokens: 16000,
            ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
          },
        );

        let result = await consumeStream(stream, debug);

        // Failover: if the primary model returned a stream error with no output, retry with configured fallbacks
        if (result.streamError && result.text.length === 0) {
          process.stderr.write(
            `  ⚠️ [MIND] Model ${model.provider}/${model.id} failed with stream error (${result.streamError}). Failing over...\n`,
          );

          let failoverModel: Model<Api> | null = null;

          if (opts.fallbacks && opts.fallbacks.length > 0) {
            for (const fallback of opts.fallbacks) {
              const [fProvider, fModel] = fallback.includes("/")
                ? fallback.split("/")
                : [model.provider, fallback];
              failoverModel = modelRegistry.find(fProvider, fModel) as Model<Api> | null;
              if (failoverModel) {
                break;
              }
            }
          }

          if (failoverModel) {
            process.stderr.write(
              `  🔄 [MIND] Failover → ${failoverModel.provider}/${failoverModel.id}\n`,
            );

            const failoverKey = (await authStorage.getApiKey(failoverModel.provider)) as string;

            stream = streamSimple(
              failoverModel,
              {
                messages,
              } as Context,
              {
                apiKey: failoverKey,
                maxTokens: 16000,
                ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
              },
            );
            result = await consumeStream(stream, debug);
          } else {
            process.stderr.write(
              `  ❌ [MIND] No valid fallback models configured. Failing completely.\n`,
            );
          }
        }

        fullText = result.text;
        if (debug) {
          if (fullText.length > 0) {
            process.stderr.write(
              `\n  ✅ [DEBUG] Subconscious response received (${fullText.length} chars)\n`,
            );
          } else {
            process.stderr.write(`\n  ⚠️ [DEBUG] Subconscious response EMPTY\n`);
          }
        }
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        if (debug) {
          process.stderr.write(`  ❌ [DEBUG] Subconscious LLM error: ${errorMessage}\n`);
        }
      }
      return { text: fullText };
    },
    autoBootstrapHistory: opts.autoBootstrapHistory ?? false,
  };
}
