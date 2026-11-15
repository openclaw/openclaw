import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { streamSimple } from "../llm/stream.js";
import type { Context, Model } from "../llm/types.js";
import { registerSingleProviderPlugin } from "../plugin-sdk/plugin-test-runtime.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-live-runtime.js";
import * as ssrfRuntime from "../plugin-sdk/ssrf-runtime.js";
import { resolveToolCallArgumentsEncoding } from "../plugins/provider-model-compat.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createHtmlEntityToolCallArgumentDecodingWrapper } from "./embedded-agent-runner/tool-call-argument-decoding.js";

async function routerProvider() {
  const entry = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  return registerSingleProviderPlugin(entry.default);
}

const MODEL = "xai/grok-4.7";
const opaque = "synthetic-encrypted-reasoning";
const reasoning = {
  id: "rs_fixture",
  type: "reasoning",
  summary: [],
  encrypted_content: opaque,
  status: "completed",
};
const call = {
  id: "fc_lookup",
  call_id: "call_lookup",
  type: "function_call",
  name: "lookup",
  arguments: '{"value":"&amp;"}',
  status: "completed",
};
function response(first: boolean) {
  const output = first
    ? [reasoning, call]
    : [
        {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "Synthetic answer", annotations: [], logprobs: [] },
          ],
        },
      ];
  const events: Array<Record<string, unknown> & { type: string }> = first
    ? [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...reasoning, encrypted_content: undefined },
        },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { ...call, arguments: "", status: "in_progress" },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          item_id: call.id,
          delta: call.arguments,
        },
        { type: "response.output_item.done", output_index: 1, item: call },
      ]
    : [];
  events.push({
    type: "response.completed",
    response: {
      id: first ? "resp_tool" : "resp_final",
      status: "completed",
      output,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  });
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("ClawRouter native xAI Responses replay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearLiveCatalogCacheForTests();
  });
  async function discover(eligible = true, format = "openai.responses") {
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockResolvedValue({
      response: Response.json({
        version: "clawrouter.client-catalog.v1",
        providers: [
          {
            id: "xai",
            allowed: true,
            executable: true,
            openaiCompatible: true,
            nativeBaseUrl: "/v1/native/xai",
            routes: [
              {
                endpoint: "responses",
                path: "/v1/responses",
                methods: ["POST"],
                requestFormat: format,
                responseFormat: format,
              },
            ],
            models: [
              {
                id: MODEL,
                upstream: "grok-4.7",
                capabilities: ["llm.responses"],
                supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
                nativeCapabilities: {
                  version: "clawrouter.native-capabilities.v1",
                  endpoints: { responses: { input: ["text", "image"] } },
                },
              },
            ],
            offers: [
              {
                endpoint: "responses",
                modelId: MODEL,
                eligible,
                affordability: "request-dependent",
                transport: "http",
                routeKind: "unified",
                route: "/v1/responses",
              },
            ],
          },
        ],
      }),
      finalUrl: "https://router.example/v1/catalog",
      release: async () => undefined,
    });
    const provider = await routerProvider();
    const key = "synthetic-router-key";
    const discovered = await provider.catalog?.run({
      config: {
        models: {
          providers: { clawrouter: { baseUrl: "https://router.example/v1", apiKey: key } },
        },
      } as unknown as OpenClawConfig,
      env: {},
      resolveProviderAuth: () => ({
        apiKey: key,
        discoveryApiKey: key,
        mode: "api_key",
        source: "profile",
      }),
      resolveProviderApiKey: () => ({ apiKey: key, discoveryApiKey: key }),
    });
    if (!discovered || !("provider" in discovered) || !discovered.provider) {
      throw new Error("Expected a ClawRouter catalog");
    }
    const row = discovered.provider.models.find((entry) => entry.id === MODEL);
    if (!row) {
      return undefined;
    }
    const model = {
      ...row,
      provider: "clawrouter",
      baseUrl: row.baseUrl ?? discovered.provider.baseUrl,
    } as Model<"openai-responses">;
    return {
      ...model,
      ...provider.normalizeResolvedModel?.({ provider: "clawrouter", modelId: MODEL, model }),
    } as Model<"openai-responses">;
  }

  it("does not advertise denied or unknown-format Responses offers", async () => {
    expect(await discover(false)).toBeUndefined();
    clearLiveCatalogCacheForTests();
    expect(await discover(true, "future.responses")).toBeUndefined();
  });

  it.each(["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const)(
    "keeps native reasoning, tool results and usage through %s with replay isolation",
    async (hook) => {
      const model = await discover();
      if (!model) {
        throw new Error("Expected a qualified xAI Responses model");
      }
      expect(model).toMatchObject({
        api: "openai-responses",
        input: ["text", "image"],
        compat: {
          toolSchemaProfile: "xai",
          unsupportedToolSchemaKeywords: ["minContains", "maxContains"],
          toolCallArgumentsEncoding: "html-entities",
          supportsReasoningEffort: true,
        },
      });
      const wires: Array<{
        url: string;
        auth: string | null;
        oauth: string | null;
        body: Record<string, unknown>;
      }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        wires.push({
          url: request.url,
          auth: request.headers.get("Authorization"),
          oauth: request.headers.get("X-XAI-Token-Auth"),
          body: (await request.json()) as Record<string, unknown>,
        });
        return response(wires.length === 1);
      });
      const provider = await routerProvider();
      const wrapped = provider[hook]?.({
        provider: "clawrouter",
        modelId: MODEL,
        model,
        streamFn: streamSimple,
      });
      expect(wrapped).toBeDefined();
      if (!wrapped) {
        throw new Error("Expected a ClawRouter stream hook");
      }
      // The host installs this decoder after provider hooks, before tool execution.
      expect(resolveToolCallArgumentsEncoding(model)).toBe("html-entities");
      const hostStream = createHtmlEntityToolCallArgumentDecodingWrapper(wrapped);
      const context: Context = {
        messages: [{ role: "user", content: "Run the synthetic lookup", timestamp: 1 }],
        tools: [
          {
            name: "lookup",
            description: "Synthetic lookup",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
      };
      const options = {
        apiKey: "synthetic-router-key",
        sessionId: "synthetic-session",
        authProfileId: "synthetic-profile",
        reasoning: "high" as const,
        cacheRetention: "none" as const,
      };
      const first = await (await hostStream(model, context, options)).result();
      expect(first.stopReason).toBe("toolUse");
      expect(first.usage).toMatchObject({ input: 5, output: 3, totalTokens: 8 });
      const tool = first.content.find((part) => part.type === "toolCall");
      if (tool?.type !== "toolCall") {
        throw new Error("Expected an actual parsed tool call");
      }
      expect(tool.arguments).toEqual({ value: "&" });
      const thinking = first.content.find((part) => part.type === "thinking");
      expect(thinking).toMatchObject({ thinkingSignature: expect.stringContaining(opaque) });
      context.messages.push(first, {
        role: "toolResult",
        toolCallId: tool.id,
        toolName: tool.name,
        content: [{ type: "text", text: "Synthetic lookup result" }],
        isError: false,
        timestamp: 2,
      });
      const stored = structuredClone(context);
      const second = await (await hostStream(model, context, options)).result();
      expect(second.content).toContainEqual({
        type: "text",
        text: "Synthetic answer",
        textSignature: JSON.stringify({ v: 1, id: "msg_fixture" }),
      });
      expect(second.stopReason).toBe("stop");
      const replay = wires[1]?.body.input;
      expect(replay).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "reasoning", encrypted_content: opaque }),
          expect.objectContaining({ type: "function_call", call_id: "call_lookup" }),
          expect.objectContaining({
            type: "function_call_output",
            call_id: "call_lookup",
            output: "Synthetic lookup result",
          }),
        ]),
      );
      for (const change of [{ sessionId: "other-session" }, { authProfileId: "other-profile" }]) {
        await (await hostStream(model, context, { ...options, ...change })).result();
        expect(JSON.stringify(wires.at(-1)?.body)).not.toContain(opaque);
      }
      expect(context).toEqual(stored);
      for (const wire of wires) {
        expect(wire).toMatchObject({
          url: "https://router.example/v1/responses",
          auth: "Bearer synthetic-router-key",
          oauth: null,
          body: {
            model: MODEL,
            include: expect.arrayContaining(["reasoning.encrypted_content"]),
            reasoning: expect.objectContaining({ effort: "high" }),
          },
        });
      }
    },
  );
});
