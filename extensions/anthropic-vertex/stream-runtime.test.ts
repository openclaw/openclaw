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

const expectedGoogleAuth = {
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  clientOptions: { transporterOptions: { fetchImplementation: expect.any(Function) } },
};

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

function makeModel(
  overrides: Pick<Model<"anthropic-messages">, "id"> & Partial<Model<"anthropic-messages">>,
): Model<"anthropic-messages"> {
  return {
    name: overrides.id,
    api: "anthropic-messages",
    provider: "anthropic-vertex",
    baseUrl: "https://us-east5-aiplatform.googleapis.com",
    reasoning: true,
    maxTokens: 128_000,
    contextWindow: 1_000_000,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

type PayloadHook = (payload: unknown, payloadModel: unknown) => Promise<unknown>;
type StreamOptions = Parameters<ReturnType<typeof createAnthropicVertexStreamFn>>[2];
type ModelOptions = Parameters<typeof makeModel>[0];

function captureOptions(model: Model<"anthropic-messages">, options: StreamOptions = {}) {
  const { deps, streamAnthropicMock } = createStreamDeps();
  const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps);
  void streamFn(model, { messages: [] }, options);
  const captured = streamAnthropicMock.mock.calls[0]?.[2];
  if (!captured || typeof captured !== "object") {
    throw new Error("Expected streamAnthropic transport options");
  }
  return captured as Record<string, unknown>;
}

async function capturePayload(modelOptions: ModelOptions | string, options: StreamOptions) {
  const deps = { ...createStreamDeps().deps, streamAnthropic: streamModel };
  const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps, {});
  const onPayload = vi.fn((_payload: unknown) => {
    throw new Error("stop before network");
  });
  const model = makeModel(typeof modelOptions === "string" ? { id: modelOptions } : modelOptions);
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
  beforeEach(() => vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined));
  afterEach(() => vi.unstubAllEnvs());

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
    const credentials = { type: "service_account", project_id: "vertex-project" };
    const json = JSON.stringify(credentials);
    const env = { GOOGLE_APPLICATION_CREDENTIALS: credentialsPath } as NodeJS.ProcessEnv;
    const { deps, googleAuthCtorMock } = createStreamDeps();
    try {
      writeFileSync(credentialsPath, `${json}${" ".repeat(1024 * 1024 - json.length)}`);
      createAnthropicVertexStreamFnForModel({}, env, deps);
      expect(googleAuthCtorMock).toHaveBeenCalledWith({ ...expectedGoogleAuth, credentials });

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

    expect(googleAuthCtorMock).toHaveBeenCalledWith(expectedGoogleAuth);
    const authOptions = googleAuthCtorMock.mock.calls[0]?.[0] as ConstructorParameters<
      AnthropicVertexStreamDeps["GoogleAuth"]
    >[0];
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
      ...makeModel({ id: "claude-fable-5" }),
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
    ["floors fractional requested limits", 128000, 4096.75, 4096],
  ] as const)("maxTokens %s", (_name, limit, requested, expected) => {
    const options = captureOptions(makeModel({ id: "claude-sonnet-4-6", maxTokens: limit }), {
      maxTokens: requested,
    });
    expect(options.maxTokens).toBe(expected);
  });

  it("omits unsupported temperature without adaptive thinking", async () => {
    const payload = await capturePayload({ id: "claude-opus-4-8" }, { temperature: 0.7 });
    expect(payload).not.toHaveProperty("temperature");
  });

  it("preserves temperature for Vertex models that support custom sampling", async () => {
    const payload = await capturePayload({ id: "claude-sonnet-4-6" }, { temperature: 0.7 });
    expect(payload).toHaveProperty("temperature", 0.7);
  });

  it.each([
    [
      "Fable alias default",
      {
        id: "production-fable",
        params: { canonicalModelId: "claude-fable-5-1" },
        reasoning: false,
      },
      undefined,
      "medium",
    ],
    ["Mythos default", "claude-mythos-5", undefined, "high"],
    ["Sonnet default", "claude-sonnet-5", undefined, "high"],
    ["Sonnet off", "claude-sonnet-5", "off", undefined],
    [
      "Opus alias xhigh",
      { id: "production-claude", params: { canonicalModelId: "claude-opus-4-8" } },
      "xhigh",
      "xhigh",
    ],
    ["Haiku default", "claude-haiku-5-5", undefined, undefined],
    ["Haiku off", "claude-haiku-5-5", "off", undefined],
    ["Haiku high", "claude-haiku-5-5", "high", "high"],
  ] as const)(
    "%s uses the Vertex adaptive thinking policy",
    async (_name, model, reasoning, effort) => {
      const payload = await capturePayload(model, { reasoning, temperature: 0.7 });
      expect(payload).toMatchObject({
        thinking: { type: effort ? "adaptive" : "disabled" },
        max_tokens: 128_000,
      });
      expect(payload).not.toHaveProperty("temperature");
      if (effort) {
        expect(payload).toHaveProperty("output_config.effort", effort);
      } else {
        expect(payload).not.toHaveProperty("output_config");
      }
    },
  );

  it.each([
    ["low", undefined, undefined, 2048, 8192, 8192],
    ["high", undefined, undefined, 7168, 8192, 8192],
    ["low", 1024, undefined, 2048, 3072, 8192],
    ["low", 1024, { low: 512 }, undefined, 1024, 8192],
    ["max", 1024, { high: 512 }, 32768, 33792, 64000],
  ] as const)(
    "fits manual %s thinking to output caps",
    async (reasoning, maxTokens, thinkingBudgets, budget, output, limit) => {
      const payload = await capturePayload(
        { id: "claude-haiku-4-5", maxTokens: limit },
        { reasoning, maxTokens, thinkingBudgets },
      );
      expect(payload).toMatchObject({
        thinking:
          budget === undefined ? { type: "disabled" } : { type: "enabled", budget_tokens: budget },
        max_tokens: output,
      });
    },
  );

  it("keeps listed capability overrides authoritative for Vertex manual thinking", async () => {
    const payload = await capturePayload(
      {
        id: "claude-sonnet-5",
        params: { claudeCapabilities: { adaptiveThinking: false } },
      },
      { reasoning: "high" },
    );
    expect(payload).toMatchObject({ thinking: { type: "enabled", budget_tokens: 16_384 } });
    expect(payload).not.toHaveProperty("output_config");
  });

  it("honors explicit max opt-outs for Vertex aliases", async () => {
    const payload = await capturePayload(
      {
        id: "production-claude",
        params: { canonicalModelId: "claude-sonnet-4-6" },
        reasoning: false,
        thinkingLevelMap: { xhigh: null, max: null },
      },
      { reasoning: "max", temperature: 0.2 },
    );
    expect(payload).toHaveProperty("output_config.effort", "high");
    expect(payload).not.toHaveProperty("temperature");
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
    // Four cache markers, with the dynamic system suffix deliberately uncached.
    const cached = <T extends object>(block: T) => ({
      ...block,
      cache_control: { type: "ephemeral" },
    });
    const payload = {
      system: [
        cached({ type: "text", text: "Stable prefix" }),
        { type: "text", text: "Dynamic suffix" },
      ],
      tools: [cached({ name: "exec", input_schema: { type: "object" } })],
      messages: [
        {
          role: "user",
          content: [cached({ type: "text", text: "Hello" })],
        },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "exec", input: {} }] },
        {
          role: "user",
          content: [cached({ type: "tool_result", tool_use_id: "t1", content: [] })],
        },
      ],
    };
    const expectedPayload = structuredClone(payload);

    const nextPayload = await transportPayloadHook?.(payload, model);

    expect(onPayload).toHaveBeenCalledWith(payload, model);
    expect(nextPayload).toEqual(expectedPayload);
  });
});

describe("createAnthropicVertexStreamFnForModel", () => {
  it.each([
    ["https://aiplatform.us.rep.googleapis.com", "us", "/v1"],
    ["https://aiplatform.eu.rep.googleapis.com", "eu", "/v1"],
    ["https://europe-west4-aiplatform.googleapis.com", "europe-west4", "/v1"],
    ["https://proxy.example.test/custom-root/v1", "global", ""],
    ["https://proxy.example.test/custom-root", "global", "/v1"],
  ])("derives the SDK region and versioned endpoint from %s", (baseUrl, region, suffix) => {
    const { deps, anthropicVertexCtorMock, googleAuthClient } = createStreamDeps();
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl },
      { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" },
      deps,
    );
    void streamFn(makeModel({ id: "claude-sonnet-5" }), { messages: [] }, {});
    expect(anthropicVertexCtorMock).toHaveBeenCalledWith({
      googleAuth: googleAuthClient,
      projectId: "vertex-project",
      region,
      baseURL: `${baseUrl}${suffix}`,
    });
  });
});
