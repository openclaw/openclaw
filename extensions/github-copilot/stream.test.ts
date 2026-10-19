import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { buildCopilotIdeHeaders } from "openclaw/plugin-sdk/provider-auth";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { wrapCopilotProviderStream } from "./stream.js";

type ResponsesTestPayload = { input: Array<Record<string, unknown>> };

function wrapCopilotTestStream(streamFn: StreamFn) {
  return expectDefined(wrapCopilotProviderStream({ streamFn } as never), "Copilot stream fn");
}

function runCopilotStream(
  streamFn: StreamFn,
  api = "anthropic-messages",
  options: Parameters<StreamFn>[2] = {},
  context: Parameters<StreamFn>[1] = { messages: [{ role: "user", content: "hi" }] } as never,
) {
  return wrapCopilotTestStream(streamFn)(
    { provider: "github-copilot", api, id: "test-model" } as never,
    context,
    options,
  );
}

function toolUse(id: string) {
  return { type: "tool_use", id, name: "read", input: {} };
}

function toolResult(tool_use_id: string) {
  return { type: "tool_result", tool_use_id, content: "done" };
}

function toolMessages(ids: string[]) {
  return [
    { role: "assistant", content: ids.map(toolUse) },
    { role: "user", content: ids.map(toolResult) },
  ];
}

function payloadStream(payload: unknown) {
  return vi.fn<StreamFn>((model, _context, options) => {
    options?.onPayload?.(payload, model);
    return { async *[Symbol.asyncIterator]() {} } as never;
  });
}

it("preserves a single configured integration identity through completions streaming", () => {
  const captured: Headers[] = [];
  const baseStreamFn = vi.fn<StreamFn>((_model, _context, options) => {
    captured.push(new Headers(options?.headers));
    return { async *[Symbol.asyncIterator]() {} } as never;
  });
  const wrapped = expectDefined(
    wrapCopilotProviderStream({
      streamFn: baseStreamFn,
      config: {
        models: {
          providers: {
            "github-copilot": {
              headers: { "copilot-integration-id": "vscode-chat" },
            },
          },
        },
      },
    } as never),
    "Copilot stream fn",
  );
  const model = {
    provider: "github-copilot",
    api: "openai-completions",
    id: "test-model",
  } as never;
  const context = { messages: [{ role: "user", content: "hello" }] } as never;

  void wrapped(model, context, {});
  void wrapped(model, context, { headers: { "COPILOT-INTEGRATION-ID": "caller-identity" } });

  expect(captured.map((headers) => headers.get("copilot-integration-id"))).toEqual([
    "vscode-chat",
    "caller-identity",
  ]);
});

describe("wrapCopilotAnthropicStream", () => {
  it("uniquely pairs colliding wire IDs, preserves valid IDs, and remains idempotent", () => {
    const longPrefix = "x".repeat(64);
    const pairs = [
      ["a.b", "a_b_3"],
      ["a:b", "a_b_4"],
      ["a_b", "a_b"],
      ["a_b_2", "a_b_2"],
      ["a.b", "a_b_5"],
      ["native_id", "native_id"],
      ["native_id", "native_id_3"],
      ["native_id_2", "native_id_2"],
      [`${longPrefix}first`, `${"x".repeat(62)}_2`],
      [`${longPrefix}second`, `${"x".repeat(62)}_3`],
      [longPrefix, longPrefix],
    ] as const;
    const sourceIds = pairs.map(([source]) => source);
    const expectedIds = pairs.map(([, expected]) => expected);
    const toolUseBlocks = sourceIds.map(toolUse);
    const toolResultBlocks = [...sourceIds, "a.b"].map(toolResult);
    const payload = {
      messages: [
        { role: "assistant", content: toolUseBlocks },
        { role: "user", content: toolResultBlocks },
      ],
    };
    const baseStreamFn = vi.fn<StreamFn>((model, _context, options) => {
      options?.onPayload?.(payload, model);
      const patchedOnce = structuredClone(payload);
      options?.onPayload?.(payload, model);
      expect(payload).toEqual(patchedOnce);
      return { async *[Symbol.asyncIterator]() {} } as never;
    });

    void runCopilotStream(baseStreamFn);

    const toolUseIds = toolUseBlocks.map((block) => block.id);
    const toolResultIds = toolResultBlocks.map((block) => block.tool_use_id);
    expect(toolUseIds).toEqual(expectedIds);
    expect(toolResultIds).toEqual([...expectedIds, "a_b_5"]);
  });

  it("normalizes Copilot Claude payloads returned by an async in-place caller hook", async () => {
    let returnedPayload: unknown;
    const baseStreamFn = vi.fn(async (model, _context, options) => {
      const initialPayload = { messages: [{ role: "user", content: "initial request" }] };
      const replacement = await options?.onPayload?.(initialPayload, model);
      returnedPayload = replacement ?? initialPayload;
      return { async *[Symbol.asyncIterator]() {} } as never;
    });
    const ids = ["functions.read:0", "a.b", "a:b", "a_b", "a.b"];
    const replacement = {
      messages: [
        { role: "system", content: "replacement system prompt" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "private" }, ...ids.map(toolUse)],
        },
        {
          role: "user",
          content: ids.map(toolResult),
        },
      ],
    };

    await runCopilotStream(baseStreamFn, "anthropic-messages", {
      onPayload: async (payload) => {
        if (payload && typeof payload === "object") {
          Object.assign(payload, replacement);
        }
      },
    });

    expect(JSON.stringify(returnedPayload)).toBe(
      JSON.stringify({
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: "replacement system prompt",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
          ...toolMessages(["functions_read_0", "a_b_2", "a_b_3", "a_b", "a_b_4"]),
        ],
      }),
    );
  });

  it("sends uniquely paired IDs through the actual Anthropic SDK and loopback HTTP", async () => {
    const requests: Array<{
      path: string;
      integrationId: string | string[] | undefined;
      integrationHeaderCount: number;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> | string }>;
    }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as { messages: (typeof requests)[number]["messages"] };
        requests.push({
          path: request.url ?? "",
          messages: payload.messages,
          integrationId: request.headers["copilot-integration-id"],
          integrationHeaderCount: request.rawHeaders.filter(
            (value, index) => index % 2 === 0 && value.toLowerCase() === "copilot-integration-id",
          ).length,
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_loopback","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        );
        response.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const longPrefix = "x".repeat(64);
    const sourceIds = ["a.b", "a:b", "a_b", `${longPrefix}first`, `${longPrefix}second`];
    const model = {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      provider: "github-copilot",
      api: "anthropic-messages",
      baseUrl: `http://127.0.0.1:${address.port}`,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 4_096,
      headers: { "copilot-integration-id": "model-identity" },
    } satisfies Model<"anthropic-messages">;
    const context = {
      messages: [
        { role: "user", content: "Use each tool", timestamp: 1 },
        {
          role: "assistant",
          provider: "github-copilot",
          api: "anthropic-messages",
          model: model.id,
          content: sourceIds.map((id) => ({
            type: "toolCall" as const,
            id,
            name: "read",
            arguments: {},
          })),
          usage: createZeroUsageFixture(),
          stopReason: "toolUse",
          timestamp: 2,
        },
        ...sourceIds.map((toolCallId, index) => ({
          role: "toolResult" as const,
          toolCallId,
          toolName: "read",
          content: [{ type: "text" as const, text: `result ${index}` }],
          isError: false,
          timestamp: index + 3,
        })),
      ],
    } satisfies Context;
    const persistedTranscript = structuredClone(context.messages);

    try {
      const stream = await wrapCopilotTestStream(streamSimple)(model, context, {
        apiKey: "copilot-token",
        headers: { "COPILOT-INTEGRATION-ID": "caller-identity" },
      });
      expect((await stream.result()).stopReason).toBe("stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(requests).toHaveLength(1);
    expect(context.messages).toEqual(persistedTranscript);
    expect(requests[0]).toMatchObject({
      path: "/v1/messages",
      integrationId: "caller-identity",
      integrationHeaderCount: 1,
    });
    const wireBlocks = requests[0]?.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    );
    const idsFor = (type: string, key: string) =>
      wireBlocks?.filter((block) => block.type === type).map((block) => block[key]);
    const expectedIds = ["a_b_2", "a_b_3", "a_b", longPrefix, `${"x".repeat(62)}_2`];
    expect(idsFor("tool_use", "id")).toEqual(expectedIds);
    expect(idsFor("tool_result", "tool_use_id")).toEqual(expectedIds);
  });

  it("keeps a non-empty assistant turn when Copilot replay only contains thinking", () => {
    const payload = {
      messages: [
        { role: "user", content: "use the tool result" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "redacted_thinking", data: "opaque" },
          ],
        },
        { role: "user", content: [{ type: "tool_result", content: "done" }] },
      ],
    };
    void runCopilotStream(payloadStream(payload));

    expect(payload.messages).toEqual([
      { role: "user", content: "use the tool result" },
      { role: "assistant", content: [{ type: "text", text: "[assistant reasoning omitted]" }] },
      { role: "user", content: [{ type: "tool_result", content: "done" }] },
    ]);
  });

  it("does not patch an unrelated provider's Anthropic stream", () => {
    const toolId = "functions.read:0";
    const payload = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: toolId }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolId }] },
      ],
    };
    const baseStreamFn = payloadStream(payload);
    const streamModel = { provider: "kimi", id: "k2p5", api: "anthropic-messages" } as never;
    const context = { messages: [{ role: "user", content: "hi" }] } as never;
    const options = { headers: { Existing: "1" }, onPayload: vi.fn() };

    void wrapCopilotTestStream(baseStreamFn)(streamModel, context, options as never);

    expect(baseStreamFn.mock.calls).toEqual([[streamModel, context, options]]);
    expect(payload.messages[0]?.content[0]).toEqual({ type: "tool_use", id: toolId });
    expect(payload.messages[1]?.content[0]).toEqual({ type: "tool_result", tool_use_id: toolId });
  });

  it("adds Copilot headers, sanitizes reasoning replay, and rewrites message IDs before payload send", () => {
    const reasoningId = Buffer.from(`reasoning-${"x".repeat(24)}`).toString("base64");
    const messageId = Buffer.from(`message-${"y".repeat(24)}`).toString("base64");
    const payload = {
      input: [
        { id: "rs_active", type: "reasoning", encrypted_content: "native-encrypted" },
        { type: "reasoning", status: null, encrypted_content: "idless-encrypted", summary: [] },
        { id: reasoningId, type: "reasoning", encrypted_content: "valid-encrypted-payload" },
        {
          id: "thinking_0",
          type: "reasoning",
          encrypted_content: "invalid-encrypted-payload",
          summary: [],
        },
        { id: "msg_signed", type: "message", role: "assistant" },
        { id: messageId, type: "message" },
      ],
    };
    const baseStreamFn = payloadStream(payload);

    const messages = [
      {
        role: "toolResult",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "data:image/png;base64,abc" },
        ],
      },
    ] as Context["messages"];
    void runCopilotStream(baseStreamFn, "openai-responses", { headers: { "X-Test": "1" } }, {
      messages,
    } as never);

    expect(baseStreamFn).toHaveBeenCalledOnce();
    const options = expectDefined(baseStreamFn.mock.calls[0]?.[2], "Copilot Responses options");
    expect(options).toEqual({
      headers: {
        ...buildCopilotIdeHeaders(),
        "Copilot-Integration-Id": "copilot-developer-cli",
        "Openai-Organization": "github-copilot",
        "x-initiator": "agent",
        "Copilot-Vision-Request": "true",
        "X-Test": "1",
      },
      onPayload: expect.any(Function),
    });
    expect(payload.input.map(({ type, id }) => ({ type, id }))).toEqual([
      { type: "reasoning", id: "rs_active" },
      { type: "reasoning", id: undefined },
      { type: "reasoning", id: undefined },
      { type: "message", id: undefined },
      { type: "message", id: expect.stringMatching(/^msg_[a-f0-9]{16}$/) },
    ]);
    expect(payload.input.slice(0, 3).every((item) => item.encrypted_content)).toBe(true);
  });

  it("sanitizes all sync and async Copilot Responses hook outcomes", async () => {
    for (const asyncHook of [false, true]) {
      for (const replace of [false, true]) {
        const connectionBoundId = Buffer.from(`message-${"y".repeat(24)}`).toString("base64");
        const originalPayload: ResponsesTestPayload = { input: [] };
        let hookResult: unknown;
        const baseStreamFn = vi.fn((_model, _context, options) => {
          hookResult = options?.onPayload?.(originalPayload, _model);
          return { async *[Symbol.asyncIterator]() {} } as never;
        });

        const mutatePayload = (payload: ResponsesTestPayload) => {
          const target: ResponsesTestPayload = replace ? { input: [] } : payload;
          target.input.push({ id: connectionBoundId, type: "message" });
          return replace ? target : undefined;
        };
        const onPayload = asyncHook
          ? async (payload: ResponsesTestPayload) => mutatePayload(payload)
          : (payload: ResponsesTestPayload) => mutatePayload(payload);

        void runCopilotStream(baseStreamFn, "openai-responses", { onPayload } as never);

        expect(hookResult instanceof Promise).toBe(asyncHook);
        const replacement = await hookResult;
        expect(replacement !== undefined).toBe(replace);
        const returnedPayload = (replacement ?? originalPayload) as ResponsesTestPayload;
        expect(JSON.stringify(returnedPayload)).toBe(
          '{"input":[{"id":"msg_fa6fceaad75c6a9d","type":"message"}]}',
        );
      }
    }
  });

  it("does not claim provider transport before OpenClaw chooses one", () => {
    expect(wrapCopilotProviderStream({ streamFn: undefined } as never)).toBeUndefined();
  });
});
