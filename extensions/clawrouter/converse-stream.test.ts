import type { ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { createEmptyTransportUsage } from "openclaw/plugin-sdk/provider-stream-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, expect, it, vi } from "vitest";
import eventFixture from "./fixtures/converse-eventstream.json" with { type: "json" };
import clawrouter from "./index.js";
import { buildClawRouterProviderConfig } from "./provider-catalog.js";

const KEY = "synthetic-proxy-key";
const UPSTREAM = "amazon.nova-lite-v1:0";
const ID = "aws-bedrock/" + UPSTREAM;
const wire = Buffer.from(eventFixture.base64, "base64");
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

type FixtureState = {
  catalogReads: number;
  body: ReturnType<typeof catalog>;
  response: () => Response;
  respond?: (res: ServerResponse) => void;
};

async function withFixture(
  run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  kind: "native" | "manifest" = "native",
) {
  const requests: Request[] = [];
  const state: FixtureState = {
    catalogReads: 0,
    body: catalog(kind),
    response: () =>
      new Response(wire, { headers: { "content-type": "application/vnd.amazon.eventstream" } }),
  };
  let root = "";
  await withServer(
    (incoming, outgoing) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) {
          chunks.push(Buffer.from(chunk));
        }
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index];
          const value = incoming.rawHeaders[index + 1];
          assert(name && value !== undefined, "Expected complete HTTP headers");
          headers.append(name, value);
        }
        const req = new Request(new URL(incoming.url ?? "/", root), {
          method: incoming.method,
          headers,
          ...(incoming.method === "POST" ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
        });
        expect(req.headers.get("authorization")).toBe("Bearer " + KEY);
        expect(new URL(req.url).origin).toBe(root);
        if (req.method === "GET") {
          state.catalogReads++;
          expect(req.url).toBe(root + "/v1/catalog");
          outgoing.setHeader("content-type", "application/json");
          outgoing.end(JSON.stringify(state.body));
          return;
        }
        requests.push(req);
        if (state.respond) {
          state.respond(outgoing);
          return;
        }
        const response = state.response();
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      })().catch((error: unknown) =>
        outgoing.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    },
    async (baseUrl) => {
      root = baseUrl;
      await run(await setup(root, state, requests));
    },
  );
}

async function setup(root: string, state: FixtureState, requests: Request[]) {
  const cfg: OpenClawConfig = {
    models: {
      providers: {
        clawrouter: {
          baseUrl: root + "/v1",
          apiKey: KEY,
          models: [],
          request: { allowPrivateNetwork: true },
        },
      },
    },
  };
  const provider = await registerSingleProviderPlugin(clawrouter);
  const config = await buildClawRouterProviderConfig({
    apiKey: KEY,
    discoveryApiKey: KEY,
    baseUrl: root,
  });
  const row = config.models[0];
  assert(row?.api === "bedrock-converse-stream", "Expected a selected Converse model");
  assert(row.baseUrl, "Expected the selected proxy endpoint");
  const model: Model = {
    ...row,
    provider: "clawrouter",
    api: row.api,
    baseUrl: row.baseUrl,
    input: ["text", "image"],
  };
  const call = (
    options?: Parameters<NonNullable<typeof provider.createStreamFn>>[0]["requestAuth"],
  ) => {
    const ctx = { config: cfg, provider: "clawrouter", modelId: ID, model, requestAuth: options };
    const streamFn = provider.createStreamFn?.(ctx);
    assert(typeof streamFn === "function", "Expected the registered Converse stream hook");
    const wrapped = provider.wrapStreamFn?.({ ...ctx, streamFn });
    if (!wrapped) {
      throw new Error("Expected registered ClawRouter stream wrapper");
    }
    return wrapped;
  };
  return { root, state, requests, provider, model, call };
}

it.each(["native", "manifest"] as const)(
  "uses the actual registered SDK stream through the %s offer",
  async (kind) => {
    vi.stubEnv("AWS_BEDROCK_SKIP_AUTH", "1");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "synthetic-upstream-key-must-not-run");
    vi.stubEnv("AWS_REGION", "synthetic-invalid-region");
    await withFixture(async (f) => {
      const stream = await f.call()(f.model, context, {
        apiKey: KEY,
        headers: { Authorization: "Bearer synthetic-wrong-key" },
      });
      const result = await stream.result();
      expect(result.stopReason, result.errorMessage).toBe("toolUse");
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
      assert(req, "Expected one proxy request");
      expect(req.headers.has("x-amz-security-token")).toBe(false);
      expect(req.headers.has("x-api-key")).toBe(false);
      let body = await req.json();
      if (kind === "manifest") {
        expect(req.url).toBe(f.root + "/v1/proxy/aws-bedrock/converse_stream");
        expect(body).toMatchObject({ method: "POST", pathParams: { model: UPSTREAM }, query: {} });
        body = body.body;
      } else {
        expect(req.url).toBe(
          f.root + "/v1/native/aws-bedrock/model/amazon.nova-lite-v1%3A0/converse-stream",
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
    }, kind);
  },
);

it.each(["foreign", "profile", "format", "capability", "stale", "origin"])(
  "denies a changed %s offer before POST",
  async (failure) => {
    await withFixture(async (f) => {
      const provider = f.state.body.providers[0];
      assert(provider, "Expected the selected provider");
      const model = provider.models[0];
      const route = provider.routes[0];
      const offer = provider.offers[0];
      assert(model && route && offer, "Expected a complete selected offer");
      if (failure === "foreign") {
        provider.id = "other";
      }
      if (failure === "profile") {
        model.upstream = "us." + UPSTREAM;
      }
      if (failure === "format") {
        route.requestFormat = "aws_bedrock.invoke";
      }
      if (failure === "capability") {
        model.capabilities = ["llm.embeddings"];
      }
      if (failure === "stale") {
        f.state.body.observedAt = "2000-01-01T00:00:00Z";
      }
      if (failure === "origin") {
        offer.route = "https://foreign.example/converse-stream";
      }
      const result = await (await f.call()(f.model, context, { apiKey: KEY })).result();
      expect(result.stopReason).toBe("error");
      expect(f.requests).toHaveLength(0);
    });
  },
);

it("uses the host-selected credential and revalidates its authority at dispatch", async () => {
  await withFixture(async (f) => {
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
});

it("does not consult AWS auth when the proxy key is absent", async () => {
  await withFixture(async (f) => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "synthetic-vendor-key");
    const result = await (await f.call()(f.model, context, {})).result();
    expect(result.stopReason).toBe("error");
    expect(f.requests).toHaveLength(0);
  });
});

it.each(["truncated", "wrong MIME", "server error"])(
  "does not retry an unusable %s response",
  async (failure) => {
    await withFixture(async (f) => {
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
    });
  },
);

it("cancels before catalog or paid dispatch", async () => {
  await withFixture(async (f) => {
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
});

it("cancels while reading the proxy body without decoding partial output or retrying", async () => {
  await withFixture(async (f) => {
    const abort = new AbortController();
    const started = createDeferred();
    f.state.respond = (res) => {
      res.setHeader("content-type", "application/vnd.amazon.eventstream");
      res.write(wire.subarray(0, 256), () => started.resolve());
    };
    const stream = await f.call()(f.model, context, { apiKey: KEY, signal: abort.signal });
    await started.promise;
    abort.abort();
    const result = await stream.result();
    expect(result.stopReason).toBe("aborted");
    expect(result.content).toEqual([]);
    expect(f.requests).toHaveLength(1);
  });
});

it.each(["model", "size"])(
  "rejects a serialized SDK %s violation before egress",
  async (failure) => {
    await withFixture(async (f) => {
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
    });
  },
);
