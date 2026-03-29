import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type {
  Model,
  Context,
  StreamOptions,
  AssistantMessage,
} from "@mariozechner/pi-ai";

import { ToolRuntime } from "./tool-runtime.js";
import {
  normalizeContextMessages,
  buildOpenAITools,
  safeJsonParse,
} from "./tool-protocol.js";

export const streamLMStudioNative = (
  model: Model<"lmstudio-native">,
  context: Context,
  options?: StreamOptions
) => {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const baseUrl = model.baseUrl || "http://127.0.0.1:1234/v1";
    const apiKey = options?.apiKey || "";

    const runtime = new ToolRuntime(
      (context.tools || []).map((t: any) => ({
        name: t.name,
        execute: async (args: any) => {
          if (typeof t.run === "function") return await t.run(args);
          throw new Error(`Tool ${t.name} has no run()`);
        },
      }))
    );

    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      stream.push({ type: "start", partial: output } as any);

      const messages: any[] = normalizeContextMessages(
        context.messages || []
      );

      const tools = buildOpenAITools(context.tools || []);

      for (let round = 0; round < 8; round++) {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: model.id,
            messages,
            tools,
            tool_choice: tools.length ? "auto" : undefined,
            temperature: options?.temperature ?? 0.7,
            max_tokens: options?.maxTokens,
            stream: false,
          }),
          signal: options?.signal,
        });

        if (!res.ok) {
          throw new Error(await res.text());
        }

        const json = await res.json();
        const msg = json?.choices?.[0]?.message;

        if (!msg) break;

        // TOOL CALL
        if (msg.tool_calls?.length) {
          messages.push(msg);

          for (const tc of msg.tool_calls) {
            const name = tc.function?.name;
            const args = safeJsonParse(tc.function?.arguments);

            output.content.push({
              type: "toolCall",
              id: tc.id,
              name,
              arguments: args,
            } as any);

            stream.push({
              type: "toolcall_start",
              contentIndex: output.content.length - 1,
              name,
              partial: output,
            } as any);

            const result = await runtime.run(name, args);

            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(result),
            });
          }

          continue;
        }

        // FINAL TEXT
        const text = msg.content || "";
        if (text) {
          output.content.push({ type: "text", text } as any);

          stream.push({
            type: "text_delta",
            contentIndex: output.content.length - 1,
            delta: text,
            partial: output,
          } as any);
        }

        break;
      }

      stream.push({ type: "done", reason: "stop", message: output } as any);
      stream.end(output);
    } catch (err) {
      const errorOutput: AssistantMessage = {
        ...output,
        stopReason: "error",
        errorMessage: String(err),
      };

      stream.push({ type: "error", reason: "error", error: errorOutput } as any);
      stream.end(errorOutput);
    }
  })();

  return stream;
};

export const streamSimpleLMStudioNative = streamLMStudioNative;