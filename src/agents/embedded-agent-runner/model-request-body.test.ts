import { hash } from "node:crypto";
import { serializeModelRequestBody } from "@openclaw/ai/internal/openai";
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
    prompt_cache_key: "private-affinity",
    previous_response_id: "private-response",
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
    return new Response(sse, {
      headers: {
        "content-type": "text/event-stream",
        "openai-processing-ms": "12.5",
        "openai-model": "private-model",
        "openai-organization": "private-account",
        "x-openai-route": "private-route",
        "x-openai-region": "private-region",
        "x-request-id": "private-request",
        "set-cookie": "private-cookie",
      },
    });
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
      wire: {
        requestBytes: 614_400,
        prefixBytes: 4096,
        prefixHash: hash("sha256", Buffer.from(expectedWire).subarray(0, 4096)),
        cacheKeyPresent: true,
        cacheKeyHash: hash("sha256", '"private-affinity"').slice(0, 16),
        previousResponseIdPresent: true,
        modelHash: hash("sha256", JSON.stringify(model.id)).slice(0, 16),
        routeHash: hash("sha256", model.baseUrl).slice(0, 16),
        attempts: 1,
        retried: false,
        response: {
          status: 200,
          headers: {
            "openai-processing-ms": 12.5,
            "openai-model": hash("sha256", "private-model").slice(0, 16),
            "openai-organization": hash("sha256", "private-account").slice(0, 16),
            "x-openai-route": hash("sha256", "private-route").slice(0, 16),
            "x-openai-region": hash("sha256", "private-region").slice(0, 16),
            "x-request-id": hash("sha256", "private-request").slice(0, 16),
          },
        },
      },
      cachePrefix: {
        system: hash("sha256", "{}"),
        tools: hash("sha256", JSON.stringify({ tools: allowedTools })),
        messages: messages.map((message, index) => {
          const digest = hash("sha256", JSON.stringify(message));
          return index < 32
            ? {
                digest,
                fields: {
                  role: hash("sha256", JSON.stringify(message.role)),
                  content: hash("sha256", JSON.stringify(message.content)),
                },
              }
            : { digest };
        }),
        messageField: "messages",
        messageCount: 100,
        parameters: {
          digest: hash(
            "sha256",
            JSON.stringify({
              model: model.id,
              prompt_cache_key: "private-affinity",
              previous_response_id: "private-response",
              stream: true,
            }),
          ),
          fields: {
            model: hash("sha256", JSON.stringify(model.id)),
            prompt_cache_key: hash("sha256", '"private-affinity"'),
            previous_response_id: hash("sha256", '"private-response"'),
            stream: hash("sha256", "true"),
          },
        },
        continuation: true,
      },
    });
    expect(JSON.stringify(state)).not.toContain("private-");
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

it("observes serialized values without letting the observer change request bytes or stream behavior", () => {
  const toJSON = vi.fn(() => ({ stream: true, input: ["fixture"], omitted: undefined }));
  const observer = vi.fn((value: unknown) => {
    expect(value).toEqual({ stream: true, input: ["fixture"] });
    if (typeof value !== "object" || value === null) {
      throw new Error("Expected the serialized request object");
    }
    Object.assign(value, { stream: false, input: ["changed"] });
  });
  const encoded = serializeModelRequestBody({ toJSON }, observer);
  expect(observer).toHaveBeenCalledTimes(1);
  expect(toJSON).toHaveBeenCalledTimes(1);
  expect(new TextDecoder().decode(encoded.body)).toBe('{"stream":true,"input":["fixture"]}');
  expect(encoded.stream).toBe(true);
});

it("fingerprints serialized prompt segments with bounded, content-free history metadata", () => {
  const message = {
    role: "user",
    content: "private history content",
    ...Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`private-${index}`, index])),
  };
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
    messages: Array.from({ length: 512 }, (_, index) => ({
      digest: hash("sha256", JSON.stringify(message)),
      ...(index < 32
        ? {
            fields: {
              role: hash("sha256", '"user"'),
              content: hash("sha256", '"private history content"'),
              other: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          }
        : {}),
    })),
    messageField: "input",
    messageCount: 514,
    tail: hash("sha256", JSON.stringify([message, message])),
    parameters: {
      digest: hash("sha256", '{"private_parameter_name":"private parameter value"}'),
      fields: { other: expect.stringMatching(/^[a-f0-9]{64}$/) },
    },
    continuation: false,
  });
  expect(JSON.stringify(first.cachePrefix)).not.toContain("private");

  input[513] = { ...message, content: "changed private history" };
  const changed = prepareProviderPrompt({ payload, encode: true });
  expect(changed.cachePrefix?.messages).toEqual(first.cachePrefix?.messages);
  expect(changed.cachePrefix?.tail).not.toBe(first.cachePrefix?.tail);
  expect(prepareProviderPrompt({ payload: {}, encode: false }).cachePrefix).toBeUndefined();
});
