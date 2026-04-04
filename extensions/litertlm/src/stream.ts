import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, StopReason, Usage } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { PROVIDER_ID } from "./provider-models.js";

const execFileAsync = promisify(execFile);

type StreamModelDescriptor = {
  api: string;
  provider: string;
  id: string;
};

function buildUsageWithNoCost(params: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}): Usage {
  const input = params.input ?? 0;
  const output = params.output ?? 0;
  const cacheRead = params.cacheRead ?? 0;
  const cacheWrite = params.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: params.totalTokens ?? input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function buildAssistantMessage(params: {
  model: StreamModelDescriptor;
  content: AssistantMessage["content"];
  stopReason: StopReason;
  usage: Usage;
  timestamp?: number;
}): AssistantMessage {
  return {
    role: "assistant",
    content: params.content,
    stopReason: params.stopReason,
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: params.usage,
    timestamp: params.timestamp ?? Date.now(),
  };
}

function buildStreamErrorAssistantMessage(params: {
  model: StreamModelDescriptor;
  errorMessage: string;
  timestamp?: number;
}): AssistantMessage & { stopReason: "error"; errorMessage: string } {
  return {
    ...buildAssistantMessage({
      model: params.model,
      content: [],
      stopReason: "error",
      usage: buildUsageWithNoCost({}),
      timestamp: params.timestamp,
    }),
    stopReason: "error",
    errorMessage: params.errorMessage,
  };
}

function getShimPath() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../scripts/litertlm_provider_shim.py",
  );
}

function buildModelDescriptor(modelId: string): StreamModelDescriptor {
  return {
    api: PROVIDER_ID,
    provider: PROVIDER_ID,
    id: modelId,
  };
}

function extractPrompt(context: { messages?: unknown[] }) {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const last = messages[messages.length - 1] as { role?: string; content?: unknown } | undefined;
  if (typeof last?.content === "string") {
    return last.content;
  }
  if (Array.isArray(last?.content)) {
    const text = last.content
      .map((item) =>
        item && typeof item === "object" && "type" in item && "text" in item && item.type === "text"
          ? String(item.text)
          : "",
      )
      .join("");
    return text;
  }
  return "";
}

export function createLiteRtLmShimStreamFn(params: { model: { id: string } }): StreamFn {
  return (_model, context, _options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      const modelInfo = buildModelDescriptor(params.model.id);
      try {
        const shimInput: Record<string, unknown> = {
          prompt: extractPrompt(context),
          backend: "CPU",
        };
        if (typeof context.systemPrompt === "string" && context.systemPrompt.trim()) {
          shimInput.system = context.systemPrompt;
        }

        const { stdout } = await execFileAsync("python3", [
          getShimPath(),
          "--input",
          JSON.stringify(shimInput),
        ]);

        const payload = JSON.parse(stdout) as {
          ok: boolean;
          output_text?: string;
          diagnostics?: unknown;
          error?: { message?: string };
        };

        if (!payload.ok) {
          throw new Error(payload.error?.message || "LiteRT-LM shim failed");
        }

        const text = payload.output_text || "";
        const partial = buildAssistantMessage({
          model: modelInfo,
          content: [{ type: "text", text }],
          stopReason: "stop",
          usage: buildUsageWithNoCost({}),
        });

        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
        stream.push({
          type: "done",
          reason: "stop",
          message: buildAssistantMessage({
            model: modelInfo,
            content: [{ type: "text", text }],
            stopReason: "stop",
            usage: buildUsageWithNoCost({}),
          }),
        });
      } catch (err) {
        stream.push({
          type: "error",
          reason: "error",
          error: buildStreamErrorAssistantMessage({
            model: modelInfo,
            errorMessage: err instanceof Error ? err.message : String(err),
          }),
        });
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
