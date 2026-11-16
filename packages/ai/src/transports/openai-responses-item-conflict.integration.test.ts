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
  "sse-failed-snapshot",
  "http-error",
  "websocket-cached",
  "websocket-progress",
  "websocket-error-progress",
  "websocket-compaction",
  "websocket-failed-snapshot",
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
      // Model a rejected saved identity, not a fixed failure count.
      const input = server.requests.at(-1)?.input as Array<Record<string, unknown>>;
      if (input.some((item) => item.call_id === call.call_id)) {
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
                  : mode.endsWith("-failed-snapshot")
                    ? {
                        ...conflict,
                        response: {
                          ...conflict.response,
                          output: [reasoning, wireMessage("msg_rejected", "")],
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
    // Legacy transcripts have parsed arguments but no exact-byte replay signature.
    delete tool.argumentsSignature;
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

it.each([
  ['{ "n": 1 }', false, "same"],
  ['{"n":9007199254740993}', false, "same"],
  ['{ "n": 9007199254740993 }', true, "same"],
  ['{"n":9007199254740993}', false, "provider"],
  ['{"n":9007199254740993}', false, "api"],
  ['{"n":9007199254740993}', false, "model"],
] as const)(
  "retains completed tool argument bytes across a cold reopen: %s (streamed=%s, identity=%s)",
  async (argumentsText, streamed, identity) => {
    const host = getAiTransportHost();
    configureAiTransportHost({});
    onTestFinished(() => configureAiTransportHost(host));
    const call = wireCall("exact", "record_value", argumentsText);
    const server = await createResponsesLoopbackServer((turn) =>
      turn === 1
        ? [
            outputItem("added", reasoning),
            outputItem("done", reasoning),
            ...(streamed
              ? [
                  outputItem("added", { ...call, arguments: "", status: "in_progress" }, 1),
                  argumentDelta(call.id, argumentsText, 1),
                  outputItem("done", { ...call, arguments: '{"n":0}' }, 1),
                ]
              : []),
            completedResponse("resp_exact", [reasoning, call]),
          ]
        : [completedResponse("resp_next", [wireMessage("msg_next", "Continued.")])],
    );
    onTestFinished(() => server.close());
    const options = {
      apiKey: "synthetic-replay-key",
      sessionId: "exact-replay",
      transport: "sse",
      replayResponsesItemIds: true,
    } satisfies Parameters<typeof streamOpenAIResponses>[2];
    const messages: Context["messages"] = [userMessage("Record one.")];
    const respond = async () =>
      (
        await createOpenAIResponsesTransportStreamFn()(
          responsesLoopbackModel,
          { messages },
          options,
        )
      ).result();
    const first = await respond();
    const tool = first.content.find((block) => block.type === "toolCall");
    assert(tool);
    messages.push(first, makeTextToolResult(tool.id, tool.name, "recorded", false, 2));
    const storedTranscript = JSON.stringify(messages);
    const reloaded: Context["messages"] = JSON.parse(storedTranscript);
    messages.splice(0, messages.length, ...reloaded);
    const saved = messages[1];
    assert(saved?.role === "assistant");
    if (identity === "provider") {
      saved.provider = "other-responses-provider";
    }
    if (identity === "api") {
      saved.api = "openai-completions";
    }
    if (identity === "model") {
      saved.model = "other-model";
    }
    cleanupSessionResources();
    expect((await respond()).stopReason).toBe("stop");
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.previous_response_id).toBeUndefined();
    expect(server.requests[1]?.input).toContainEqual(
      expect.objectContaining({
        type: "function_call",
        arguments: identity === "same" ? argumentsText : '{"n":"9007199254740993"}',
      }),
    );
    // A real argument edit must not resurrect the original provider bytes.
    const edited = saved.content.find((block) => block.type === "toolCall");
    assert(edited);
    edited.arguments = { n: 2 };
    cleanupSessionResources();
    expect((await respond()).stopReason).toBe("stop");
    expect(server.requests[2]?.input).toContainEqual(
      expect.objectContaining({ type: "function_call", arguments: '{"n":2}' }),
    );
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
    configureAiTransportHost(owner === "gateway" ? { transformTransportMessages } : {});
    onTestFinished(() => configureAiTransportHost(host));
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
    (["text", "function", "hosted-tool", "function-snapshot", "hosted-tool-snapshot"] as const).map(
      (output) => ({ transport, output }),
    ),
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
      // The repair drops the rejected reasoning; stored IDs are no longer replayed.
      if (input.some((item) => item.encrypted_content === reasoning.encrypted_content)) {
        if (output.endsWith("-snapshot")) {
          return [
            {
              ...conflict,
              response: {
                ...conflict.response,
                output: [
                  output === "function-snapshot"
                    ? wireCall("partial", "record_value", "")
                    : { type: "web_search_call", id: "ws_active", status: "searching" },
                ],
              },
            },
          ];
        }
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

it.each(["sse", "websocket-cached"] as const)(
  "replays reasoning from an unstored response without a conflicting ID over %s",
  async (transport) => {
    const host = getAiTransportHost();
    configureAiTransportHost({});
    onTestFinished(() => configureAiTransportHost(host));
    // Real Responses behavior: stored output may be replayed by ID. Ciphertext from an
    // unstored response is recorded under its ID by the first stored replay; the next
    // stored replay then fails after output has streamed.
    const storedOutput = new Set<string>();
    const recorded = new Set<string>();
    const server = await createResponsesLoopbackServer((turn) => {
      const request = server.requests.at(-1);
      const input = request?.input;
      assert(Array.isArray(input));
      const ids = input.flatMap((item) =>
        item.encrypted_content && typeof item.id === "string" && !storedOutput.has(item.id)
          ? [item.id]
          : [],
      );
      // A stored message ID also requires its reasoning ID in the same input.
      const orphan = input.find(
        (item) => item.type === "message" && storedOutput.has(String(item.id)),
      );
      if (orphan && !input.some((item) => item.id === String(orphan.id).replace("msg_", "rs_"))) {
        return [{ type: "error", error: { message: "Missing required reasoning item." } }];
      }
      const conflicts = request?.store === true && ids.some((id) => recorded.has(id));
      const thought = { ...reasoning, id: `rs_${turn}` };
      const text = wireMessage(`msg_${turn}`, "Done.");
      if (request?.store === true) {
        ids.forEach((id) => recorded.add(id));
        storedOutput.add(thought.id).add(text.id);
      }
      return [
        outputItem("added", thought),
        outputItem("done", thought),
        outputItem("added", { ...text, content: [] }, 1),
        {
          type: "response.output_text.delta",
          item_id: text.id,
          output_index: 1,
          content_index: 0,
          delta: "Done.",
        },
        conflicts ? conflict : completedResponse(`resp_${turn}`, [thought, text]),
      ];
    });
    onTestFinished(() => server.close());
    const messages: Context["messages"] = [userMessage("Start.")];
    // A compacted or side request runs with store:false; later turns store again.
    const respond = async (store: boolean) => {
      cleanupSessionResources();
      const options = {
        apiKey: "synthetic-unstored-key",
        sessionId: `unstored-reasoning-${transport}`,
        transport,
        replayResponsesItemIds: true,
        onPayload: (payload: unknown) => ({ ...(payload as object), store }),
      } satisfies Parameters<typeof streamOpenAIResponses>[2];
      const result = await (
        await createOpenAIResponsesTransportStreamFn()(
          responsesLoopbackModel,
          { messages },
          options,
        )
      ).result();
      messages.push(result, userMessage("Continue.", messages.length + 1));
      return result;
    };
    await respond(false);
    for (const _ of [1, 2]) {
      expect(await respond(true)).toMatchObject({ stopReason: "stop" });
    }
    const last = server.requests.at(-1)?.input;
    assert(Array.isArray(last));
    const replayed = last.filter((item) => item.type === "reasoning");
    expect(replayed).toHaveLength(2);
    for (const item of replayed) {
      expect(item).toMatchObject({ encrypted_content: reasoning.encrypted_content });
      expect(item).not.toHaveProperty("id");
    }
  },
);
