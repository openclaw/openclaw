import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAICompletionsTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "@openclaw/ai/transports";
import { describe, expect, it, vi } from "vitest";
import {
  COLD_RUNNER_HTTP_TEST_TIMEOUT_MS,
  expectOpenAITransportRequestPolicy,
} from "../../test/helpers/openai-transport-request-policy.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { classifyAssistantFailoverReason } from "./embedded-agent-helpers/assistant-message-failures.js";
import { formatUserFacingAssistantErrorText } from "./embedded-agent-helpers/error-text.js";
import {
  type CapturedStreamEvent,
  makeCompletionsModel,
  createResponsesAssistantOutput,
  createAzureResponsesModel,
  streamChunks,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";

async function captureStream(chunks: readonly unknown[]) {
  const model = createAzureResponsesModel();
  const output = createResponsesAssistantOutput(model);
  const events: CapturedStreamEvent[] = [];
  await testing.processResponsesStream(
    streamChunks(chunks),
    output,
    { push: (event) => events.push(event as CapturedStreamEvent) },
    model,
  );
  return { output, events };
}

describe("openai transport stream", () => {
  it.each([
    {
      api: "openai-responses" as const,
      provider: "custom-openai",
      createStream: createOpenAIResponsesTransportStreamFn,
    },
    {
      api: "azure-openai-responses" as const,
      provider: "azure-openai-responses-devdiv",
      createStream: createAzureOpenAIResponsesTransportStreamFn,
    },
  ])(
    "honors turn timeout and zero retries over real $api HTTP",
    expectOpenAITransportRequestPolicy,
    COLD_RUNNER_HTTP_TEST_TIMEOUT_MS,
  );

  it("classifies OpenAI-compatible unsupported-model detail from failed chat requests", async () => {
    await withServer(
      (req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(400, {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": "req_not_supported_model",
          });
          res.end(
            JSON.stringify({
              error: {
                code: "400",
                message: "Param Incorrect",
                param: "Not supported model some-model-id",
              },
            }),
          );
        });
      },
      async (baseUrl) => {
        const model = makeCompletionsModel({
          id: "some-model-id",
          name: "Some Model",
          baseUrl: `${baseUrl}/v1`,
        });
        const stream = createOpenAICompletionsTransportStreamFn()(
          model,
          {
            systemPrompt: "system",
            messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
            tools: [],
          } as never,
          { apiKey: "test-key" } as never,
        );

        let errorPayload: Record<string, unknown> | undefined;
        for await (const event of stream as AsyncIterable<{
          type: string;
          error?: Record<string, unknown>;
        }>) {
          if (event.type === "error") {
            errorPayload = event.error;
          }
        }

        expect(errorPayload).toMatchObject({
          stopReason: "error",
          errorMessage: "400 Param Incorrect",
          errorCode: "400",
        });
        expect(String(errorPayload?.errorBody)).toContain("Not supported model some-model-id");
        expect(classifyAssistantFailoverReason(errorPayload as never)).toBe("model_not_found");
        expect(formatUserFacingAssistantErrorText(errorPayload as never)).toBe(
          "This model was not found. Choose another model in the Control UI.",
        );
      },
    );
  });

  it("yields to aborts during bursty Responses streams", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const abort = new AbortController();
    const stream = { push: vi.fn() };
    let yieldedToTimer = false;

    async function* mockStream() {
      yield { type: "response.output_item.added", item: { type: "message" } };
      for (let index = 0; index < 512; index += 1) {
        yield { type: "response.output_text.delta", delta: "x" };
      }
    }

    setTimeout(() => {
      yieldedToTimer = true;
      abort.abort();
    }, 0);

    await expect(
      testing.processResponsesStream(mockStream(), output, stream, model, {
        signal: abort.signal,
      }),
    ).rejects.toThrow("Request was aborted");
    expect(yieldedToTimer).toBe(true);
    expect(stream.push.mock.calls.length).toBeLessThan(512);
  });

  it("omits accumulated partial snapshots from Responses text deltas", async () => {
    const { output, events } = await captureStream([
      { type: "response.output_item.added", item: { type: "message" } },
      { type: "response.output_text.delta", delta: "a" },
      { type: "response.output_text.delta", delta: "b" },
      { type: "response.completed", response: { id: "resp_text", status: "completed" } },
    ]);

    const textDeltas = events.filter((event) => event.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas.every((event) => !("partial" in event))).toBe(true);
    expect(output.content).toEqual([{ type: "text", text: "ab" }]);
  });

  it.each([false, true])(
    "materializes stable done tool identity (added first: %s)",
    async (added) => {
      const item = {
        type: "function_call",
        name: "computer",
        arguments: '{"action":"screenshot"}',
        status: "completed",
        ...(added ? { id: "fc_canonical", call_id: "call_canonical" } : {}),
      };

      const { output, events } = await captureStream([
        ...(added
          ? [
              {
                type: "response.output_item.added",
                output_index: 0,
                sequence_number: 0,
                item: { type: "function_call", name: "computer", arguments: "" },
              },
            ]
          : []),
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: added ? 1 : 0,
          item,
        },
        {
          type: "response.completed",
          sequence_number: added ? 2 : 1,
          response: {
            id: added ? "resp_canonical_tool_identity" : "resp_done_only_idless",
            status: "completed",
            output: [item],
          },
        },
      ]);

      expect(output.stopReason).toBe("toolUse");
      expect(output.content).toEqual([
        {
          type: "toolCall",
          id: added ? "call_canonical|fc_canonical" : expect.stringMatching(/^call_[0-9a-f]{24}$/),
          name: "computer",
          arguments: { action: "screenshot" },
        },
      ]);
      const toolEvents = events.filter((event) => event.type?.startsWith("toolcall_")) as Array<{
        type: string;
        contentIndex: number;
        toolCall?: { id?: string };
      }>;
      expect(toolEvents.map((event) => [event.type, event.contentIndex])).toEqual([
        ["toolcall_start", 0],
        ["toolcall_end", 0],
      ]);
      expect(toolEvents[1]?.toolCall?.id).toBe((output.content[0] as { id?: string }).id);
    },
  );
});
