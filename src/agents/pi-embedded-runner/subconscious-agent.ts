/**
 * Shared subconscious agent factory used by both run.ts and compact.ts.
 *
 * Creates a lightweight LLM client that streams a single prompt through
 * the configured model, with error-event detection and Copilot failover.
 */

import { streamSimple, type Model, type Api, type Context } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "../pi-model-discovery.js";

export interface SubconsciousAgent {
  complete: (prompt: string) => Promise<{ text: string }>;
  autoBootstrapHistory?: boolean;
}

export interface SubconsciousAgentOptions {
  model: Model<Api>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  debug?: boolean;
  autoBootstrapHistory?: boolean;
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
    complete: async (prompt: string) => {
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

        const isCopilotProvider = /github-copilot/.test(model.provider || "");

        let stream = streamSimple(
          model,
          {
            messages: [{ role: "user", content: prompt }],
          } as Context,
          {
            apiKey: key,
            temperature: 0,
            onPayload: debug
              ? (payload: unknown) => {
                  const p = payload as Record<string, unknown>;
                  process.stderr.write(
                    `  🧩 [DEBUG] Subconscious payload: model=${String(p["model"])} api=${model.api} baseUrl=${model.baseUrl} keys=${Object.keys(p || {}).join(",")}\n`,
                  );
                }
              : undefined,
          },
        );

        let result = await consumeStream(stream, debug);

        // Failover: if the primary model returned a stream error via Copilot, retry with gpt-4o
        if (result.streamError && isCopilotProvider && result.text.length === 0) {
          process.stderr.write(
            `  ⚠️ [MIND] Model ${model.id} failed via Copilot (${result.streamError}). Failing over to gpt-4o...\n`,
          );

          const failoverModel =
            (modelRegistry.find("github-copilot", "gpt-4o") as Model<Api> | null) ??
            ({
              ...model,
              id: "gpt-4o",
              api: "openai-completions",
            } as Model<Api>);

          process.stderr.write(
            `  🔄 [MIND] Failover → ${failoverModel.id} (api: ${failoverModel.api})\n`,
          );

          stream = streamSimple(
            failoverModel,
            {
              messages: [{ role: "user", content: prompt }],
            } as Context,
            { apiKey: key, temperature: 0.3 },
          );
          result = await consumeStream(stream, debug);
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
