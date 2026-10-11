import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { createAiTransportHost, runWithAiTransportHost } from "../host.js";
import { streamOpenAIResponses } from "../providers/openai-responses.js";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  ToolResultMessage,
} from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 256,
} satisfies Model<"openai-responses">;

// Valid one-pixel red, green, and blue PNGs keep transport image validation active.
const images = [
  {
    type: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  },
  {
    type: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC",
  },
  {
    type: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
  },
] satisfies [ImageContent, ImageContent, ImageContent];
const [red, green, blue] = images;
const [wireRed, wireGreen, wireBlue] = images.map((image) => ({
  type: "input_image",
  detail: "auto",
  image_url: `data:image/png;base64,${image.data}`,
}));

const routes = [
  {
    name: "provider",
    run: (context: Context) =>
      streamOpenAIResponses(model, context, { apiKey: "synthetic-image-order" }).result(),
  },
  {
    name: "managed transport",
    run: async (context: Context) => {
      const stream = await createOpenAIResponsesTransportStreamFn()(model, context, {
        apiKey: "synthetic-image-order",
        transport: "sse",
      });
      return stream.result();
    },
  },
];

async function captureToolResult(
  run: (context: Context) => Promise<AssistantMessage>,
  content: ToolResultMessage["content"],
) {
  const requests: ResponseCreateParamsStreaming[] = [];
  const captureFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://api.openai.com/v1/responses");
    requests.push(JSON.parse(await request.text()) as ResponseCreateParamsStreaming);
    const event = {
      type: "response.completed",
      response: {
        id: "resp_image_order",
        status: "completed",
        output: [],
        usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
      },
    };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const result = await runWithAiTransportHost(
    createAiTransportHost({ buildModelFetch: () => captureFetch }),
    () =>
      run({
        messages: [
          { role: "user", content: "Compare the before and after images.", timestamp: 1 },
          {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [
              { type: "toolCall", id: "call_compare|fc_compare", name: "compare", arguments: {} },
            ],
            usage: createZeroUsage(),
            stopReason: "toolUse",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "call_compare|fc_compare",
            toolName: "compare",
            content,
            isError: false,
            timestamp: 3,
          },
        ],
      }),
  );
  expect(result.stopReason).toBe("stop");
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (!request || !Array.isArray(request.input)) {
    throw new Error("Expected serialized Responses input items");
  }
  const input = request.input;
  expect(input.find((item) => item.type === "function_call")).toMatchObject({
    call_id: "call_compare",
    name: "compare",
  });
  return input.find((item) => item.type === "function_call_output");
}

describe.each(routes)("Responses tool-result order: $name", ({ run }) => {
  it("keeps different before/after image groupings distinct on the wire", async () => {
    const before = { type: "text" as const, text: "Before:" };
    const after = { type: "text" as const, text: "After:" };
    const greenBefore = await captureToolResult(run, [before, red, green, after, blue]);
    const greenAfter = await captureToolResult(run, [before, red, after, green, blue]);

    expect.soft(greenBefore).toEqual({
      type: "function_call_output",
      call_id: "call_compare",
      output: [
        { type: "input_text", text: "Before:" },
        wireRed,
        wireGreen,
        { type: "input_text", text: "\nAfter:" },
        wireBlue,
      ],
    });
    expect.soft(greenAfter).toEqual({
      type: "function_call_output",
      call_id: "call_compare",
      output: [
        { type: "input_text", text: "Before:" },
        wireRed,
        { type: "input_text", text: "\nAfter:" },
        wireGreen,
        wireBlue,
      ],
    });
    expect(greenBefore).not.toEqual(greenAfter);
    for (const result of [greenBefore, greenAfter]) {
      if (!Array.isArray(result?.output)) {
        throw new Error("Expected native multimodal tool output");
      }
      expect(
        result.output.flatMap((part) => (part.type === "input_text" ? [part.text] : [])).join(""),
      ).toBe("Before:\nAfter:");
    }
  });

  it("keeps a leading description with a single tool image", async () => {
    expect(await captureToolResult(run, [{ type: "text", text: "Captured screen" }, red])).toEqual({
      type: "function_call_output",
      call_id: "call_compare",
      output: [{ type: "input_text", text: "Captured screen" }, wireRed],
    });
  });

  it("keeps the first caption after a leading image", async () => {
    expect(await captureToolResult(run, [red, { type: "text", text: "Caption" }])).toEqual({
      type: "function_call_output",
      call_id: "call_compare",
      output: [wireRed, { type: "input_text", text: "Caption" }],
    });
  });

  it("joins adjacent text without moving a trailing caption ahead of its image", async () => {
    expect(
      await captureToolResult(run, [
        { type: "text", text: "Before:" },
        { type: "text", text: "First screen" },
        red,
        { type: "text", text: "After:" },
        { type: "text", text: "Second screen" },
      ]),
    ).toEqual({
      type: "function_call_output",
      call_id: "call_compare",
      output: [
        { type: "input_text", text: "Before:\nFirst screen" },
        wireRed,
        { type: "input_text", text: "\nAfter:\nSecond screen" },
      ],
    });
  });
});
