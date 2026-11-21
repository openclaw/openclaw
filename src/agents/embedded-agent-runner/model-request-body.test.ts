import crypto, { hash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { serialize } from "node:v8";
import { serializeModelRequestBody } from "@openclaw/ai/internal/shared";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, assert, expect, it, vi } from "vitest";
import { buildGoogleProvider } from "../../../extensions/google/api.js";
import { configureAiTransportHost, getAiTransportHost } from "../../../packages/ai/src/host.js";
import {
  modelRequestBodyState,
  prepareModelRequestBody,
  encodedModelRequestBodyStream,
} from "../../../packages/ai/src/transports/model-request-body.js";
import { createOpenAICompletionsTransportStreamFn } from "../../../packages/ai/src/transports/openai-completions-transport.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { withServer } from "../../plugin-sdk/test-env.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { prepareProviderPrompt } from "./provider-prompt-serialization.js";
import {
  markLastProviderPromptContextRejected,
  wrapStreamFnWithProviderPromptState,
  type ProviderPromptState,
} from "./provider-prompt-state.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./run/attempt.model-diagnostic-events.js";

const originalHost = getAiTransportHost();
const digest = (value: unknown) => hash("sha256", JSON.stringify(value));
afterEach(() => {
  configureAiTransportHost(originalHost);
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { name: "changed final generation settings", changeSettings: true },
  { name: "a token hidden from final policy", omitToken: true },
  { name: "abort after final policy", abortPolicy: true },
  { name: "the final UTF-8 size after token insertion", oversizeReplay: true },
  ...["continuationToken", "continuation_token"].flatMap((injectedKey) =>
    [undefined, null, "synthetic-injected-token"].map((injectedValue) => ({
      name: `policy-injected ${injectedKey}=${String(injectedValue)}`,
      injectedKey,
      injectedValue,
    })),
  ),
])(
  "binds registered Google continuation to $name and records actual wire bytes",
  async (testCase) => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    const token = "synthetic-receipt-🦞";
    const wires: string[] = [];
    const state: ProviderPromptState = {};
    const controller = new AbortController();
    let temperature = 0.25;
    const policy = vi.fn(async (payload: unknown) => {
      assert(payload && typeof payload === "object" && !Array.isArray(payload));
      const replacement: Record<string, unknown> = {
        ...payload,
        generationConfig: { temperature },
      };
      if ("omitToken" in testCase) {
        delete replacement.continuationToken;
      }
      if ("injectedKey" in testCase) {
        replacement[testCase.injectedKey] = testCase.injectedValue;
      }
      if ("oversizeReplay" in testCase) {
        replacement.contents = [];
        const prefix = JSON.stringify(replacement);
        const bytes =
          20_000_000 -
          10 -
          Buffer.byteLength(prefix) -
          Buffer.byteLength('{"role":"user","parts":[{"text":""}]}');
        replacement.contents = [
          {
            role: "user",
            parts: [{ text: "é".repeat(Math.floor(bytes / 2)) + "x".repeat(bytes % 2) }],
          },
        ];
        expect(Buffer.byteLength(JSON.stringify(replacement))).toBe(20_000_000 - 10);
      }
      if ("abortPolicy" in testCase) {
        controller.abort(false);
      }
      return replacement;
    });
    await withServer(
      async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        wires.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            candidates: [
              {
                finishReason: "CONTINUATION",
                continuationToken: token,
                content: { parts: [{ text: "partial response" }] },
              },
            ],
          })}\n\n`,
        );
      },
      async (origin) => {
        const model = makeProviderModelFixture<"google-generative-ai">({
          id: "gemini-3.5-flash",
          provider: "clawrouter",
          api: "google-generative-ai",
          baseUrl: `${origin}/v1/native/google-gemini/v1beta`,
        });
        const registered = buildGoogleProvider().createStreamFn?.({
          provider: model.provider,
          modelId: model.id,
          model,
        });
        assert(registered);
        const streamFn = wrapStreamFnWithProviderPromptState({
          streamFn: registered,
          state,
          effectiveContextTokenBudget: 128_000,
          transformPayload: policy,
        });
        const observedBytes: number[] = [];
        const invoke = async (googleContinuation?: AssistantMessage["providerReplay"]) => {
          const options = {
            apiKey: "synthetic-router-key",
            headers: { Authorization: "Bearer synthetic-router-key" },
            googleContinuation,
            signal: controller.signal,
          };
          modelRequestBodyState(options).onBytes = (bytes) => observedBytes.push(bytes);
          const stream = await streamFn(
            model,
            {
              messages: [{ role: "user", content: "synthetic request", timestamp: 0 }],
            },
            options,
          );
          return stream.result();
        };
        const first = await invoke();
        if ("injectedKey" in testCase || "abortPolicy" in testCase) {
          expect(first.providerReplay).toBeUndefined();
          expect(first.stopReason).toBe("abortPolicy" in testCase ? "aborted" : "error");
          expect(wires).toEqual([]);
          expect(observedBytes).toEqual([]);
          expect(policy).toHaveBeenCalledTimes(1);
          if ("abortPolicy" in testCase) {
            expect(controller.signal.reason).toBe(false);
          }
          return;
        }
        expect(first.providerReplay?.id).toBe(token);
        const replay = await invoke(first.providerReplay);
        if ("oversizeReplay" in testCase) {
          expect(replay.stopReason).toBe("error");
          expect(replay.errorMessage).toContain(
            "Google request body must be smaller than 20000000 bytes",
          );
          expect(replay.providerReplay).toBeUndefined();
          expect(wires).toHaveLength(1);
          expect(observedBytes).toEqual([20_000_000 - 10]);
          expect(policy).toHaveBeenCalledTimes(2);
          return;
        }
        expect(replay.providerReplay?.id).toBe(token);
        expect(wires).toHaveLength(2);
        expect(JSON.parse(wires[1]!)).toMatchObject({
          generationConfig: { temperature: 0.25 },
          continuationToken: token,
        });
        expect(state.lastAttempt).toMatchObject({
          digest: hash("sha256", wires[1]!),
          byteWeight: Buffer.byteLength(wires[1]!),
          wire: { requestBytes: Buffer.byteLength(wires[1]!) },
        });
        expect(observedBytes).toEqual(wires.map((wire) => Buffer.byteLength(wire)));
        expect(policy).toHaveBeenCalledTimes(2);
        if ("changeSettings" in testCase) {
          temperature = 0.75;
          const rejected = await invoke(first.providerReplay);
          expect(rejected.stopReason).toBe("error");
          expect(rejected.providerReplay).toBeUndefined();
          expect(wires).toHaveLength(2);
          expect(policy).toHaveBeenCalledTimes(3);
        }
      },
    );
  },
);

it.each([0, 2])("rejects an encoder that applies its finalizer %i times", async (count) => {
  const options = {};
  const finalize = vi.fn((payload: unknown) => payload);
  const onBytes = vi.fn();
  const state = modelRequestBodyState(options);
  state.onBytes = onBytes;
  state.encode = async (payload, finalizer) => {
    for (let i = 0; i < count; i++) {
      try {
        finalizer?.(payload);
      } catch {
        // Even an encoder swallowing the second-call error cannot publish bytes.
      }
    }
    return serializeModelRequestBody(payload);
  };
  await expect(
    prepareModelRequestBody(options, finalize)({ input: "synthetic" }),
  ).rejects.toThrow();
  expect(finalize).toHaveBeenCalledTimes(count === 0 ? 0 : 1);
  expect(onBytes).not.toHaveBeenCalled();
});

it.each([undefined, Object.freeze({ failure: "synthetic-finalizer" })])(
  "rejects an encoder swallowing finalizer failure %s",
  async (reason) => {
    const options = {};
    const onBytes = vi.fn();
    const state = modelRequestBodyState(options);
    state.onBytes = onBytes;
    state.encode = async (payload, finalizer) => {
      try {
        finalizer?.(payload);
      } catch {
        // A returned body cannot erase the finalizer's original failure.
      }
      return serializeModelRequestBody(payload);
    };
    await expect(
      prepareModelRequestBody(options, () => {
        throw reason;
      })({}),
    ).rejects.toBe(reason);
    expect(onBytes).not.toHaveBeenCalled();
  },
);

it.each([undefined, null, false, 0])(
  "preserves a finalizer's raw rejected reason %s",
  async (reason) => {
    const options = {};
    const onBytes = vi.fn();
    modelRequestBodyState(options).onBytes = onBytes;
    await expect(
      prepareModelRequestBody(options, () => {
        throw reason;
      })({}),
    ).rejects.toBe(reason);
    expect(onBytes).not.toHaveBeenCalled();
  },
);

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
  const messages = [{ role: "user", content: '" \\ \n 🦞\ud800' }];
  const parameters = {
    model: model.id,
    prompt_cache_key: "private-affinity",
    previous_response_id: "private-response",
    stream: true,
  };
  const replacement = {
    ...parameters,
    messages,
    tools: [...allowedTools, { type: "function", function: { name: "hidden" } }],
  };
  const expectedPayload = { ...replacement, tools: allowedTools };
  const padding = 600 * 1_024 - Buffer.byteLength(JSON.stringify(expectedPayload));
  messages[0]!.content += "x".repeat(padding);
  const expectedWire = JSON.stringify(expectedPayload);
  expect(Buffer.byteLength(expectedWire)).toBe(614_400);
  const sse =
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
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
        modelHash: digest(model.id).slice(0, 16),
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
      cachePrefix: expect.objectContaining({
        messageField: "messages",
        messageCount: messages.length,
        continuation: true,
      }),
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

it("reuses the owned encoding for native Fetch replay without another body copy", async () => {
  const payload = { stream: true, input: ["Synthetic 🦞"] };
  const encoded = serializeModelRequestBody(payload);
  const options = {};
  const encode = vi.fn(async () => encoded);
  const onBytes = vi.fn();
  Object.assign(modelRequestBodyState(options), { encode, onBytes });
  const prepared = await prepareModelRequestBody(options)(payload);
  expect(prepared.body).toBe(encoded.body);
  expect(encodedModelRequestBodyStream(prepared.body)).toBe(true);
  expect(onBytes).toHaveBeenCalledWith(encoded.body.byteLength);
  payload.input[0] = "changed after encoding";
  const first = new Request("https://provider.invalid", { method: "POST", ...prepared });
  const consumed = new Uint8Array(await first.arrayBuffer());
  expect(new TextDecoder().decode(consumed)).toBe('{"stream":true,"input":["Synthetic 🦞"]}');
  consumed.fill(0);
  const replay = new Request("https://provider.invalid", { method: "POST", ...prepared });
  expect(await replay.text()).toBe('{"stream":true,"input":["Synthetic 🦞"]}');
  expect(encode).toHaveBeenCalledTimes(1);
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

it.each([
  [undefined, "", false],
  [null, "null", false],
  [[{ stream: true }], '[{"stream":true}]', false],
  [
    { input: ['"\\', { nested: [false, null, 123] }], stream: true },
    '{"input":["\\\"\\\\",{"nested":[false,null,123]}],"stream":true}',
    true,
  ],
  [
    { 'quoted"key': { stream: true }, stream: "true" },
    '{"quoted\\\"key":{"stream":true},"stream":"true"}',
    false,
  ],
])("preserves wire bytes and top-level stream for %j", (payload, wire, stream) => {
  const encoded = serializeModelRequestBody(payload);
  expect(new TextDecoder().decode(encoded.body)).toBe(wire);
  expect(encoded.stream).toBe(stream);
});

it("fingerprints serialized prompt segments with bounded, content-free history metadata", () => {
  const message = {
    role: "user",
    content: 'private history content " \\ \\\" 🦞\ud800',
    'private-"\\key': { nested: [false, null, [123, "[,]:{}"]] },
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
    messageDigests: hash("sha256", JSON.stringify(message), "latin1").repeat(512),
    messageFields: Array.from({ length: 32 }, () => ({
      role: hash("sha256", '"user"'),
      content: hash("sha256", JSON.stringify(message.content)),
      other: expect.stringMatching(/^[a-f0-9]{64}$/),
    })),
    messageField: "input",
    messageCount: 514,
    tail: hash("sha256", JSON.stringify([message, message])),
    parameters: {
      digest: hash("sha256", '{"private_parameter_name":"private parameter value"}', "latin1"),
      fields: { other: expect.stringMatching(/^[a-f0-9]{64}$/) },
    },
    continuation: false,
  });
  expect(JSON.stringify(first.cachePrefix)).not.toContain("private");
  expect(serialize(first.cachePrefix).byteLength).toBeLessThan(32 * 1024);

  input[513] = { ...message, content: "changed private history" };
  const changed = prepareProviderPrompt({ payload, encode: true });
  expect(changed.cachePrefix?.messageDigests).toEqual(first.cachePrefix?.messageDigests);
  expect(changed.cachePrefix?.tail).not.toBe(first.cachePrefix?.tail);
  expect(prepareProviderPrompt({ payload: {}, encode: false }).cachePrefix).toBeUndefined();
});

it("hashes prompt prefixes without assembling copies of their serialized fields", () => {
  const payload = {
    system: "synthetic system 🦞".repeat(4_000),
    tools: [{ name: "synthetic_tool", description: "synthetic tool ".repeat(8_000) }],
    instructions: "synthetic instructions ".repeat(4_000),
    input: [],
  };
  const system = JSON.stringify({ instructions: payload.instructions, system: payload.system });
  const tools = JSON.stringify({ tools: payload.tools });
  const expected = { system: hash("sha256", system), tools: hash("sha256", tools) };
  const spy = vi.spyOn(crypto, "hash").mockClear();
  syncBuiltinESMExports();
  try {
    const result = prepareProviderPrompt({ payload, encode: true });
    expect(result.cachePrefix).toMatchObject(expected);
    expect(new TextDecoder().decode(result.encoded!.body)).toBe(JSON.stringify(payload));
    expect(spy.mock.calls.some(([, data]) => data === system || data === tools)).toBe(false);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});
