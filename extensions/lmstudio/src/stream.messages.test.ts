import type { ServerResponse } from "node:http";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  streamSimple,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import plugin from "../index.js";
import { messagesTextResponse, streamModel } from "./stream.test-support.js";

type Request = {
  path: string;
  authorization?: string;
  apiKey?: string | string[];
  body: Record<string, unknown>;
};
const provider = capturePluginRegistration(plugin).providers[0];
if (!provider?.wrapStreamFn || !provider.normalizeToolSchemas) {
  throw new Error("Missing LM Studio transport hooks");
}
const wrapStreamFn = provider.wrapStreamFn;
const createStreamFn = provider.createStreamFn;
const normalizeToolSchemas = provider.normalizeToolSchemas;
const user: Context["messages"][number] = { role: "user", content: "Use the probe.", timestamp: 1 };
const responseFormat = {
  type: "json_schema",
  json_schema: {
    name: "probe",
    schema: {
      type: "object",
      properties: { tag: { type: "string" } },
      required: ["tag"],
      additionalProperties: false,
    },
  },
};
const structuredReply = `data: ${JSON.stringify({ id: "completion_probe", choices: [{ index: 0, delta: { content: '{"tag":"READY"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 17, total_tokens: 28 } })}\n\ndata: [DONE]\n\n`;

function sse(events: Array<{ type: string } & Record<string, unknown>>): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function messageStart() {
  return {
    type: "message_start",
    message: {
      id: "msg_probe",
      role: "assistant",
      content: [],
      usage: { input_tokens: 11, output_tokens: 0 },
    },
  };
}

async function withTransport(
  run: (fixture: {
    requests: Request[];
    model: Model;
    call: (context?: Context, options?: SimpleStreamOptions, model?: Model) => ReturnType<StreamFn>;
  }) => Promise<void>,
  respond: (response: ServerResponse, index: number, path: string) => void = (response) =>
    response.end(messagesTextResponse("READY")),
  thinkingLevel: "off" | "medium" | "adaptive" | null = "medium",
  extraParams?: Record<string, unknown>,
) {
  vi.stubEnv("NO_PROXY", "127.0.0.1");
  vi.stubEnv("no_proxy", "127.0.0.1");
  const requests: Request[] = [];
  await withServer(
    (request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk: string) => {
        body += chunk;
      });
      request.once("end", () => {
        requests.push({
          path: request.url ?? "",
          authorization: request.headers.authorization,
          apiKey: request.headers["x-api-key"],
          body: JSON.parse(body),
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        respond(response, requests.length, request.url ?? "");
      });
    },
    async (origin) => {
      const model = streamModel(`${origin}/v1`, {
        id: "google/gemma-4-e4b",
        reasoning: true,
        contextWindow: 8192,
        contextTokens: 8192,
        maxTokens: 128,
        compat: {
          supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
          reasoningEffortMap: { off: "none", max: "xhigh" },
        },
      });
      const config = createModelProviderConfig({
        lmstudio: {
          baseUrl: `${origin}/v1`,
          api: "openai-completions",
          models: [],
          params: { preload: false },
        },
      });
      const wrapped = wrapStreamFn({
        provider: "lmstudio",
        modelId: model.id,
        thinkingLevel: thinkingLevel ?? undefined,
        extraParams,
        config,
        streamFn:
          createStreamFn?.({ provider: "lmstudio", modelId: model.id, model, config }) ??
          streamSimple,
      });
      if (!wrapped) {
        throw new Error("Missing LM Studio stream");
      }
      await run({
        requests,
        model,
        call: (context, options, selected = model) =>
          wrapped(selected, context ?? { messages: [user] }, {
            apiKey: "synthetic-key",
            ...options,
          }),
      });
    },
  );
}

afterEach(() => vi.unstubAllEnvs());

type ThinkingCase = {
  api: "openai-completions" | "anthropic-messages";
  reasoning: SimpleStreamOptions["reasoning"];
  thinkingLevel: "off" | "medium" | "adaptive" | null;
  map: Record<string, string> | undefined;
  expected: "enabled" | "disabled" | "omitted";
};

it.each<ThinkingCase>([
  {
    api: "openai-completions",
    reasoning: "medium",
    thinkingLevel: "medium",
    map: undefined,
    expected: "enabled",
  },
  {
    api: "anthropic-messages",
    reasoning: "off",
    thinkingLevel: "off",
    map: undefined,
    expected: "disabled",
  },
  {
    api: "openai-completions",
    reasoning: "medium",
    thinkingLevel: "medium",
    map: { medium: "none" },
    expected: "disabled",
  },
  {
    api: "openai-completions",
    reasoning: "off",
    thinkingLevel: "off",
    map: { off: "on" },
    expected: "enabled",
  },
  {
    api: "openai-completions",
    reasoning: undefined,
    thinkingLevel: null,
    map: undefined,
    expected: "omitted",
  },
  {
    api: "openai-completions",
    reasoning: undefined,
    thinkingLevel: "off",
    map: undefined,
    expected: "disabled",
  },
  {
    api: "openai-completions",
    reasoning: undefined,
    thinkingLevel: "medium",
    map: undefined,
    expected: "enabled",
  },
  {
    api: "openai-completions",
    reasoning: "off",
    thinkingLevel: "medium",
    map: undefined,
    expected: "disabled",
  },
  {
    api: "openai-completions",
    reasoning: undefined,
    thinkingLevel: "adaptive",
    map: { adaptive: "none", off: "on" },
    expected: "disabled",
  },
])(
  "routes $api/$reasoning with wrapper $thinkingLevel and map $map to Messages $expected",
  async ({ api, reasoning, thinkingLevel, map, expected }) => {
    await withTransport(
      async ({ call, model, requests }) => {
        const selected: Model = {
          ...model,
          api,
          maxTokens: 8192,
          compat: { ...model.compat, ...(map ? { reasoningEffortMap: map } : {}) },
        };
        const stream = await call(undefined, { reasoning, maxTokens: 128 }, selected);
        const result = await stream.result();
        expect(requests[0]?.path).toBe("/v1/messages");
        expect(result).toMatchObject({
          stopReason: "stop",
          content: [{ type: "text", text: "READY" }],
          usage: { input: 11, output: 17 },
        });
        expect(requests).toEqual([
          expect.objectContaining({
            path: "/v1/messages",
            apiKey: "synthetic-key",
            body: expect.objectContaining({ max_tokens: 128 }),
          }),
        ]);
        if (expected === "omitted") {
          expect(requests[0]?.body).not.toHaveProperty("thinking");
        } else {
          expect(requests[0]?.body).toMatchObject({ thinking: { type: expected } });
        }
        expect(requests[0]?.body).not.toHaveProperty("reasoning_effort");
      },
      undefined,
      thinkingLevel,
    );
  },
);

it("preserves a caller payload replacement's lower output cap", async () => {
  await withTransport(async ({ call, model, requests }) => {
    const stream = await call(
      undefined,
      {
        reasoning: "medium",
        maxTokens: 512,
        onPayload: (payload) => ({ ...asRecord(payload), max_tokens: 64 }),
      },
      { ...model, maxTokens: 8192 },
    );
    expect(await stream.result()).toMatchObject({ stopReason: "stop" });
    expect(requests[0]?.body.max_tokens).toBe(64);
  });
});

it.each(["openai-completions", "anthropic-messages"] as const)(
  "keeps %s thinking separate through tool replay and a transport switch",
  async (sourceApi) => {
    await withTransport(
      async ({ call, model, requests }) => {
        const tools = normalizeToolSchemas({
          provider: "lmstudio",
          model,
          tools: [
            {
              name: "probe",
              label: "Probe",
              description: "Return a tag",
              parameters: Type.Object({ tag: Type.String({ pattern: "^READY$" }) }),
              execute: async () => ({ content: [{ type: "text", text: "PROBE_OK" }], details: {} }),
            },
          ],
        });
        if (!tools) {
          throw new Error("LM Studio did not return normalized tool schemas");
        }
        const first = await call({ messages: [user], tools }, { reasoning: "medium" });
        const events: AssistantMessageEvent[] = [];
        for await (const event of first) {
          events.push(event);
        }
        const assistant = await first.result();
        expect(requests[0]?.path).toBe("/v1/messages");
        expect(events.some((event) => event.type === "toolcall_delta")).toBe(true);
        expect(assistant).toMatchObject({
          stopReason: "toolUse",
          usage: { input: 11, output: 17 },
          content: [
            { type: "thinking", thinking: "Reason privately." },
            { type: "toolCall", id: "call_a", name: "probe", arguments: { tag: "READY" } },
            { type: "toolCall", id: "call_b", name: "probe", arguments: { tag: "READY" } },
          ],
        });
        expect(requests[0]?.body.tools).toEqual([
          expect.objectContaining({
            input_schema: {
              type: "object",
              required: ["tag"],
              properties: { tag: { type: "string" } },
            },
          }),
        ]);
        const savedAssistant = {
          ...assistant,
          api: sourceApi,
          content: assistant.content.map((block) =>
            block.type === "thinking" && sourceApi === "openai-completions"
              ? Object.assign({}, block, { thinkingSignature: "reasoning_content" })
              : block,
          ),
        };
        const replay: Context = {
          tools,
          messages: [
            user,
            savedAssistant,
            ...["call_a", "call_b"].map((id) => ({
              role: "toolResult" as const,
              toolCallId: id,
              toolName: "probe",
              content: [{ type: "text" as const, text: "PROBE_OK" }],
              isError: false,
              timestamp: 2,
            })),
          ],
        };
        const next = await call(replay, { reasoning: "medium" });
        expect(await next.result()).toMatchObject({ content: [{ type: "text", text: "READY" }] });
        expect(requests[1]?.body.messages).toEqual([
          { role: "user", content: "Use the probe." },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Reason privately.", signature: "" },
              { type: "tool_use", id: "call_a", name: "probe", input: { tag: "READY" } },
              { type: "tool_use", id: "call_b", name: "probe", input: { tag: "READY" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_a", content: "PROBE_OK", is_error: false },
              { type: "tool_result", tool_use_id: "call_b", content: "PROBE_OK", is_error: false },
            ],
          },
        ]);
        const structured = await call(replay, { reasoning: "off", responseFormat });
        await structured.result();
        expect(requests[2]?.path).toBe("/v1/chat/completions");
        const messages = requests[2]?.body.messages;
        if (!Array.isArray(messages)) {
          throw new Error("Missing replay messages");
        }
        const visibleAssistantContent = messages
          .map(asRecord)
          .filter((message) => message.role === "assistant")
          .map((message) => message.content);
        expect(JSON.stringify(visibleAssistantContent)).not.toContain("Reason privately.");
      },
      (response, index) => {
        if (index === 3) {
          response.end(structuredReply);
          return;
        }
        if (index > 1) {
          response.end(messagesTextResponse("READY"));
          return;
        }
        response.end(
          sse([
            messageStart(),
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "Reason privately." },
            },
            { type: "content_block_stop", index: 0 },
            ...["call_a", "call_b"].flatMap((id, offset) => [
              {
                type: "content_block_start",
                index: offset + 1,
                content_block: { type: "tool_use", id, name: "probe", input: {} },
              },
              {
                type: "content_block_delta",
                index: offset + 1,
                delta: { type: "input_json_delta", partial_json: '{"tag":' },
              },
              {
                type: "content_block_delta",
                index: offset + 1,
                delta: { type: "input_json_delta", partial_json: '"READY"}' },
              },
              { type: "content_block_stop", index: offset + 1 },
            ]),
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 17 },
            },
            { type: "message_stop" },
          ]),
        );
      },
    );
  },
);

it.each(["openai-completions", "anthropic-messages"] as const)(
  "selects Chat Completions before dispatch for %s structured output",
  async (api) => {
    await withTransport(
      async ({ call, model, requests }) => {
        const stream = await call(
          undefined,
          {
            reasoning: "off",
            responseFormat,
          },
          { ...model, api },
        );
        expect(await stream.result()).toMatchObject({
          stopReason: "stop",
          content: [{ type: "text", text: '{"tag":"READY"}' }],
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          path: "/v1/chat/completions",
          body: {
            response_format: { type: "json_schema" },
            stream_options: { include_usage: true },
            reasoning_effort: "none",
          },
        });
      },
      (response) => response.end(structuredReply),
      "off",
    );
  },
);

it("selects Completions for configured extra_body.response_format before dispatch", async () => {
  await withTransport(
    async ({ call, requests }) => {
      const stream = await call(undefined, { reasoning: "off" });
      await stream.result();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        path: "/v1/chat/completions",
        body: { response_format: responseFormat },
      });
    },
    (response) => response.end(structuredReply),
    "off",
    { extra_body: { response_format: responseFormat } },
  );
});

it("cancels the shared Messages stream after a text delta", async () => {
  await withTransport(
    async ({ call, requests }) => {
      const controller = new AbortController();
      const stream = await call(undefined, { signal: controller.signal, reasoning: "off" });
      for await (const event of stream) {
        if (event.type === "text_delta") {
          controller.abort();
        }
      }
      const result = await stream.result();
      expect(requests[0]?.path).toBe("/v1/messages");
      expect(result).toMatchObject({ stopReason: "aborted" });
    },
    (response, _index, path) => {
      if (path !== "/v1/messages") {
        response.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "READY" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      response.write(
        sse([
          messageStart(),
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "READY" } },
        ]),
      );
    },
    "off",
  );
});
