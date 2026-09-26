import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  stream as streamModel,
  type Model,
} from "openclaw/plugin-sdk/llm";
import {
  notifyProviderStreamOpened,
  withProviderAcceptanceObserver,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnthropicVertexStreamDeps } from "./stream-runtime.js";

function createStreamDeps() {
  const streamAnthropicMock = vi.fn(
    (..._args: Parameters<AnthropicVertexStreamDeps["streamAnthropic"]>) =>
      createAssistantMessageEventStream(),
  );
  const anthropicVertexCtorMock = vi.fn();
  const MockAnthropicVertex = function MockAnthropicVertex(options: unknown) {
    anthropicVertexCtorMock(options);
  } as unknown as AnthropicVertexStreamDeps["AnthropicVertex"];
  const googleAuthCtorMock = vi.fn();
  const googleAuthClient = {} as InstanceType<AnthropicVertexStreamDeps["GoogleAuth"]>;
  const MockGoogleAuth = function MockGoogleAuth(options: unknown) {
    googleAuthCtorMock(options);
    return googleAuthClient;
  } as unknown as AnthropicVertexStreamDeps["GoogleAuth"];

  return {
    deps: {
      AnthropicVertex: MockAnthropicVertex,
      GoogleAuth: MockGoogleAuth,
      streamAnthropic: streamAnthropicMock,
    },
    streamAnthropicMock,
    anthropicVertexCtorMock,
    googleAuthCtorMock,
    googleAuthClient,
  };
}

let createAnthropicVertexStreamFn: typeof import("./stream-runtime.js").createAnthropicVertexStreamFn;
let createAnthropicVertexStreamFnForModel: typeof import("./stream-runtime.js").createAnthropicVertexStreamFnForModel;

function makeModel(params: {
  id: string;
  maxTokens?: number;
  params?: Record<string, unknown>;
  reasoning?: boolean;
  thinkingLevelMap?: Model<"anthropic-messages">["thinkingLevelMap"];
}): Model<"anthropic-messages"> {
  return {
    id: params.id,
    api: "anthropic-messages",
    provider: "anthropic-vertex",
    reasoning: params.reasoning ?? true,
    ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
    ...(params.params ? { params: params.params } : {}),
    ...(params.thinkingLevelMap ? { thinkingLevelMap: params.thinkingLevelMap } : {}),
  } as Model<"anthropic-messages">;
}

type PayloadHook = (payload: unknown, payloadModel: unknown) => Promise<unknown>;

function streamTransportOptions(
  streamAnthropicMock: ReturnType<typeof vi.fn>,
): Record<string, unknown> {
  const options = streamAnthropicMock.mock.calls[0]?.[2];
  if (!options || typeof options !== "object") {
    throw new Error("Expected streamAnthropic transport options");
  }
  return options as Record<string, unknown>;
}

// Mirrors the shared anthropic-messages transport output: cache boundary already
// split (uncached dynamic suffix) and all four cache_control markers allocated.
function buildBudgetedTransportPayload() {
  return {
    system: [
      { type: "text", text: "Stable prefix", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Dynamic suffix" },
    ],
    tools: [
      { name: "exec", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "exec", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [],
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  };
}

function captureOptions(
  model: Model<"anthropic-messages">,
  options: Parameters<ReturnType<typeof createAnthropicVertexStreamFn>>[2] = {},
) {
  const { deps, streamAnthropicMock } = createStreamDeps();
  const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
  void streamFn(model, { messages: [] }, options);
  return streamTransportOptions(streamAnthropicMock);
}

async function capturePayload(
  modelOptions: Parameters<typeof makeModel>[0],
  options: Parameters<ReturnType<typeof createAnthropicVertexStreamFn>>[2],
) {
  const { deps } = createStreamDeps();
  const streamFn = createAnthropicVertexStreamFn(
    "vertex-project",
    "us-east5",
    undefined,
    { ...deps, streamAnthropic: streamModel },
    {},
  );
  const onPayload = vi.fn((_payload: unknown) => {
    throw new Error("stop before network");
  });
  const model: Model<"anthropic-messages"> = {
    ...makeModel(modelOptions),
    name: modelOptions.id,
    input: ["text"],
    contextWindow: 1_000_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const stream = await streamFn(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    { ...options, onPayload },
  );
  const result = await stream.result();
  expect(onPayload, result.errorMessage).toHaveBeenCalledOnce();
  return onPayload.mock.calls[0]?.[0];
}

describe("createAnthropicVertexStreamFn", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeAll(async () => {
    ({ createAnthropicVertexStreamFn, createAnthropicVertexStreamFnForModel } =
      await import("./stream-runtime.js"));
  });

  it("omits projectId when ADC credentials are used without an explicit project", () => {
    const { deps, anthropicVertexCtorMock, googleAuthClient } = createStreamDeps();
    createAnthropicVertexStreamFn(undefined, "global", undefined, deps);

    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      googleAuth: googleAuthClient,
      region: "global",
    });
  });

  it("passes bounded ADC credentials to google-auth-library", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-anthropic-vertex-stream-adc-"));
    const credentialsPath = path.join(tempDir, "application_default_credentials.json");
    const credentials = {
      type: "service_account",
      project_id: "vertex-project",
    };
    const json = JSON.stringify(credentials);
    const env = { GOOGLE_APPLICATION_CREDENTIALS: credentialsPath } as NodeJS.ProcessEnv;
    const { deps, googleAuthCtorMock } = createStreamDeps();
    try {
      writeFileSync(credentialsPath, `${json}${" ".repeat(1024 * 1024 - json.length)}`);
      createAnthropicVertexStreamFnForModel({}, env, deps);
      expect(googleAuthCtorMock).toHaveBeenCalledWith({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        credentials,
        clientOptions: {
          transporterOptions: { fetchImplementation: expect.any(Function) },
        },
      });

      writeFileSync(credentialsPath, `${json}${" ".repeat(1024 * 1024 + 1 - json.length)}`);
      expect(() => createAnthropicVertexStreamFnForModel({}, env, deps)).toThrowError(
        expect.objectContaining({
          name: "FsSafeError",
          code: "too-large",
          message: `Anthropic Vertex ADC credentials file at ${credentialsPath} exceeds 1048576 bytes.`,
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses provider-local proxy-aware fetch without mutating the global window", async () => {
    const { deps, anthropicVertexCtorMock, googleAuthCtorMock, googleAuthClient } =
      createStreamDeps();
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

    createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);

    expect(googleAuthCtorMock).toHaveBeenCalledWith({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      clientOptions: {
        transporterOptions: { fetchImplementation: expect.any(Function) },
      },
    });
    const authOptions = googleAuthCtorMock.mock.calls[0]?.[0] as
      | {
          clientOptions?: {
            transporterOptions?: { fetchImplementation?: typeof globalThis.fetch };
          };
        }
      | undefined;
    const fetchImplementation = authOptions?.clientOptions?.transporterOptions?.fetchImplementation;
    expect(fetchImplementation).not.toBe(globalThis.fetch);

    let proxyHit = false;
    const proxy = createServer((_request, response) => {
      proxyHit = true;
      response.end("proxied");
    });
    proxy.on("connect", (_request, socket) => {
      proxyHit = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nproxied");
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string" || !fetchImplementation) {
      proxy.close();
      throw new Error("Expected local proxy and Google auth fetch implementation");
    }
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("HTTP_PROXY", proxyUrl);
    vi.stubEnv("http_proxy", proxyUrl);
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    try {
      const response = await fetchImplementation("http://vertex-token.invalid/token", {
        agent: {},
      } as never);
      expect(await response.text()).toBe("proxied");
      expect(proxyHit).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      proxy.close();
      await once(proxy, "close");
    }
    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      googleAuth: googleAuthClient,
      projectId: "vertex-project",
      region: "us-east5",
    });
    expect(Object.getOwnPropertyDescriptor(globalThis, "window")).toEqual(windowDescriptor);
  });

  it("restores the canonical API before calling the shared Anthropic transport", () => {
    const { deps, streamAnthropicMock } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
    const model = {
      ...makeModel({ id: "claude-fable-5", maxTokens: 128000 }),
      api: "openclaw-anthropic-vertex-simple:default",
    };

    void streamFn(model as never, { messages: [] }, {});

    expect(streamAnthropicMock.mock.calls[0]?.[0]).toMatchObject({
      api: "anthropic-messages",
      provider: "anthropic-vertex",
      id: "claude-fable-5",
    });
  });

  it.each([
    ["defaults to the model limit instead of the old 32000 cap", 128000, undefined, 128000],
    ["clamps requests to the model limit", 128000, 999999, 128000],
    ["omits nonfinite limits", undefined, Number.NaN, undefined],
  ] as const)("maxTokens %s", (_name, limit, requested, expected) => {
    const options = captureOptions(makeModel({ id: "claude-sonnet-4-6", maxTokens: limit }), {
      maxTokens: requested,
    });
    if (expected === undefined) {
      expect(options).not.toHaveProperty("maxTokens");
    } else {
      expect(options.maxTokens).toBe(expected);
    }
  });

  it("omits unsupported temperature without adaptive thinking", () => {
    const options = captureOptions(makeModel({ id: "claude-opus-4-8" }), { temperature: 0.7 });
    expect(options).not.toHaveProperty("temperature");
  });

  it("preserves temperature for Vertex models that support custom sampling", () => {
    const model = makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 });

    const transportOptions = captureOptions(model, { temperature: 0.7 });

    expect(transportOptions.temperature).toBe(0.7);
  });

  it.each([
    {
      id: "production-fable",
      params: { canonicalModelId: "claude-fable-5-1" },
      reasoning: false,
      effort: "medium",
    },
    { id: "claude-mythos-5", effort: "high" },
  ])("sends the shared Vertex default for $id", async ({ effort, ...modelOptions }) => {
    const payload = await capturePayload(
      { ...modelOptions, maxTokens: 128000 },
      { temperature: 0.7 },
    );
    expect(payload).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort },
      max_tokens: 128000,
    });
    expect(payload).not.toHaveProperty("temperature");
  });

  it.each([
    { reasoning: undefined, thinkingEnabled: true, effort: "high" },
    { reasoning: "off" as const, thinkingEnabled: false, effort: undefined },
  ])(
    "supports Sonnet 5 reasoning=$reasoning on Vertex",
    ({ reasoning, thinkingEnabled, effort }) => {
      const model = makeModel({ id: "claude-sonnet-5", maxTokens: 128_000 });

      const options = captureOptions(model, { reasoning, temperature: 0.7 });
      expect(options).toMatchObject({ thinkingEnabled, maxTokens: 128_000 });
      expect(options).not.toHaveProperty("temperature");
      if (effort) {
        expect(options.effort).toBe(effort);
      } else {
        expect(options).not.toHaveProperty("effort");
      }
    },
  );

  it("uses canonical Claude policy for Vertex deployment aliases", () => {
    const model = makeModel({
      id: "production-claude",
      maxTokens: 128000,
      params: { canonicalModelId: "claude-opus-4-8" },
    });

    const transportOptions = captureOptions(model, { reasoning: "xhigh", temperature: 0.7 });

    expect(transportOptions).toMatchObject({
      thinkingEnabled: true,
      effort: "xhigh",
    });
    expect(transportOptions).not.toHaveProperty("temperature");
  });

  it.each([
    {
      name: "low thinking with the model output limit",
      options: { reasoning: "low" },
      thinking: { type: "enabled", budget_tokens: 2048 },
      maxTokens: 8192,
    },
    {
      name: "high thinking fitted below the model output limit",
      options: { reasoning: "high" },
      thinking: { type: "enabled", budget_tokens: 7168 },
      maxTokens: 8192,
    },
    {
      name: "low thinking alongside an explicit visible-output cap",
      options: { reasoning: "low", maxTokens: 1024 },
      thinking: { type: "enabled", budget_tokens: 2048 },
      maxTokens: 3072,
    },
    {
      name: "disabled sub-minimum thinking without inflating the output cap",
      options: { reasoning: "low", maxTokens: 1024, thinkingBudgets: { low: 512 } },
      thinking: { type: "disabled" },
      maxTokens: 1024,
    },
  ] as const)("sends $name on Vertex", async ({ options, thinking, maxTokens }) => {
    const payload = await capturePayload({ id: "claude-haiku-4-5", maxTokens: 8192 }, options);
    expect(payload).toMatchObject({ thinking, max_tokens: maxTokens });
  });

  it.each([
    ["claude-opus-4-6", "xhigh", "high"],
    ["claude-sonnet-4-6", "max", "max"],
  ] as const)("maps %s %s reasoning to %s effort", (id, reasoning, effort) => {
    expect(captureOptions(makeModel({ id, maxTokens: 128000 }), { reasoning })).toMatchObject({
      thinkingEnabled: true,
      effort,
    });
  });

  it("honors explicit max opt-outs for Vertex aliases", () => {
    const model = makeModel({
      id: "production-claude",
      params: { canonicalModelId: "claude-sonnet-4-6" },
      reasoning: false,
      thinkingLevelMap: { xhigh: null, max: null },
    });

    const transportOptions = captureOptions(model, { reasoning: "max", temperature: 0.2 });
    expect(transportOptions.effort).toBe("high");
    expect(transportOptions).not.toHaveProperty("temperature");
  });

  it("forwards the private acceptance observer to the shared Anthropic transport", async () => {
    const acceptanceObserver = vi.fn();
    const onResponse = vi.fn();
    const options = withProviderAcceptanceObserver({ onResponse }, acceptanceObserver);

    const transportOptions = captureOptions(makeModel({ id: "claude-sonnet-4-6" }), options);
    expect(transportOptions.onResponse).toBe(onResponse);
    await notifyProviderStreamOpened({ options: transportOptions, cancelStream: vi.fn() });
    expect(acceptanceObserver).toHaveBeenCalledWith({ kind: "provider_stream_opened" });
  });

  it("keeps already-budgeted cache_control markers intact when forwarding payload hooks", async () => {
    const onPayload = vi.fn(async (payload: unknown) => payload);
    const model = makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 });
    const transportPayloadHook = captureOptions(model, { cacheRetention: "short", onPayload })
      .onPayload as PayloadHook | undefined;
    const payload = buildBudgetedTransportPayload();
    const expectedPayload = structuredClone(payload);

    const nextPayload = await transportPayloadHook?.(payload, model);

    expect(onPayload).toHaveBeenCalledWith(payload, model);
    expect(nextPayload).toEqual(expectedPayload);
  });
});

describe("createAnthropicVertexStreamFnForModel", () => {
  it.each([
    [
      "https://aiplatform.us.rep.googleapis.com",
      "us",
      "https://aiplatform.us.rep.googleapis.com/v1",
    ],
    [
      "https://aiplatform.eu.rep.googleapis.com",
      "eu",
      "https://aiplatform.eu.rep.googleapis.com/v1",
    ],
    [
      "https://europe-west4-aiplatform.googleapis.com",
      "europe-west4",
      "https://europe-west4-aiplatform.googleapis.com/v1",
    ],
    [
      "https://proxy.example.test/custom-root/v1",
      "global",
      "https://proxy.example.test/custom-root/v1",
    ],
    [
      "https://proxy.example.test/custom-root",
      "global",
      "https://proxy.example.test/custom-root/v1",
    ],
  ])("derives the SDK region and versioned endpoint from %s", (baseUrl, region, expected) => {
    const { deps, anthropicVertexCtorMock, googleAuthClient } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl },
      { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" },
      deps,
    );
    void streamFn(makeModel({ id: "claude-sonnet-5", maxTokens: 128_000 }), { messages: [] }, {});
    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      googleAuth: googleAuthClient,
      projectId: "vertex-project",
      region,
      baseURL: expected,
    });
  });
});
