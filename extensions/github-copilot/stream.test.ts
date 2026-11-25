import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../test-support/message-fixtures.test-support.js";
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
  const streamFn = vi.fn<StreamFn>((_model, _context, options) => {
    captured.push(new Headers(omitNullRequestHeaders(options?.headers)));
    return { async *[Symbol.asyncIterator]() {} } as never;
  });
  const wrapped = expectDefined(
    wrapCopilotProviderStream({
      streamFn,
      config: {
        models: {
          providers: { "github-copilot": { headers: { "copilot-integration-id": "vscode-chat" } } },
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
  it("normalizes colliding Anthropic IDs and is idempotent", async () => {
    const long = "x".repeat(64);
    const pairs = [
      ["a.b", "a_b_3"],
      ["a:b", "a_b_4"],
      ["a_b", "a_b"],
      ["a_b_2", "a_b_2"],
      ["a.b", "a_b_5"],
      ["native_id", "native_id"],
      ["native_id", "native_id_2"],
      [long + "first", "x".repeat(62) + "_2"],
      [long, long],
    ];
    const sourceIds = pairs.map(([id]) => id!);
    const expectedIds = pairs.map(([, id]) => id!);
    const uses = sourceIds.map(toolUse),
      results = [...sourceIds, "a.b"].map(toolResult);
    const payload = {
      messages: [
        { role: "assistant", content: uses },
        { role: "user", content: results },
      ],
    };
    const base = payloadStream(payload);
    await runCopilotStream(base);
    const once = structuredClone(payload);
    await runCopilotStream(base);
    expect(payload).toEqual(once);
    expect(uses.map(({ id }) => id)).toEqual(expectedIds);
    expect(results.map(({ tool_use_id }) => tool_use_id)).toEqual([...expectedIds, "a_b_5"]);
  });

  it("patches an async caller's Anthropic payload after the hook", async () => {
    const system = { role: "system", content: "replacement system prompt" };
    const messages = [
      system,
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "private" }, toolUse("functions.read:0")],
      },
      { role: "user", content: [toolResult("functions.read:0")] },
    ];
    const payload = { messages: [{ role: "user", content: "initial request" }] };
    let returned: unknown;
    const base = vi.fn<StreamFn>(async (model, _context, options) => {
      returned = (await options?.onPayload?.(payload, model)) ?? payload;
      return { async *[Symbol.asyncIterator]() {} } as never;
    });
    await runCopilotStream(base, "anthropic-messages", {
      onPayload: async (value) => {
        if (value && typeof value === "object") {
          Object.assign(value, { messages });
        }
      },
    });
    expect(returned).toEqual({
      messages: [
        {
          ...system,
          content: [
            {
              type: "text",
              text: "replacement system prompt",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        ...toolMessages(["functions_read_0"]),
      ],
    });
  });

  it("sends uniquely paired IDs through the actual Anthropic SDK and loopback HTTP", async () => {
    const requests: Array<{
      path: string;
      integrationId: string | string[] | undefined;
      integrationHeaderCount: number;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> | string }>;
    }> = [];
    await withServer(
      (request, response) => {
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
          response.end(
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_loopback","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
          );
        });
      },
      async (baseUrl) => {
        const longPrefix = "x".repeat(64);
        const sourceIds = ["a.b", "a:b", "a_b", `${longPrefix}first`, `${longPrefix}second`];
        const model = {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          provider: "github-copilot",
          api: "anthropic-messages",
          baseUrl,
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
            makeAgentAssistantMessage({
              provider: "github-copilot",
              api: "anthropic-messages",
              model: model.id,
              content: sourceIds.map((id) => ({
                type: "toolCall" as const,
                id,
                name: "read",
                arguments: {},
              })),
              stopReason: "toolUse",
              timestamp: 2,
            }),
            ...sourceIds.map((toolCallId, index) =>
              makeTextToolResult(toolCallId, "read", `result ${index}`, false, index + 3),
            ),
          ],
        } satisfies Context;
        const persistedTranscript = structuredClone(context.messages);

        const stream = await wrapCopilotTestStream(streamSimple)(model, context, {
          apiKey: "copilot-token",
          headers: { "COPILOT-INTEGRATION-ID": "caller-identity" },
        });
        expect((await stream.result()).stopReason).toBe("stop");

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
      },
    );
  });

  it("keeps a non-empty assistant turn when Copilot replay only contains thinking", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "redacted_thinking", data: "opaque" },
          ],
        },
      ],
    };
    void runCopilotStream(payloadStream(payload));

    expect(payload.messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "[assistant reasoning omitted]" }] },
    ]);
  });

  it("does not patch an unrelated provider's Anthropic stream", () => {
    const payload = { messages: toolMessages(["functions.read:0"]) };
    const original = structuredClone(payload);
    const baseStreamFn = payloadStream(payload);
    const streamModel = { provider: "kimi", id: "k2p5", api: "anthropic-messages" } as never;
    void wrapCopilotTestStream(baseStreamFn)(streamModel, { messages: [] });
    expect(payload).toEqual(original);
  });

  it("adds Copilot headers and rewrites message IDs before payload send", () => {
    const messageId = Buffer.from(`message-${"y".repeat(24)}`).toString("base64");
    const payload = { input: [{ id: messageId, type: "message" }] };
    const baseStreamFn = payloadStream(payload);

    const imageResult = makeTextToolResult("call-1", "read", "look", false, 0);
    const messages: Context["messages"] = [
      {
        ...imageResult,
        content: [{ type: "image", data: "abc", mimeType: "image/png" }],
      },
    ];
    void runCopilotStream(baseStreamFn, "openai-responses", { headers: { "X-Test": "1" } }, {
      messages,
    } as never);

    const options = expectDefined(baseStreamFn.mock.calls[0]?.[2], "Copilot Responses options");
    expect(options.headers).toMatchObject({
      "Copilot-Integration-Id": "copilot-developer-cli",
      "Openai-Organization": "github-copilot",
      "x-initiator": "agent",
      "Copilot-Vision-Request": "true",
      "X-Test": "1",
    });
    expect(payload.input).toEqual([
      { type: "message", id: expect.stringMatching(/^msg_[a-f0-9]{16}$/) },
    ]);
  });

  it.each([false, true])(
    "sanitizes the selected Copilot Responses payload (replace=%s)",
    async (replace) => {
      const connectionBoundId = Buffer.from(`message-${"y".repeat(24)}`).toString("base64");
      const originalPayload: ResponsesTestPayload = { input: [] };
      let hookResult: unknown;
      const baseStreamFn = vi.fn((_model, _context, options) => {
        hookResult = options?.onPayload?.(originalPayload, _model);
        return { async *[Symbol.asyncIterator]() {} } as never;
      });

      const onPayload = async (payload: ResponsesTestPayload) => {
        const target: ResponsesTestPayload = replace ? { input: [] } : payload;
        target.input.push({ id: connectionBoundId, type: "message" });
        return replace ? target : undefined;
      };

      void runCopilotStream(baseStreamFn, "openai-responses", { onPayload } as never);

      const replacement = await hookResult;
      expect(JSON.stringify(replacement ?? originalPayload)).toBe(
        '{"input":[{"id":"msg_fa6fceaad75c6a9d","type":"message"}]}',
      );
    },
  );

  it("does not claim provider transport before OpenClaw chooses one", () => {
    expect(wrapCopilotProviderStream({ streamFn: undefined } as never)).toBeUndefined();
  });
});
