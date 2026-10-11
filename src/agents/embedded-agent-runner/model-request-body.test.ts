import { hash } from "node:crypto";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../../../packages/ai/src/host.js";
import { createOpenAICompletionsTransportStreamFn } from "../../../packages/ai/src/transports/openai-completions-transport.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { prepareProviderPrompt } from "./provider-prompt-serialization.js";
import {
  markLastProviderPromptContextRejected,
  wrapStreamFnWithProviderPromptState,
  type ProviderPromptState,
} from "./provider-prompt-state.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./run/attempt.model-diagnostic-events.js";

const originalHost = getAiTransportHost();
afterEach(() => {
  configureAiTransportHost(originalHost);
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
});

it("encodes the final large provider body off-thread and shares its exact bytes with diagnostics and retry admission", async () => {
  const model = makeProviderModelFixture<"openai-completions">({
    id: "fixture-model",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://provider.invalid/v1",
  });
  const allowedTools = ["exec", "wait"].map((name) => ({
    type: "function",
    function: { name, parameters: { type: "object", properties: {} } },
  }));
  const messages = Array.from({ length: 100 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [
      { type: "text", text: `${index}: " \\ \n 🦞\ud800 ${"x".repeat(4_000)}` },
      ...(index < 12 && index % 2 === 0
        ? [
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${"A".repeat(32_768)}` },
            },
          ]
        : []),
    ],
  }));
  const replacement = {
    model: model.id,
    messages,
    stream: true,
    tools: [...allowedTools, { type: "function", function: { name: "hidden" } }],
  };
  const expectedPayload = { ...replacement, tools: allowedTools };
  const padding = 600 * 1_024 - Buffer.byteLength(JSON.stringify(expectedPayload));
  const finalContent = messages[99]!.content[0]!;
  if (!("text" in finalContent)) {
    throw new Error("Expected the fixture's final text part");
  }
  finalContent.text += "x".repeat(padding);
  const expectedWire = JSON.stringify(expectedPayload);
  expect(Buffer.byteLength(expectedWire)).toBe(614_400);
  const sse = `data: ${JSON.stringify({
    id: "fixture-response",
    object: "chat.completion.chunk",
    created: 0,
    model: model.id,
    choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  })}\n\ndata: [DONE]\n\n`;
  let wire: string | undefined;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    wire = await new Request(input, init).text();
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  });
  configureAiTransportHost({ ...originalHost, buildModelFetch: () => fetchMock });
  const state: ProviderPromptState = {};
  const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
    wrapStreamFnWithProviderPromptState({
      streamFn: createOpenAICompletionsTransportStreamFn(),
      state,
      effectiveContextTokenBudget: 128_000,
    }),
    {
      runId: "encoded-body-fixture",
      provider: model.provider,
      model: model.id,
      api: model.api,
      trace: createDiagnosticTraceContext({}),
      nextCallId: () => "encoded-body-call",
      suppressPluginHooks: true,
    },
  );
  const context = {
    messages: [{ role: "user" as const, content: "replaced by the payload hook", timestamp: 0 }],
    tools: ["exec", "wait"].map((name) => ({
      name,
      description: name,
      parameters: Type.Object({}),
    })),
  };
  const options = {
    apiKey: "synthetic-fixture-key",
    openclawCodeModeToolSurface: true,
    onPayload: () => replacement,
  };
  const completed = createDeferred<DiagnosticEventPayload>();
  const unsubscribe = onInternalDiagnosticEvent((event) => {
    if (event.type === "model.call.completed" && event.runId === "encoded-body-fixture") {
      completed.resolve(event);
    }
  });
  const stringify = JSON.stringify;
  let mainThreadPayloadSerializations = 0;
  vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
    if (value === replacement) {
      mainThreadPayloadSerializations++;
    }
    return stringify(value, replacer, space);
  });
  try {
    const stream = await wrapped(model, context, options);
    for await (const event of stream) {
      // Completion diagnostics belong to the consumed transport stream.
      void event;
    }
    expect((await stream.result()).stopReason).toBe("stop");
    expect(wire).toBe(expectedWire);
    expect(mainThreadPayloadSerializations).toBe(0);
    expect(state.lastAttempt).toEqual({
      scopeDigest: expect.any(String),
      digest: hash("sha256", expectedWire),
      byteWeight: 614_400,
      cachePrefix: {
        system: hash("sha256", "{}"),
        tools: hash("sha256", JSON.stringify({ tools: allowedTools })),
        messages: messages.map((message) => hash("sha256", JSON.stringify(message))),
        messageCount: 100,
        parameters: hash("sha256", JSON.stringify(["messages", { model: model.id, stream: true }])),
      },
    });
    expect(await completed.promise).toMatchObject({ requestPayloadBytes: 614_400 });

    markLastProviderPromptContextRejected(state);
    const retry = await wrapped(model, context, options);
    expect(await retry.result()).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("byte-identical provider payload"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
});

it("fingerprints serialized prompt segments with bounded, content-free history metadata", () => {
  const message = { role: "user", content: "private history content" };
  const input = Array.from({ length: 514 }, () => message);
  let serializations = 0;
  const payload = {
    instructions: {
      toJSON() {
        serializations += 1;
        return "private instructions";
      },
    },
    tools: [{ type: "function", name: "private_tool_name" }],
    input,
    private_parameter_name: "private parameter value",
    omitted: undefined,
  };
  const first = prepareProviderPrompt({ payload, encode: true });
  expect(serializations).toBe(1);
  expect(first.cachePrefix).toEqual({
    system: hash("sha256", '{"instructions":"private instructions"}'),
    tools: hash("sha256", '{"tools":[{"type":"function","name":"private_tool_name"}]}'),
    messages: Array.from({ length: 512 }, () =>
      hash("sha256", '{"role":"user","content":"private history content"}'),
    ),
    messageCount: 514,
    tail: hash("sha256", JSON.stringify([message, message])),
    parameters: hash("sha256", '["input",{"private_parameter_name":"private parameter value"}]'),
  });
  expect(JSON.stringify(first.cachePrefix)).not.toContain("private");

  input[513] = { ...message, content: "changed private history" };
  const changed = prepareProviderPrompt({ payload, encode: true });
  expect(changed.cachePrefix?.messages).toEqual(first.cachePrefix?.messages);
  expect(changed.cachePrefix?.tail).not.toBe(first.cachePrefix?.tail);
  expect(prepareProviderPrompt({ payload: {}, encode: false }).cachePrefix).toBeUndefined();
});
