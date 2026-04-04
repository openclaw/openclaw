import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import {
  buildAssistantMessage,
  buildStreamErrorAssistantMessage,
  buildUsageWithNoCost,
  type StreamModelDescriptor,
} from "../../../src/agents/stream-message-shared.js";
import { getLiteRtLmModelPreference } from "./provider-models.js";

const execFileAsync = promisify(execFile);

function getWorkspaceShimPath() {
  // Draft only: assume extension is developed inside the same workspace checkout.
  return "scripts/litertlm_provider_shim.py";
}

function buildModelDescriptor(modelId: string): StreamModelDescriptor {
  return {
    api: "litertlm-local",
    provider: "litertlm-local",
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

        const preference = getLiteRtLmModelPreference(params.model.id);
        if (preference?.preferredMatch === "Gemma_4_E4B_it") {
          // Draft-only placeholder: for a real patch, resolve explicit E4B path here or teach shim/model resolver model-id preference.
        }

        const { stdout } = await execFileAsync("python3", [
          getWorkspaceShimPath(),
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
