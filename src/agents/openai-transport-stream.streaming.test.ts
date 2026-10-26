import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "@openclaw/ai/transports";
import { describe, expect, it, vi } from "vitest";
import {
  COLD_RUNNER_HTTP_TEST_TIMEOUT_MS,
  expectOpenAITransportRequestPolicy,
} from "../../test/helpers/openai-transport-request-policy.js";
import {
  type CapturedStreamEvent,
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

  it("yields to aborts during bursty Responses streams", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const abort = new AbortController();
    const stream = { push: vi.fn<(event: CapturedStreamEvent) => void>() };
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
    const textDeltas = stream.push.mock.calls.flat().filter((event) => event.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas.every((event) => !("partial" in event))).toBe(true);
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

      const chunks = [
        {
          type: "response.output_item.done",
          output_index: 0,
          item,
        },
        {
          type: "response.completed",
          response: {
            id: "resp_tool_identity",
            status: "completed",
            output: [item],
          },
        },
      ];
      const { output, events } = await captureStream(
        added
          ? [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "function_call", name: "computer", arguments: "" },
              },
              ...chunks,
            ]
          : chunks,
      );

      expect(output.stopReason).toBe("toolUse");
      expect(output.content).toEqual([
        {
          type: "toolCall",
          id: added ? "call_canonical|fc_canonical" : expect.stringMatching(/^call_[0-9a-f]{24}$/),
          name: "computer",
          arguments: { action: "screenshot" },
        },
      ]);
      expect(events.filter((event) => event.type?.startsWith("toolcall_"))).toMatchObject([
        { type: "toolcall_start", contentIndex: 0 },
        {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: { id: (output.content[0] as { id?: string }).id },
        },
      ]);
    },
  );
});
