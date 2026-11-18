import { readFileSync } from "node:fs";
import type { Context } from "@openclaw/llm-core";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { assert, expect, it, onTestFinished } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import { resolveResponsesContextUsageBoundary } from "./openai-responses-context-usage.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";
import {
  createResponsesLoopbackServer,
  responsesLoopbackModel,
} from "./openai-responses-loopback.test-support.js";
import { createCompactionContext } from "./openai-responses-prompt-observer.test-support.js";
import { supportsResponsesReasoningUpdate } from "./openai-responses-reasoning-update.js";
import {
  argumentDelta,
  completedResponse,
  outputItem,
  userMessage,
  wireCall,
  wireMessage,
} from "./openai-stream-cases.test-support.js";

it.each([
  ['{ "n": 1 }', false, "same"],
  ['{"n":9007199254740993}', false, "same"],
  ['{ "n": 9007199254740993 }', true, "same"],
  ['{"n":9007199254740993}', false, "provider"],
  ['{"n":9007199254740993}', false, "api"],
  ['{"n":9007199254740993}', false, "model"],
] as const)(
  "preserves original argument bytes without reviving edits: %s streamed=%s identity=%s",
  async (raw, streamed, identity) => {
    const host = getAiTransportHost();
    configureAiTransportHost({});
    onTestFinished(() => configureAiTransportHost(host));
    const call = wireCall("exact", "record_value", raw);
    const reasoning = {
      id: "rs_exact",
      type: "reasoning",
      summary: [],
      status: "completed",
      encrypted_content: "opaque-exact",
    };
    const server = await createResponsesLoopbackServer((turn) =>
      turn === 1
        ? [
            outputItem("added", reasoning),
            outputItem("done", reasoning),
            ...(streamed
              ? [
                  outputItem("added", { ...call, arguments: "", status: "in_progress" }, 1),
                  argumentDelta(call.id, raw, 1),
                  outputItem("done", { ...call, arguments: '{"n":0}' }, 1),
                ]
              : []),
            completedResponse("resp_exact", [reasoning, call]),
          ]
        : [completedResponse("resp_next", [wireMessage("msg_next", "Continued.")])],
    );
    onTestFinished(() => server.close());
    const messages: Context["messages"] = [userMessage("Record one.")];
    const respond = async () =>
      (
        await createOpenAIResponsesTransportStreamFn()(
          responsesLoopbackModel,
          { messages },
          { apiKey: "synthetic-byte-key", sessionId: "exact-byte", transport: "sse" },
        )
      ).result();
    const first = await respond();
    const tool = first.content.find((block) => block.type === "toolCall");
    assert(tool);
    messages.push(first, makeTextToolResult(tool.id, tool.name, "recorded", false, 2));
    // eslint-disable-next-line unicorn/prefer-structured-clone -- Exercise persisted transcript JSON, not an in-memory clone.
    const reloaded: Context["messages"] = JSON.parse(JSON.stringify(messages));
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
        arguments: identity === "same" ? raw : '{"n":"9007199254740993"}',
      }),
    );
    const edited = saved.content.find((block) => block.type === "toolCall");
    assert(edited);
    edited.arguments = { n: 2 };
    cleanupSessionResources();
    expect((await respond()).stopReason).toBe("stop");
    expect(server.requests).toHaveLength(3);
    expect(server.requests[2]?.input).toContainEqual(
      expect.objectContaining({ type: "function_call", arguments: '{"n":2}' }),
    );
  },
);

it.each(["reasoning", "usage"] as const)(
  "retains the %s fingerprint for exact-byte calls but rejects type edits",
  async (consumer) => {
    const host = getAiTransportHost();
    configureAiTransportHost({});
    onTestFinished(() => configureAiTransportHost(host));
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../../../extensions/openai/openclaw.plugin.json", import.meta.url),
        "utf8",
      ),
    );
    const catalog = normalizeModelCatalog(manifest.modelCatalog, {
      ownedProviders: new Set(["openai"]),
    });
    const modelEntry = catalog?.providers?.openai?.models.find((entry) =>
      supportsResponsesReasoningUpdate({
        model: entry.id,
        reasoning: { effort: "low" },
        input: [],
      }),
    );
    assert(modelEntry);
    const model = { ...responsesLoopbackModel, id: modelEntry.id, reasoning: true };
    const identity = { sessionId: "exact-byte-fingerprint" };
    const context: Context =
      consumer === "usage"
        ? createCompactionContext(model, identity)
        : { messages: [userMessage("Record one.")] };
    const call = wireCall("fingerprint", "record_value", '{ "n": 1 }');
    const server = await createResponsesLoopbackServer((turn) => [
      completedResponse(
        `resp_fingerprint_${turn}`,
        [turn === 1 ? call : wireMessage("msg_next", "Continued.")],
        { usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
      ),
    ]);
    onTestFinished(() => server.close());
    const respond = async (reasoningEffort: "low" | "high") => {
      const options = {
        apiKey: "synthetic-byte-key",
        ...identity,
        transport: "sse",
        reasoningEffort,
      } satisfies OpenAIResponsesOptions;
      return (await createOpenAIResponsesTransportStreamFn()(model, context, options)).result();
    };
    const first = await respond("low");
    const tool = first.content.find((block) => block.type === "toolCall");
    assert(tool);
    context.messages.push(first);
    if (consumer === "usage") {
      expect(
        resolveResponsesContextUsageBoundary(
          context.messages,
          model,
          identity,
          context.systemPrompt,
        ),
      ).toMatchObject({ totalTokens: 8 });
      tool.arguments = { n: "1" };
      expect(
        resolveResponsesContextUsageBoundary(
          context.messages,
          model,
          identity,
          context.systemPrompt,
        ),
      ).toBeUndefined();
      return;
    }
    context.messages.push(
      makeTextToolResult(tool.id, tool.name, "recorded", false, 2),
      userMessage("Continue.", 3),
    );
    cleanupSessionResources();
    expect((await respond("high")).stopReason).toBe("stop");
    expect(server.requests[1]).toMatchObject({ reasoning: { effort: "low" } });
    expect(server.requests[1]?.input).toContainEqual({
      type: "configuration_update",
      reasoning: { effort: "high" },
    });
    tool.arguments = { n: "1" };
    cleanupSessionResources();
    expect((await respond("high")).stopReason).toBe("stop");
    expect(server.requests[2]).toMatchObject({ reasoning: { effort: "high" } });
    expect(server.requests[2]?.input).not.toContainEqual(
      expect.objectContaining({ type: "configuration_update" }),
    );
  },
);
