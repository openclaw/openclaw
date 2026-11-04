import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { createEmptyTransportUsage } from "openclaw/plugin-sdk/provider-stream-shared";
import * as ssrf from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, expect, it, vi } from "vitest";
import eventFixture from "./fixtures/converse-eventstream.json" with { type: "json" };
import clawrouter from "./index.js";
import { buildClawRouterProviderConfig } from "./provider-catalog.js";

const ROOT = "https://router.example";
const KEY = "synthetic-proxy-key";
const UPSTREAM = "amazon.nova-lite-v1:0";
const ID = "aws-bedrock/" + UPSTREAM;
const wire = Buffer.from(eventFixture.base64, "base64");
const cfg: OpenClawConfig = {
  models: {
    providers: {
      clawrouter: {
        baseUrl: ROOT + "/v1",
        apiKey: KEY,
        models: [],
      },
    },
  },
};
const context: Context = {
  systemPrompt: "fixture system",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "fixture prompt" },
        { type: "image", data: "AQID", mimeType: "image/png" },
      ],
      timestamp: 0,
    },
  ],
  tools: [
    {
      name: "inspect",
      description: "Inspect a value",
      parameters: { type: "object", properties: { value: { type: "number" } } },
    },
  ],
};

context.messages.push(
  {
    role: "assistant",
    api: "bedrock-converse-stream",
    provider: "clawrouter",
    model: ID,
    content: [
      { type: "toolCall", id: "call|a", name: "inspect", arguments: { value: 1 } },
      { type: "toolCall", id: "call|b", name: "inspect", arguments: { value: 2 } },
    ],
    usage: createEmptyTransportUsage(),
    stopReason: "toolUse",
    timestamp: 0,
  },
  {
    role: "toolResult",
    toolCallId: "call|a",
    toolName: "inspect",
    content: [{ type: "text", text: "first result" }],
    isError: false,
    timestamp: 0,
  },
  {
    role: "toolResult",
    toolCallId: "call|b",
    toolName: "inspect",
    content: [{ type: "text", text: "second result" }],
    isError: false,
    timestamp: 0,
  },
);

function catalog(kind: "native" | "manifest") {
  return {
    version: "clawrouter.client-catalog.v1",
    observedAt: new Date().toISOString(),
    scope: { authType: "proxy_key", credentialId: "fixture-grant" },
    providers: [
      {
        id: "aws-bedrock",
        displayName: "Bedrock",
        allowed: true,
        executable: true,
        openaiCompatible: false,
        nativeBaseUrl: "/v1/native/aws-bedrock",
        routes: [
          {
            endpoint: "converse_stream",
            path: "/model/${model}/converse-stream",
            methods: ["POST"],
            requestFormat: "aws_bedrock.converse_stream",
            responseFormat: "aws_bedrock.converse_eventstream",
          },
        ],
        models: [
          {
            id: ID,
            upstream: UPSTREAM,
            input: ["text", "image"],
            capabilities: ["llm.chat"],
            pricing: {
              inputMicrosPerMillion: 10,
              outputMicrosPerMillion: 20,
              maxInputTokens: 128000,
              defaultMaxOutputTokens: 100,
            },
          },
        ],
        offers: [
          {
            endpoint: "converse_stream",
            modelId: ID,
            transport: "http",
            eligible: true,
            affordability: "request-dependent",
            routeKind: kind,
            route:
              kind === "native"
                ? "/v1/native/aws-bedrock/model/${model}/converse-stream"
                : "/v1/proxy/aws-bedrock/converse_stream",
          },
        ],
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearLiveCatalogCacheForTests();
});

async function setup(kind: "native" | "manifest" = "native") {
  const body = catalog(kind);
  const requests: Request[] = [];
  const state = {
    catalogReads: 0,
    body,
    response: () =>
      new Response(wire, { headers: { "content-type": "application/vnd.amazon.eventstream" } }),
  };
  vi.spyOn(ssrf, "fetchWithSsrFGuard").mockImplementation(async (params) => {
    params.beforeRequest?.();
    const req = new Request(params.url, params.init);
    expect(req.headers.get("authorization")).toBe("Bearer " + KEY);
    expect(new URL(req.url).origin).toBe(ROOT);
    if (req.method === "GET") {
      state.catalogReads++;
      expect(req.url).toBe(ROOT + "/v1/catalog");
      return { response: Response.json(state.body), finalUrl: req.url, release: async () => {} };
    }
    requests.push(req);
    return { response: state.response(), finalUrl: req.url, release: async () => {} };
  });
  const provider = await registerSingleProviderPlugin(clawrouter);
  const config = await buildClawRouterProviderConfig({
    apiKey: KEY,
    discoveryApiKey: KEY,
    baseUrl: ROOT,
  });
  const row = config.models[0];
  expect(row?.api).toBe("bedrock-converse-stream");
  const model: Model = {
    ...row,
    provider: "clawrouter",
    api: row.api!,
    baseUrl: row.baseUrl!,
    input: ["text", "image"],
  };
  const call = (
    options: Parameters<NonNullable<typeof provider.createStreamFn>>[0]["requestAuth"] = undefined,
  ) => {
    const ctx = { config: cfg, provider: "clawrouter", modelId: ID, model, requestAuth: options };
    const streamFn = provider.createStreamFn?.(ctx);
    expect(streamFn).toBeTypeOf("function");
    const wrapped = provider.wrapStreamFn?.({ ...ctx, streamFn });
    if (!wrapped) {
      throw new Error("Expected registered ClawRouter stream wrapper");
    }
    return wrapped;
  };
  return { state, requests, provider, model, call };
}

it.each(["native", "manifest"] as const)(
  "uses the actual registered SDK stream through the %s offer",
  async (kind) => {
    vi.stubEnv("AWS_BEDROCK_SKIP_AUTH", "1");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "synthetic-upstream-key-must-not-run");
    vi.stubEnv("AWS_REGION", "synthetic-invalid-region");
    const f = await setup(kind);
    const stream = await f.call()(f.model, context, {
      apiKey: KEY,
      headers: { Authorization: "Bearer synthetic-wrong-key" },
    });
    const result = await stream.result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.model).toBe(ID);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "fixture answer" }),
        expect.objectContaining({
          type: "toolCall",
          id: "result_call",
          name: "inspect",
          arguments: { value: 7 },
        }),
      ]),
    );
    expect(result.usage).toMatchObject({ input: 10, output: 3, totalTokens: 13 });
    expect(f.requests).toHaveLength(1);
    const req = f.requests[0];
    expect(req.headers.has("x-amz-security-token")).toBe(false);
    expect(req.headers.has("x-api-key")).toBe(false);
    let body = await req.json();
    if (kind === "manifest") {
      expect(req.url).toBe(ROOT + "/v1/proxy/aws-bedrock/converse_stream");
      expect(body).toMatchObject({ method: "POST", pathParams: { model: UPSTREAM }, query: {} });
      body = body.body;
    } else {
      expect(req.url).toBe(
        ROOT + "/v1/native/aws-bedrock/model/amazon.nova-lite-v1%3A0/converse-stream",
      );
    }
    expect(body).not.toHaveProperty("modelId");
    expect(body.messages[0].content).toEqual([
      { text: "fixture prompt" },
      { image: { format: "png", source: { bytes: "AQID" } } },
    ]);
    expect(body.system).toEqual([{ text: "fixture system" }]);
    expect(body.toolConfig.tools[0].toolSpec.name).toBe("inspect");
    expect(
      body.messages[1].content.map(
        (block: { toolUse: { toolUseId: string } }) => block.toolUse.toolUseId,
      ),
    ).toEqual(["call_a", "call_b"]);
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "call_a",
            content: [{ text: "first result" }],
            status: "success",
          },
        },
        {
          toolResult: {
            toolUseId: "call_b",
            content: [{ text: "second result" }],
            status: "success",
          },
        },
      ],
    });
  },
);

it.each(["foreign", "profile", "format", "capability", "stale", "origin"])(
  "denies a changed %s offer before POST",
  async (failure) => {
    const f = await setup();
    const provider = f.state.body.providers[0];
    if (failure === "foreign") {
      provider.id = "other";
    }
    if (failure === "profile") {
      provider.models[0].upstream = "us." + UPSTREAM;
    }
    if (failure === "format") {
      provider.routes[0].requestFormat = "aws_bedrock.invoke";
    }
    if (failure === "capability") {
      provider.models[0].capabilities = ["llm.embeddings"];
    }
    if (failure === "stale") {
      f.state.body.observedAt = "2000-01-01T00:00:00Z";
    }
    if (failure === "origin") {
      provider.offers[0].route = "https://foreign.example/converse-stream";
    }
    const result = await (await f.call()(f.model, context, { apiKey: KEY })).result();
    expect(result.stopReason).toBe("error");
    expect(f.requests).toHaveLength(0);
  },
);

it("uses the host-selected credential and revalidates its authority at dispatch", async () => {
  const f = await setup();
  let live = true;
  const auth = {
    version: 1 as const,
    resolve: async () => ({
      apiKey: KEY,
      assertCurrent() {
        if (!live) {
          throw new Error("synthetic revoked grant");
        }
      },
    }),
  };
  const result = await (
    await f.call(auth)(f.model, context, {
      apiKey: "synthetic-stale-captured-key",
      onPayload: () => {
        live = false;
      },
    })
  ).result();
  expect(result.stopReason).toBe("error");
  expect(f.requests).toHaveLength(0);
});

it("does not consult AWS auth when the proxy key is absent", async () => {
  const f = await setup();
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "synthetic-vendor-key");
  const result = await (await f.call()(f.model, context, {})).result();
  expect(result.stopReason).toBe("error");
  expect(f.requests).toHaveLength(0);
});

it.each(["truncated", "wrong MIME", "server error"])(
  "does not retry an unusable %s response",
  async (failure) => {
    const f = await setup();
    f.state.response = () =>
      new Response(failure === "truncated" ? wire.subarray(0, -10) : wire, {
        status: failure === "server error" ? 503 : 200,
        headers: {
          "content-type":
            failure === "wrong MIME" ? "application/json" : "application/vnd.amazon.eventstream",
        },
      });
    const result = await (await f.call()(f.model, context, { apiKey: KEY })).result();
    expect(result.stopReason).toBe("error");
    expect(f.requests).toHaveLength(1);
  },
);

it("cancels before catalog or paid dispatch", async () => {
  const f = await setup();
  const abort = new AbortController();
  const reads = f.state.catalogReads;
  abort.abort();
  const result = await (
    await f.call()(f.model, context, { apiKey: KEY, signal: abort.signal })
  ).result();
  expect(result.stopReason).toBe("aborted");
  expect(f.state.catalogReads).toBe(reads);
  expect(f.requests).toHaveLength(0);
});

it("cancels while reading the proxy body without decoding partial output or retrying", async () => {
  const f = await setup();
  const abort = new AbortController();
  f.state.response = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(wire.subarray(0, 256));
          queueMicrotask(() => {
            abort.abort();
            controller.error(abort.signal.reason);
          });
        },
      }),
      { headers: { "content-type": "application/vnd.amazon.eventstream" } },
    );
  const result = await (
    await f.call()(f.model, context, { apiKey: KEY, signal: abort.signal })
  ).result();
  expect(result.stopReason).toBe("aborted");
  expect(result.content).toEqual([]);
  expect(f.requests).toHaveLength(1);
});

it.each(["model", "size"])(
  "rejects a serialized SDK %s violation before egress",
  async (failure) => {
    const f = await setup();
    const result = await (
      await f.call()(f.model, context, {
        apiKey: KEY,
        onPayload: (body) =>
          failure === "model"
            ? { ...(body as object), modelId: "us." + UPSTREAM }
            : { ...(body as object), system: [{ text: "x".repeat(2 * 1024 * 1024) }] },
      })
    ).result();
    expect(result.stopReason).toBe("error");
    expect(f.requests).toHaveLength(0);
  },
);
