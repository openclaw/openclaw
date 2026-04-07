import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, StopReason, Usage } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { PROVIDER_ID } from "./provider-models.js";
import {
  buildLiteRtLmShimRequest,
  resolveLiteRtLmRuntimeConfig,
  type LiteRtLmRuntimeConfig,
  type LiteRtLmShimResponse,
} from "./runtime-config.js";

const execFileAsync = promisify(execFile);

type StreamModelDescriptor = {
  api: string;
  provider: string;
  id: string;
};

type LiteRtLmConfigShape = {
  models?: {
    providers?: Record<string, Record<string, unknown>>;
  };
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

function resolveShimPath(runtimeConfig: LiteRtLmRuntimeConfig) {
  const configuredPath = runtimeConfig.shimPath.trim();
  if (!configuredPath) {
    return runtimeConfig.shimPath;
  }
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }
  return path.resolve(process.cwd(), configuredPath);
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

function buildUsageFromShimResponse(payload: LiteRtLmShimResponse): Usage {
  if (!payload.ok) {
    return buildUsageWithNoCost({});
  }
  return buildUsageWithNoCost({
    input: payload.usage?.inputTokens,
    output: payload.usage?.outputTokens,
    totalTokens: payload.usage?.totalTokens,
  });
}

function buildLiteRtLmErrorMessage(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOENT|not found/i.test(message)) {
    return `litertlm environment error: ${message}`;
  }
  if (/timed out|timeout/i.test(message)) {
    return `litertlm runtime timeout: ${message}`;
  }
  if (/Unexpected token|JSON|parse/i.test(message)) {
    return `litertlm runtime returned invalid JSON: ${message}`;
  }
  return message;
}

async function invokeLiteRtLmShim(params: {
  runtimeConfig: LiteRtLmRuntimeConfig;
  request: ReturnType<typeof buildLiteRtLmShimRequest>;
}): Promise<LiteRtLmShimResponse> {
  const shimPath = resolveShimPath(params.runtimeConfig);
  try {
    const { stdout } = await execFileAsync(
      params.runtimeConfig.pythonPath,
      [shimPath, "--input", JSON.stringify(params.request)],
      {
        timeout: params.runtimeConfig.timeoutMs,
        maxBuffer: 1024 * 1024,
      },
    );

    return JSON.parse(stdout) as LiteRtLmShimResponse;
  } catch (error) {
    if (error instanceof Error) {
      return {
        ok: false,
        version: 1,
        error: {
          type: /ENOENT|not found/i.test(error.message) ? "environment" : "runtime",
          code: /timed out|timeout/i.test(error.message) ? "PROCESS_TIMEOUT" : "PROCESS_ERROR",
          message: buildLiteRtLmErrorMessage(error),
        },
      };
    }
    return {
      ok: false,
      version: 1,
      error: {
        type: "runtime",
        code: "UNKNOWN_RUNTIME_ERROR",
        message: String(error),
      },
    };
  }
}

export function createLiteRtLmShimStreamFn(params: {
  model: { id: string };
  config?: LiteRtLmConfigShape;
}): StreamFn {
  return (_model, context, _options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      const modelInfo = buildModelDescriptor(params.model.id);
      try {
        const runtimeConfig = resolveLiteRtLmRuntimeConfig({
          model: { modelId: params.model.id },
          config: params.config,
        });

        if (!runtimeConfig.modelFile) {
          throw new Error("litertlm configuration error: missing configured modelFile");
        }

        const request = buildLiteRtLmShimRequest({
          modelId: params.model.id,
          runtimeConfig,
          prompt: extractPrompt(context),
          system:
            typeof context.systemPrompt === "string" && context.systemPrompt.trim()
              ? context.systemPrompt
              : undefined,
        });

        const payload = await invokeLiteRtLmShim({ runtimeConfig, request });

        if (!payload.ok) {
          throw new Error(
            `litertlm ${payload.error.type} error (${payload.error.code}): ${payload.error.message}`,
          );
        }

        const text = payload.output.text || "";
        const usage = buildUsageFromShimResponse(payload);
        const partial = buildAssistantMessage({
          model: modelInfo,
          content: [{ type: "text", text }],
          stopReason: "stop",
          usage,
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
            usage,
          }),
        });
      } catch (err) {
        stream.push({
          type: "error",
          reason: "error",
          error: buildStreamErrorAssistantMessage({
            model: modelInfo,
            errorMessage: buildLiteRtLmErrorMessage(err),
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
