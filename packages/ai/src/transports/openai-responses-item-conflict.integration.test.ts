import type { Context } from "@openclaw/llm-core";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { transformTransportMessages } from "../../../../src/agents/transport-message-transform.js";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamOpenAIResponses } from "../providers/openai-responses.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import {
  createResponsesLoopbackServer,
  responsesLoopbackModel,
} from "./openai-responses-loopback.test-support.js";
import {
  argumentDelta,
  completedResponse,
  outputItem,
  userMessage,
  wireCall,
  wireMessage,
} from "./openai-stream-cases.test-support.js";

const conflict = {
  type: "response.failed",
  response: {
    id: "resp_rejected",
    status: "failed",
    error: { code: "item_conflict", message: "Item already exists with different content." },
  },
};
const reasoning = {
  type: "reasoning",
  id: "rs_saved",
  summary: [],
  encrypted_content: "synthetic-reasoning",
};

it.each([
  "sse",
  "sse-progress",
  "sse-error-progress",
  "sse-compaction",
  "http-error",
  "websocket-cached",
  "websocket-progress",
  "websocket-error-progress",
  "websocket-compaction",
  "provider",
  "degenerate-abort",
] as const)(
  "reanchors conflicting saved tool items once and retains the repair after reload over %s",
  async (mode) => {
    const transport = mode.startsWith("websocket") ? "websocket-cached" : "sse";
    const host = getAiTransportHost();
    const logInfo = vi.fn();
    configureAiTransportHost({ logInfo });
    onTestFinished(() => configureAiTransportHost(host));
    const call = wireCall("saved", "record_value", '{ "n": 1 }');
    const server = await createResponsesLoopbackServer((turn) => {
      if (turn === 1) {
        return [
          outputItem("added", reasoning),
          outputItem("done", reasoning),
          completedResponse("resp_saved", [reasoning, call]),
        ];
      }
      if (mode === "degenerate-abort" && turn === 2) {
        expect(server.requests.at(-1)?.previous_response_id).toBe("resp_saved");
        const partial = wireCall("partial", "record_value");
        return [
          outputItem("added", { ...partial, arguments: "", status: "in_progress" }),
          argumentDelta(partial.id, " ".repeat(4096)),
        ];
      }
      // Model a stored item's immutable identity, not a fixed failure count.
      const input = server.requests.at(-1)?.input as Array<Record<string, unknown>>;
      if (input.some((item) => item.id === call.id && item.arguments !== call.arguments)) {
        return mode === "http-error"
          ? { status: 400, body: { error: conflict.response.error } }
          : [
              ...(mode.endsWith("-compaction")
                ? [
                    outputItem("added", {
                      type: "compaction",
                      id: "cmp_pending",
                      encrypted_content: "",
                    }),
                    {
                      type: "response.compaction.compacting",
                      item_id: "cmp_pending",
                      output_index: 0,
                      sequence_number: 1,
                    },
                    outputItem("done", {
                      type: "compaction",
                      id: "cmp_pending",
                      encrypted_content: "synthetic-checkpoint",
                    }),
                  ]
                : []),
              ...(mode.endsWith("-progress")
                ? [
                    { type: "response.created", response: { id: "resp_rejected", output: [] } },
                    {
                      type: "response.compaction.compacting",
                      item_id: "cmp_pending",
                      output_index: 0,
                      sequence_number: 1,
                    },
                  ]
                : []),
              mode.includes("error-progress")
                ? { type: "error", error: conflict.response.error }
                : mode.endsWith("-compaction")
                  ? {
                      ...conflict,
                      response: {
                        ...conflict.response,
                        output: [
                          {
                            type: "compaction",
                            id: "cmp_pending",
                            encrypted_content: "synthetic-checkpoint",
                          },
                        ],
                      },
                    }
                  : conflict,
            ];
      }
      return [completedResponse(`resp_${turn}`, [wireMessage(`msg_${turn}`, "Recovered.")])];
    });
    onTestFinished(() => server.close());
    const options = {
      apiKey: "synthetic-item-conflict-key",
      sessionId: `item-conflict-${transport}`,
      transport,
      replayResponsesItemIds: true,
      onPayload: (payload: unknown) => ({ ...(payload as object), store: true }),
    } satisfies Parameters<typeof streamOpenAIResponses>[2];
    const messages: Context["messages"] = [userMessage("Record one.")];
    const respond = async () => {
      const stream = await (
        mode === "provider" ? streamOpenAIResponses : createOpenAIResponsesTransportStreamFn()
      )(responsesLoopbackModel, { messages }, options);
      return stream.result();
    };
    const first = await respond();
    const tool = first.content.find((block) => block.type === "toolCall");
    expect(tool?.type).toBe("toolCall");
    if (tool?.type !== "toolCall") {
      throw new Error("Missing fixture tool call");
    }
    // Parsed arguments retain their meaning, but cold replay loses the provider's JSON bytes.
    expect(tool.arguments).toEqual({ n: 1 });
    messages.push(first, makeTextToolResult(tool.id, tool.name, "tool failed", true, 2));
    if (mode === "degenerate-abort") {
      const aborted = await respond();
      expect(aborted).toMatchObject({ stopReason: "error", errorCode: "degenerate_output" });
      messages.push(aborted, userMessage("Continue after the interruption.", 3));
    }
    cleanupSessionResources();
    const recovered = await respond();
    const repairIndex = mode === "degenerate-abort" ? 3 : 2;
    expect(recovered.stopReason).toBe("stop");
    expect(server.requests).toHaveLength(repairIndex + 1);
    expect(logInfo).toHaveBeenCalledWith(
      "openai-transport",
      expect.stringMatching(/item_conflict_recovery sessionHash=\S+ outcome=recovered/),
      undefined,
    );
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain(options.sessionId);
    expect(server.requests[repairIndex]).not.toHaveProperty("previous_response_id");
    const replay = server.requests[repairIndex]?.input as Array<Record<string, unknown>>;
    const replayCall = replay.find((item) => item.type === "function_call");
    expect(replayCall).toMatchObject({ name: "record_value", arguments: '{"n":1}' });
    expect(replayCall).not.toHaveProperty("id");
    expect(replayCall?.call_id).not.toBe(call.call_id);
    expect(replay.find((item) => item.type === "function_call_output")).toMatchObject({
      call_id: replayCall?.call_id,
      output: "tool failed",
    });
    messages.push(recovered, userMessage("Continue.", 3));
    // Model a process reload: retain only serialized transcript state.
    const serialized = JSON.stringify(messages);
    const reloaded: Context["messages"] = JSON.parse(serialized);
    messages.splice(0, messages.length, ...reloaded);
    cleanupSessionResources();
    expect((await respond()).stopReason).toBe("stop");
    expect(server.requests).toHaveLength(repairIndex + 2);
    const nextInput = server.requests[repairIndex + 1]?.input;
    assert(Array.isArray(nextInput));
    expect(nextInput.slice(0, replay.length)).toEqual(replay);
  },
);

it.each(["sse", "websocket-cached"] as const)(
  "stops after one failed self-heal over %s and records the outcome",
  async (transport) => {
    const host = getAiTransportHost();
    const logInfo = vi.fn();
    configureAiTransportHost({ logInfo });
    onTestFinished(() => configureAiTransportHost(host));
    const server = await createResponsesLoopbackServer(() => [conflict]);
    onTestFinished(() => server.close());
    const stream = await createOpenAIResponsesTransportStreamFn()(
      responsesLoopbackModel,
      { messages: [userMessage("Continue.")] },
      { apiKey: "synthetic-conflict-key", sessionId: "recovery-exhausted", transport },
    );
    const result = await stream.result();
    expect(result).toMatchObject({ stopReason: "error", errorCode: "item_conflict" });
    expect(server.requests).toHaveLength(2);
    expect(logInfo).toHaveBeenCalledWith(
      "openai-transport",
      expect.stringMatching(/item_conflict_recovery sessionHash=\S+ outcome=failed/),
      undefined,
    );
  },
);

it.each(["library", "gateway"])(
  "does not replay a degenerate aborted function item through %s",
  async (owner) => {
    const host = getAiTransportHost();
    if (owner === "gateway") {
      configureAiTransportHost({ transformTransportMessages });
      onTestFinished(() => configureAiTransportHost(host));
    }
    const call = wireCall("partial", "record_value");
    const server = await createResponsesLoopbackServer((turn) => {
      if (turn === 1) {
        return [
          outputItem("done", reasoning),
          outputItem("added", { ...call, arguments: "", status: "in_progress" }, 1),
          argumentDelta(call.id, " ".repeat(4096), 1),
        ];
      }
      const input = server.requests.at(-1)?.input as Array<Record<string, unknown>>;
      return input.some((item) => item.id === call.id || item.call_id === call.call_id)
        ? [conflict]
        : [completedResponse("resp_next", [wireMessage("msg_next", "Continued.")])];
    });
    onTestFinished(() => server.close());
    const messages: Context["messages"] = [userMessage("Record one.")];
    const respond = async () => {
      const stream = await createOpenAIResponsesTransportStreamFn()(
        responsesLoopbackModel,
        { messages },
        { apiKey: "synthetic-abort-key", transport: "sse" },
      );
      return stream.result();
    };
    const failed = await respond();
    expect(failed).toMatchObject({ stopReason: "error", errorCode: "degenerate_output" });
    messages.push(failed, userMessage("Continue.", 2));
    expect((await respond()).stopReason).toBe("stop");
    expect(server.requests).toHaveLength(2);
  },
);

it.each(
  (["sse", "websocket-cached"] as const).flatMap((transport) =>
    (["text", "function", "hosted-tool"] as const).map((output) => ({ transport, output })),
  ),
)(
  "defers a conflict after $output output over $transport without duplicating work",
  async ({ transport, output }) => {
    const host = getAiTransportHost();
    const logInfo = vi.fn();
    configureAiTransportHost({ logInfo });
    onTestFinished(() => configureAiTransportHost(host));
    const server = await createResponsesLoopbackServer((turn) => {
      if (turn === 1) {
        const saved = { ...wireMessage("msg_poisoned", "Original text."), phase: "final_answer" };
        return [
          outputItem("added", reasoning),
          outputItem("done", reasoning),
          completedResponse("resp_saved", [reasoning, saved]),
        ];
      }
      const input = server.requests.at(-1)?.input as Array<Record<string, unknown>>;
      if (input.some((item) => item.id === "msg_poisoned")) {
        if (output === "function") {
          return [outputItem("added", wireCall("partial", "record_value", "")), conflict];
        }
        if (output === "hosted-tool") {
          return [
            { type: "response.web_search_call.searching", item_id: "ws_active", output_index: 0 },
            conflict,
          ];
        }
        const partial = wireMessage("msg_partial", "");
        return [
          outputItem("added", partial),
          {
            type: "response.output_text.delta",
            item_id: partial.id,
            output_index: 0,
            content_index: 0,
            delta: "Already started.",
          },
          conflict,
        ];
      }
      return [completedResponse(`resp_${turn}`, [wireMessage(`msg_${turn}`, "Recovered.")])];
    });
    onTestFinished(() => server.close());
    const messages: Context["messages"] = [userMessage("Continue.")];
    const options = {
      apiKey: "synthetic-late-conflict-key",
      sessionId: "late-conflict",
      transport,
      replayResponsesItemIds: true,
    };
    const respond = async () => {
      const stream = await createOpenAIResponsesTransportStreamFn()(
        responsesLoopbackModel,
        { messages },
        options,
      );
      return stream.result();
    };
    const first = await respond();
    const text = first.content.find((block) => block.type === "text");
    if (!text) {
      throw new Error("Missing saved text");
    }
    text.text = "Edited old text.";
    messages.push(first, userMessage("Continue.", 2));
    const failed = await respond();
    expect(failed).toMatchObject({ stopReason: "error", errorCode: "item_conflict" });
    expect(server.requests).toHaveLength(2);
    expect(logInfo).toHaveBeenCalledWith(
      "openai-transport",
      expect.stringMatching(/item_conflict_recovery sessionHash=\S+ outcome=deferred/),
      undefined,
    );
    messages.push(failed, userMessage("Continue after the interruption.", 2));
    expect((await respond()).stopReason).toBe("stop");
    expect(server.requests).toHaveLength(3);
  },
);
