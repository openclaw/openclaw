import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool, type StreamFn } from "openclaw/plugin-sdk/agent-core";
import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import { stream, type Context, type Model, type ToolResultMessage } from "openclaw/plugin-sdk/llm";
import {
  createRuntimeEnv,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type CapturedRequest = {
  method?: string;
  url?: string;
  authorization?: string;
  body: Record<string, unknown>;
};

function sseChunk(
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  return {
    id: "chatcmpl-databricks-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

describe("databricks provider end-to-end", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("onboards, streams a tool call, executes it, and sends the tool result back through Unity Gateway", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const auth = provider.auth[0];
    if (!auth?.runNonInteractive) {
      throw new Error("expected Databricks non-interactive auth");
    }

    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-databricks-e2e-"));
    vi.stubEnv("DATABRICKS_HOST", "https://dbc-e2e.cloud.databricks.com/");
    const existingProvider = {
      baseUrl: "https://existing.example/v1",
      models: [],
    };
    const initialConfig: OpenClawConfig = {
      models: { providers: { existing: existingProvider } },
      agents: { defaults: { models: { "existing/model": { alias: "Keep me" } } } },
    };

    const requests: CapturedRequest[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          body,
        });

        const model = String(body.model);
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (requests.length === 1) {
          for (const row of [
            sseChunk(model, {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_weather",
                  type: "function",
                  function: { name: "weather", arguments: '{"city":"' },
                },
              ],
            }),
            sseChunk(model, {
              tool_calls: [{ index: 0, function: { arguments: 'Paris"}' } }],
            }),
            sseChunk(model, {}, "tool_calls"),
          ]) {
            response.write(`data: ${JSON.stringify(row)}\n\n`);
          }
        } else {
          response.write(
            `data: ${JSON.stringify(sseChunk(model, { role: "assistant", content: "TOOL_" }))}\n\n`,
          );
          response.write(`data: ${JSON.stringify(sseChunk(model, { content: "OK" }))}\n\n`);
          response.write(`data: ${JSON.stringify(sseChunk(model, {}, "stop"))}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      });
    });

    try {
      const onboarded = await auth.runNonInteractive({
        authChoice: "databricks-token",
        config: initialConfig,
        baseConfig: initialConfig,
        opts: { databricksToken: "e2e-token" },
        runtime: createRuntimeEnv(),
        agentDir,
        resolveApiKey: async () => ({ key: "e2e-token", source: "flag" }),
        toApiKeyCredential: ({ provider: providerId, resolved }) => ({
          type: "api_key",
          provider: providerId,
          key: resolved.key,
        }),
      });
      if (!onboarded) {
        throw new Error("Databricks onboarding returned no config");
      }
      expect(onboarded.models?.providers?.existing).toEqual(existingProvider);
      expect(onboarded.agents?.defaults?.model).toMatchObject({
        primary: "databricks/system.ai.claude-sonnet-4-5",
      });
      expect(onboarded.agents?.defaults?.models?.["existing/model"]).toEqual({ alias: "Keep me" });
      const productionBaseUrl = onboarded.models?.providers?.databricks?.baseUrl;
      expect(productionBaseUrl).toBe("https://dbc-e2e.cloud.databricks.com/ai-gateway/mlflow/v1");

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing loopback address");
      }
      const gatewayPath = new URL(productionBaseUrl!).pathname;
      const loopbackBaseUrl = `http://127.0.0.1:${address.port}${gatewayPath}`;
      const resolved = provider.resolveDynamicModel?.({
        provider: "databricks",
        modelId: "main.agents.weather-model",
        providerConfig: { baseUrl: loopbackBaseUrl, models: [] },
        config: onboarded,
      } as never) as Model | undefined;
      if (!resolved) {
        throw new Error("Databricks dynamic model did not resolve");
      }

      const runtimeModel = attachModelProviderRequestTransport(resolved, {
        allowPrivateNetwork: true,
      }) as Model;
      const weather = {
        name: "weather",
        label: "weather",
        description: "Return a deterministic weather fixture",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
        execute: vi.fn(async (_id: string, input: { city: string }) => ({
          content: [{ type: "text" as const, text: `${input.city}:21C` }],
          details: { city: input.city, celsius: 21 },
        })),
      } as AgentTool;

      const realStream: StreamFn = (model, context, options) =>
        stream(model, context as Context, { ...options, apiKey: "e2e-token" });
      const agent = new Agent({
        initialState: { model: runtimeModel, tools: [weather] },
        streamFn: realStream,
      });

      await agent.prompt("What is the weather in Paris?");

      expect(weather.execute).toHaveBeenCalledOnce();
      expect(vi.mocked(weather.execute).mock.calls[0]?.[1]).toEqual({ city: "Paris" });
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request).toMatchObject({
          method: "POST",
          url: "/ai-gateway/mlflow/v1/chat/completions",
          authorization: "Bearer e2e-token",
        });
        expect(request.body.model).toBe("main.agents.weather-model");
        expect(request.body.stream).toBe(true);
      }

      const firstTools = requests[0]?.body.tools as
        | Array<{ function?: { name?: string } }>
        | undefined;
      expect(firstTools?.some((tool) => tool.function?.name === "weather")).toBe(true);

      const secondMessages = requests[1]?.body.messages as Array<Record<string, unknown>>;
      expect(
        secondMessages.some((message) => message.role === "assistant" && message.tool_calls),
      ).toBe(true);
      const toolResult = secondMessages.find(
        (message) => message.role === "tool" && message.tool_call_id === "call_weather",
      ) as ToolResultMessage | undefined;
      expect(toolResult).toBeDefined();
      expect(JSON.stringify(toolResult)).toContain("Paris:21C");

      const finalMessage = agent.state.messages.at(-1);
      expect(finalMessage).toMatchObject({ role: "assistant" });
      expect(JSON.stringify(finalMessage)).toContain("TOOL_OK");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
