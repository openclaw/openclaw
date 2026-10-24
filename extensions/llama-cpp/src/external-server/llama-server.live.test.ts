// Llama-server live tests exercise discovery and the shared OpenAI completions transport.
import {
  streamSimple,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import {
  createLiveValueTool,
  requireLiveToolCall,
} from "../../../test-support/live-value-tool.test-support.js";
import {
  makeTextToolResult,
  makeUserMessage,
} from "../../../test-support/message-fixtures.test-support.js";
import { discoverLlamaServer } from "./discovery.js";
import { wrapLlamaServerStream } from "./stream.js";

const LIVE_URL = process.env.LLAMA_SERVER_LIVE_URL?.trim() ?? "";
const LIVE_KEY = process.env.LLAMA_SERVER_API_KEY?.trim() ?? "";
const LIVE_MODEL_ID = process.env.LLAMA_SERVER_LIVE_MODEL_ID?.trim() ?? "";
const LIVE = isLiveTestEnabled(["LLAMA_SERVER_LIVE_TEST"]) && LIVE_URL.length > 0;
const describeLive = LIVE ? describe : describe.skip;
const liveStream = wrapLlamaServerStream({
  streamFn: streamSimple,
  thinkingLevel: "off",
} as unknown as ProviderWrapStreamFnContext);

async function completeViaPlugin(
  model: Model<"openai-completions">,
  context: Context,
  options: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const stream = await liveStream(model, context, options);
  return await stream.result();
}

async function resolveLiveModel(): Promise<{
  model: Model<"openai-completions">;
  supportsTools: boolean;
}> {
  const discovery = await discoverLlamaServer({
    baseUrl: LIVE_URL,
    apiKey: LIVE_KEY,
  });
  if (discovery.kind !== "success") {
    throw new Error(`llama-server discovery failed: ${discovery.kind}`);
  }
  const discovered = LIVE_MODEL_ID
    ? discovery.models.find((entry) => entry.config.id === LIVE_MODEL_ID)
    : (discovery.models.find((entry) => entry.status === "loaded") ?? discovery.models[0]);
  if (!discovered) {
    throw new Error("llama-server returned no models");
  }
  return {
    model: {
      ...discovered.config,
      provider: "llama-cpp",
      api: "openai-completions",
      baseUrl: discovery.endpoint.inferenceBaseUrl,
      input: discovered.config.input.filter(
        (entry): entry is "text" | "image" => entry === "text" || entry === "image",
      ),
    } as Model<"openai-completions">,
    supportsTools: discovered.config.compat?.supportsTools === true,
  };
}

describeLive("llama-server live", () => {
  it("discovers and completes through the OpenAI completions transport", async () => {
    const { model } = await resolveLiveModel();
    const responses = await Promise.all(
      ["one", "two"].map((word) =>
        completeViaPlugin(
          model,
          {
            messages: [makeUserMessage(`Reply with exactly: ${word}`, Date.now())],
          },
          {
            apiKey: LIVE_KEY || "llama-cpp-local",
            maxTokens: 64,
          },
        ),
      ),
    );

    for (const response of responses) {
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "llama-server returned an error");
      }
      expect(extractNonEmptyAssistantText(response.content).length).toBeGreaterThan(0);
    }
  }, 120_000);

  it("returns schema-constrained JSON", async () => {
    const { model } = await resolveLiveModel();
    expect(model).toMatchObject({ compat: { supportsJsonSchemaResponseFormat: true } });
    const response = await completeViaPlugin(
      model,
      {
        messages: [makeUserMessage("Return a JSON object with ok set to true.", Date.now())],
      },
      {
        apiKey: LIVE_KEY || "llama-cpp-local",
        maxTokens: 64,
        responseFormat: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    );
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "llama-server JSON turn returned an error");
    }
    expect(JSON.parse(extractNonEmptyAssistantText(response.content))).toEqual({ ok: true });
  }, 120_000);

  it("cancels an in-flight generation", async () => {
    const { model } = await resolveLiveModel();
    const controller = new AbortController();
    const pending = completeViaPlugin(
      model,
      {
        messages: [makeUserMessage("Write a detailed 2000-word history of computing.", Date.now())],
      },
      {
        apiKey: LIVE_KEY || "llama-cpp-local",
        maxTokens: 4096,
        signal: controller.signal,
      },
    );
    setTimeout(() => controller.abort(), 250);
    const response = await pending;
    expect(response.stopReason).toBe("aborted");
  }, 120_000);

  it("completes a tool-call round trip when the template advertises tools", async (ctx) => {
    const { model, supportsTools } = await resolveLiveModel();
    if (!supportsTools) {
      ctx.skip();
      return;
    }
    const tool = createLiveValueTool("live_echo");
    const user = makeUserMessage(
      "Call live_echo with value llama-server. Do not answer directly.",
      Date.now() - 2,
    );
    const first = await completeViaPlugin(
      model,
      { messages: [user], tools: [tool] },
      {
        apiKey: LIVE_KEY || "llama-cpp-local",
        maxTokens: 256,
      },
    );
    if (first.stopReason === "error") {
      throw new Error(first.errorMessage || "llama-server tool turn returned an error");
    }
    const toolCall = requireLiveToolCall(first, "llama-server model did not call a tool: ");
    expect(toolCall.name).toBe("live_echo");
    expect(toolCall.arguments).toEqual({ value: "llama-server" });

    const second = await completeViaPlugin(
      model,
      {
        messages: [
          user,
          first,
          makeTextToolResult(toolCall.id, toolCall.name, "ok", false, Date.now() - 1),
          { role: "user", content: "Reply with exactly: ok", timestamp: Date.now() },
        ],
        tools: [tool],
      },
      {
        apiKey: LIVE_KEY || "llama-cpp-local",
        maxTokens: 128,
      },
    );
    if (second.stopReason === "error") {
      throw new Error(second.errorMessage || "llama-server result turn returned an error");
    }
    expect(extractNonEmptyAssistantText(second.content)).toMatch(/^ok[.!]?$/iu);
  }, 120_000);
});
