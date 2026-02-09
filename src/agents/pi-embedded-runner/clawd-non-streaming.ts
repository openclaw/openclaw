/**
 * CLAWD PATCH: Non-streaming streamFn for openai-completions models.
 *
 * Ollama (and some vLLM setups) return tool_calls as raw text when streaming,
 * but return proper structured tool_calls with stream=false.
 * See: https://github.com/openclaw/openclaw/issues/5769
 *       https://github.com/openclaw/openclaw/issues/1866
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";

interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

interface OllamaToolCall {
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
}

interface OllamaChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OllamaToolCall[];
  };
  finish_reason: string;
}

interface OllamaResponse {
  choices: OllamaChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * Minimal event stream that implements AsyncIterable.
 * Buffers events and resolves waiting consumers.
 */
class SimpleEventStream {
  private buffer: any[] = [];
  private resolve: ((v: IteratorResult<any>) => void) | null = null;
  private isDone = false;
  private finalMessage: any = null;
  private resultResolve: ((v: any) => void) | null = null;
  private resultPromise: Promise<any>;

  constructor() {
    this.resultPromise = new Promise((resolve) => {
      this.resultResolve = resolve;
    });
  }

  push(event: any) {
    // Capture the final message from the "done" event
    if (event.type === "done" && event.message) {
      this.finalMessage = event.message;
    }
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: event, done: false });
    } else {
      this.buffer.push(event);
    }
  }

  end() {
    this.isDone = true;
    if (this.resultResolve) {
      this.resultResolve(this.finalMessage);
      this.resultResolve = null;
    }
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined, done: true });
    }
  }

  /** Returns a promise that resolves to the final assistant message. */
  result(): Promise<any> {
    return this.resultPromise;
  }

  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<any>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift(), done: false });
        }
        if (this.isDone) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.resolve = resolve;
        });
      },
    };
  }
}

export function createNonStreamingOllamaFn(toolDefs: ToolDef[]): StreamFn {
  return ((model: any, context: any, _options: any) => {
    const stream = new SimpleEventStream();

    const output: any = {
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

    (async () => {
      try {
        // Convert context messages to OpenAI format
        const messages = (context.messages ?? []).map((msg: any) => {
          if (msg.role === "user") {
            if (typeof msg.content === "string") {
              return { role: "user", content: msg.content };
            }
            if (Array.isArray(msg.content)) {
              const text = msg.content
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("\n");
              return { role: "user", content: text || "" };
            }
            return { role: "user", content: String(msg.content ?? "") };
          }
          if (msg.role === "assistant") {
            if (typeof msg.content === "string") {
              return { role: "assistant", content: msg.content };
            }
            if (Array.isArray(msg.content)) {
              const textParts = msg.content
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text);
              const toolCalls = msg.content
                .filter((b: any) => b.type === "toolCall")
                .map((b: any) => ({
                  id: b.id || "call_0",
                  type: "function" as const,
                  function: {
                    name: b.name,
                    arguments:
                      typeof b.arguments === "string"
                        ? b.arguments
                        : JSON.stringify(b.arguments ?? {}),
                  },
                }));
              const result: any = { role: "assistant", content: textParts.join("\n") || null };
              if (toolCalls.length > 0) {
                result.tool_calls = toolCalls;
              }
              return result;
            }
            return { role: "assistant", content: "" };
          }
          if (msg.role === "toolResult") {
            const content = Array.isArray(msg.content)
              ? msg.content.map((b: any) => b.text ?? JSON.stringify(b)).join("\n")
              : String(msg.content ?? "");
            return { role: "tool", tool_call_id: msg.toolCallId || "call_0", content };
          }
          if (msg.role === "system") {
            if (typeof msg.content === "string") {
              return { role: "system", content: msg.content };
            }
            if (Array.isArray(msg.content)) {
              return {
                role: "system",
                content: msg.content.map((b: any) => b.text ?? "").join("\n"),
              };
            }
            return { role: "system", content: String(msg.content ?? "") };
          }
          return msg;
        });

        // Build tools
        const tools = toolDefs.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));

        // Inject system prompt from context (OpenClaw passes it as context.systemPrompt, not in messages)
        if (context.systemPrompt) {
          const sysContent =
            typeof context.systemPrompt === "string"
              ? context.systemPrompt
              : Array.isArray(context.systemPrompt)
                ? (context.systemPrompt as any[]).map((b: any) => b.text ?? "").join("\n")
                : String(context.systemPrompt);
          messages.unshift({ role: "system", content: sysContent });
        }

        // Ollama defaults to num_ctx=2048 unless explicitly set.
        // Our system prompt is ~20K chars (~6K tokens), so we need at least 16K context.
        const numCtx = parseInt(process.env.NUM_CTX || "16384", 10);
        const body: any = {
          model: model.id,
          messages,
          stream: false,
          options: { num_ctx: numCtx },
        };
        if (tools.length > 0) {
          body.tools = tools;
          body.tool_choice = "auto";
        }

        if (process.env.CLAWDBOT_DEBUG_TOOLS) {
          console.error(
            `[CLAWD] non-streaming: model=${model.id} tools=${tools.length} msgs=${messages.length} num_ctx=${numCtx}`,
          );
          // Dump system prompt to file for inspection
          const sysMsg = messages.find((m: { role: string }) => m.role === "system");
          if (sysMsg) {
            try {
              const nodeFs = await import("node:fs");
              nodeFs.writeFileSync(
                "/tmp/clawd-system-prompt.txt",
                (sysMsg as { content: string }).content || "",
              );
              console.error(
                `[CLAWD] system prompt dumped to /tmp/clawd-system-prompt.txt (${((sysMsg as { content: string }).content || "").length} chars)`,
              );
            } catch (e) {
              console.error(`[CLAWD] dump failed: ${e}`);
            }
          }
        }

        const apiKey = _options?.apiKey || process.env.OLLAMA_API_KEY || "ollama-local";
        const resp = await fetch(`${model.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: _options?.signal,
        });

        if (!resp.ok) {
          throw new Error(`Ollama API error (${resp.status}): ${await resp.text()}`);
        }

        const data = (await resp.json()) as OllamaResponse;
        const choice = data.choices?.[0];
        if (!choice) {
          throw new Error("No choices in response");
        }

        stream.push({ type: "start", partial: output });

        const msg = choice.message;
        let blockIdx = 0;

        if (msg.content) {
          output.content.push({ type: "text", text: msg.content });
          stream.push({ type: "text_start", contentIndex: blockIdx, partial: output });
          stream.push({
            type: "text_delta",
            contentIndex: blockIdx,
            text: msg.content,
            partial: output,
          });
          blockIdx++;
        }

        if (msg.tool_calls?.length) {
          output.stopReason = "toolCall";
          for (const tc of msg.tool_calls) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              args = { raw: tc.function.arguments };
            }
            output.content.push({
              type: "toolCall",
              id: tc.id || `call_${blockIdx}`,
              name: tc.function.name,
              arguments: args,
            });
            stream.push({ type: "toolcall_start", contentIndex: blockIdx, partial: output });
            stream.push({
              type: "toolcall_delta",
              contentIndex: blockIdx,
              name: tc.function.name,
              argumentsDelta: tc.function.arguments,
              partial: output,
            });
            blockIdx++;
          }
        }

        if (data.usage) {
          output.usage.input = data.usage.prompt_tokens ?? 0;
          output.usage.output = data.usage.completion_tokens ?? 0;
          output.usage.totalTokens = data.usage.total_tokens ?? 0;
        }

        if (process.env.CLAWDBOT_DEBUG_TOOLS) {
          console.error(
            `[CLAWD] response: text=${!!msg.content} tool_calls=${msg.tool_calls?.length ?? 0}`,
          );
        }

        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`[CLAWD] error:`, error.message);
        stream.push({ type: "error", error });
        stream.end();
      }
    })();

    return stream as any;
  }) satisfies StreamFn;
}
