import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ resolveApiKeyForProvider: vi.fn() }));
// mock-isolation: Use only synthetic Router keys; never read real auth stores or credentials.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => auth);
import plugin from "./index.js";

const providerId = "cloudflare-ai-gateway";
const upstream = "claude-sonnet-4-6";
const selected = `${providerId}/${upstream}`;
const messagesPath = "/v1/native/cloudflare-ai-gateway/anthropic/v1/messages";

function catalog() {
  return {
    version: "clawrouter.client-catalog.v1",
    providers: [
      {
        id: providerId,
        allowed: true,
        executable: true,
        openaiCompatible: false,
        nativeBaseUrl: `/v1/native/${providerId}`,
        models: [
          {
            id: selected,
            upstream,
            capabilities: ["llm.messages"],
            input: ["text", "image"],
            nativeCapabilities: {
              version: "clawrouter.native-capabilities.v1",
              endpoints: {
                messages: { contextWindow: 200000, input: ["text", "image"] },
              },
            },
          },
        ] satisfies [unknown],
        routes: [
          {
            endpoint: "messages",
            path: "/anthropic/v1/messages",
            methods: ["POST"],
            requestFormat: "anthropic.messages",
            responseFormat: "anthropic.messages",
          },
        ] satisfies [unknown],
        offers: [
          {
            modelId: selected,
            endpoint: "messages",
            transport: "http",
            routeKind: "native",
            route: messagesPath,
            eligible: true,
            affordability: "request-dependent",
          },
        ] satisfies [unknown],
      },
    ] satisfies [unknown],
  };
}
type Catalog = ReturnType<typeof catalog>;
type Seen = { path: string; key: string | undefined; body?: unknown };
const events = [
  {
    type: "message_start",
    message: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: upstream,
      content: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

async function fixture(
  run: (ctx: {
    provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
    prepare: () => Promise<Parameters<StreamFn>[0]>;
    discover: () => Promise<unknown>;
    seen: Seen[];
    origin: string;
    started: Promise<void>;
    closed: Promise<void>;
  }) => Promise<void>,
  body: unknown = catalog(),
  modelId = selected,
  hold = false,
) {
  const provider = await registerSingleProviderPlugin(plugin);
  const seen: Seen[] = [];
  const started = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  await withServer(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          path: request.url ?? "",
          key: request.headers.authorization,
          ...(chunks.length ? { body: JSON.parse(Buffer.concat(chunks).toString()) } : {}),
        });
        if (request.url === "/v1/catalog") {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(body));
        } else {
          response.setHeader("content-type", "text/event-stream");
          response.once("close", () => closed.resolve());
          const wire = events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join("");
          if (hold) {
            response.write(wire.slice(0, wire.indexOf("event: message_delta")));
          } else {
            response.end(wire);
          }
          started.resolve();
        }
      });
    },
    async (origin) => {
      const config = {
        models: {
          providers: {
            clawrouter: {
              baseUrl: origin + "/v1",
              api: "anthropic-messages" as const,
              models: [
                {
                  id: modelId,
                  name: "Configured fallback",
                  reasoning: false,
                  input: ["text" as const],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1000,
                  maxTokens: 64,
                },
              ],
            },
          },
        },
      };
      await run({
        provider,
        seen,
        origin,
        started: started.promise,
        closed: closed.promise,
        discover: async () =>
          provider.catalog?.run?.({
            config,
            env: {},
            resolveProviderAuth: () => ({
              apiKey: "synthetic-router-key",
              mode: "api_key",
              source: "profile",
            }),
            resolveProviderApiKey: () => ({ apiKey: "synthetic-router-key" }),
          }),
        prepare: async () => {
          const model = await provider.prepareDynamicModel?.({
            config,
            provider: "clawrouter",
            modelId,
            modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
            providerConfig: config.models.providers.clawrouter,
            authProfileId: "synthetic-profile",
          });
          if (!model) {
            throw new Error("fixture: preparation returned no authoritative model");
          }
          return attachModelProviderRequestTransport(model, { allowPrivateNetwork: true });
        },
      });
    },
  );
}

beforeEach(() => {
  clearLiveCatalogCacheForTests();
  auth.resolveApiKeyForProvider.mockResolvedValue({ apiKey: "synthetic-router-key" });
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    vi.stubEnv(key, undefined);
    vi.stubEnv(key.toLowerCase(), undefined);
  }
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-never-upstream");
});

it.each(["removed", "malformed", "explicitly denied legacy"])(
  "does not resurrect a configured Messages model when its provider is %s",
  async (kind) => {
    const body = catalog();
    if (kind === "removed") {
      body.providers.splice(0);
    }
    if (kind === "malformed") {
      body.providers[0].nativeBaseUrl = "/invalid";
    }
    if (kind === "explicitly denied legacy") {
      Object.assign(body.providers[0], { offers: undefined, allowed: false });
    }
    await fixture(async ({ prepare, seen }) => {
      await expect(prepare()).rejects.toThrow(
        "ClawRouter catalog does not offer the selected model",
      );
      expect(seen.map(({ path }) => path)).toEqual(["/v1/catalog"]);
    }, body);
  },
);

it.each([false, true])(
  "rejects ambiguous native Messages bindings, reverse=%s",
  async (reverse) => {
    for (const conflict of ["endpoints", "routes", "offers", "upstreams"] as const) {
      const body = catalog();
      const row = body.providers[0];
      if (conflict === "upstreams") {
        row.models.push({ ...row.models[0], upstream: "foreign-upstream" });
      } else {
        if (conflict !== "offers") {
          row.routes.push({
            ...row.routes[0],
            endpoint: conflict === "endpoints" ? "alternate" : "messages",
            path: "/other/v1/messages",
          });
        }
        row.offers.push({
          ...row.offers[0],
          endpoint: conflict === "endpoints" ? "alternate" : "messages",
          route: `/v1/native/${providerId}/other/v1/messages`,
        });
      }
      if (reverse) {
        row.routes.reverse();
        row.offers.reverse();
        row.models.reverse();
      }
      clearLiveCatalogCacheForTests();
      await fixture(async ({ prepare, discover, seen }) => {
        expect(await discover()).toMatchObject({ provider: { models: [] } });
        await expect(prepare()).rejects.toThrow(
          "ClawRouter catalog does not offer the selected model",
        );
        expect(seen.map(({ path }) => path)).toEqual(["/v1/catalog"]);
      }, body);
    }
  },
);

it.each(["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const)(
  "%s cancels an unfinished native Messages response and joins its closure",
  async (hook) => {
    await fixture(
      async ({ provider, prepare, started, closed, seen }) => {
        const model = await prepare();
        const wrapped = provider[hook]?.({
          provider: "clawrouter",
          modelId: selected,
          streamFn: streamSimple,
        });
        if (!wrapped) {
          throw new Error("missing registered stream hook");
        }
        const controller = new AbortController();
        const stream = await wrapped(
          model,
          { messages: [{ role: "user", content: "Say hello.", timestamp: 0 }] },
          { apiKey: "synthetic-router-key", maxTokens: 64, signal: controller.signal },
        );
        await started;
        controller.abort();
        expect(await stream.result()).toMatchObject({ stopReason: "aborted" });
        await closed;
        expect(seen.map(({ path }) => path)).toEqual(["/v1/catalog", messagesPath]);
      },
      catalog(),
      selected,
      true,
    );
  },
);

it.each([
  ["provider", false],
  ["provider", true],
  ["model", false],
  ["model", true],
] as const)(
  "rejects normalized Messages identity collisions: %s, reverse=%s",
  async (kind, reverse) => {
    const body = catalog();
    const row = body.providers[0];
    if (kind === "provider") {
      const duplicate = structuredClone(row);
      duplicate.id = ` ${providerId} `;
      duplicate.routes[0].path = "/other/v1/messages";
      duplicate.offers[0].route = `/v1/native/${providerId}/other/v1/messages`;
      body.providers.push(duplicate);
      if (reverse) {
        body.providers.reverse();
      }
    } else {
      const duplicate = structuredClone(row.models[0]);
      duplicate.id = ` ${selected} `;
      duplicate.nativeCapabilities.endpoints.messages.contextWindow = 999;
      row.models.push(duplicate);
      if (reverse) {
        row.models.reverse();
      }
    }
    await fixture(async ({ prepare, discover, seen }) => {
      expect(await discover()).toMatchObject({ provider: { models: [] } });
      await expect(prepare()).rejects.toThrow(
        "ClawRouter catalog does not offer the selected model",
      );
      expect(seen.map(({ path }) => path)).toEqual(["/v1/catalog"]);
    }, body);
  },
);

it("retains a single normalized provider's exact native Messages offer", async () => {
  const body = catalog();
  body.providers[0].id = ` ${providerId} `;
  await fixture(async ({ prepare, origin }) => {
    expect(await prepare()).toMatchObject({
      id: selected,
      api: "anthropic-messages",
      baseUrl: origin + "/v1/native/cloudflare-ai-gateway/anthropic",
    });
  }, body);
});
afterEach(() => vi.unstubAllEnvs());

it.each(["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const)(
  "%s dispatches the registered discovered Messages offer with its exact native prefix",
  async (hook) => {
    await fixture(async ({ provider, prepare, discover, seen }) => {
      await discover();
      const model = await prepare();
      const wrapped = provider[hook]?.({
        provider: "clawrouter",
        modelId: selected,
        streamFn: streamSimple,
      });
      if (!wrapped) {
        throw new Error("missing registered stream hook");
      }
      const stream = await wrapped(
        model,
        { messages: [{ role: "user", content: "Say hello.", timestamp: 0 }] },
        { apiKey: "synthetic-router-key", maxTokens: 64 },
      );
      for await (const event of stream) {
        const message =
          event.type === "done"
            ? event.message
            : event.type === "error"
              ? event.error
              : event.partial;
        if (message) {
          expect(message.model).toBe(selected);
        }
      }
      expect(await stream.result()).toMatchObject({
        model: selected,
        responseModel: upstream,
        provider: "clawrouter",
        content: [{ type: "text", text: "Hello" }],
        stopReason: "stop",
      });
      expect(seen.map(({ path, key }) => [path, key])).toEqual([
        ["/v1/catalog", "Bearer synthetic-router-key"],
        [messagesPath, "Bearer synthetic-router-key"],
      ]);
      expect(seen[1]?.body).toMatchObject({ model: upstream });
      expect(auth.resolveApiKeyForProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "clawrouter",
          profileId: "synthetic-profile",
          lockedProfile: true,
        }),
      );
    });
  },
);

it.each([
  [
    "empty offers",
    (row: Catalog["providers"][number]) => {
      row.offers.splice(0);
    },
  ],
  [
    "rejected offer",
    (row: Catalog["providers"][number]) => {
      row.offers[0].eligible = false;
    },
  ],
  [
    "absent selected model",
    (row: Catalog["providers"][number]) => {
      row.models.splice(0);
    },
  ],
  [
    "null offers",
    (row: Catalog["providers"][number]) => {
      Object.assign(row, { offers: null });
    },
  ],
  [
    "malformed offers",
    (row: Catalog["providers"][number]) => {
      Object.assign(row, { offers: {} });
    },
  ],
  [
    "denied provider",
    (row: Catalog["providers"][number]) => {
      row.allowed = false;
    },
  ],
  [
    "foreign model",
    (row: Catalog["providers"][number]) => {
      row.offers[0].modelId = "foreign/model";
    },
  ],
  [
    "foreign provider route",
    (row: Catalog["providers"][number]) => {
      row.offers[0].route = "/v1/native/foreign/anthropic/v1/messages";
    },
  ],
  [
    "GET only",
    (row: Catalog["providers"][number]) => {
      row.routes[0].methods = ["GET"];
    },
  ],
  [
    "wrong request format",
    (row: Catalog["providers"][number]) => {
      row.routes[0].requestFormat = "openai.chat_completions";
    },
  ],
  [
    "wrong response format",
    (row: Catalog["providers"][number]) => {
      row.routes[0].responseFormat = "openai.chat_completions";
    },
  ],
  [
    "bare Messages suffix",
    (row: Catalog["providers"][number]) => {
      row.routes[0].path = "/messages";
      row.offers[0].route = `/v1/native/${providerId}/messages`;
    },
  ],
  [
    "malformed routes",
    (row: Catalog["providers"][number]) => {
      Object.assign(row, { routes: null });
    },
  ],
] as const)("does not infer a configured Messages fallback from %s", async (_name, invalidate) => {
  const body = catalog();
  invalidate(body.providers[0]);
  await fixture(async ({ prepare, discover, seen }) => {
    expect(await discover()).toMatchObject({ provider: { models: [] } });
    await expect(prepare()).rejects.toThrow("ClawRouter catalog does not offer the selected model");
    expect(seen.map(({ path }) => path)).toEqual(["/v1/catalog"]);
  }, body);
});

it.each(["llm.chat", "llm.responses"])(
  "retains %s precedence with rejected Messages offers",
  async (capability) => {
    const body = catalog();
    const row = body.providers[0];
    row.openaiCompatible = true;
    row.models[0].capabilities.push(capability);
    row.offers.splice(0);
    await fixture(async ({ prepare, origin }) => {
      expect(await prepare()).toMatchObject({
        id: selected,
        baseUrl: origin + "/v1",
        api: capability === "llm.chat" ? "openai-completions" : "openai-responses",
      });
    }, body);
  },
);

it("preserves genuinely absent legacy offer metadata", async () => {
  const body = catalog();
  const { offers: _offers, ...legacy } = body.providers[0];
  await fixture(
    async ({ prepare, origin }) => {
      expect(await prepare()).toMatchObject({
        id: selected,
        api: "anthropic-messages",
        baseUrl: origin + `/v1/native/${providerId}`,
      });
    },
    { providers: [legacy] },
  );
});

it("does not reuse a selected key's Messages grant after credential rotation", async () => {
  const body = catalog();
  await fixture(async ({ prepare, seen }) => {
    expect(await prepare()).toMatchObject({ id: selected });
    body.providers[0].offers.splice(0);
    auth.resolveApiKeyForProvider.mockResolvedValue({ apiKey: "synthetic-router-key-b" });
    await expect(prepare()).rejects.toThrow("ClawRouter catalog does not offer the selected model");
    auth.resolveApiKeyForProvider.mockResolvedValue({ apiKey: "synthetic-router-key" });
    expect(await prepare()).toMatchObject({ id: selected });
    expect(seen.map(({ path, key }) => [path, key])).toEqual([
      ["/v1/catalog", "Bearer synthetic-router-key"],
      ["/v1/catalog", "Bearer synthetic-router-key-b"],
    ]);
  }, body);
});

it.each(["anthropic", "vertex", "opencode", "opencode-go", "synthetic"])(
  "keeps %s provider and opaque upstream identities with canonical Messages offers",
  async (id) => {
    const body = catalog();
    const row = body.providers[0];
    row.id = id;
    row.nativeBaseUrl = `/v1/native/${id}`;
    row.models[0].id = `${id}/opaque-catalog-id`;
    row.models[0].upstream = "opaque/upstream-model";
    row.routes[0].path = "/v1/messages";
    row.offers[0].route = `${row.nativeBaseUrl}/v1/messages`;
    row.offers[0].modelId = row.models[0].id;
    await fixture(
      async ({ prepare, origin }) => {
        expect(await prepare()).toMatchObject({
          id: `${id}/opaque-catalog-id`,
          api: "anthropic-messages",
          baseUrl: origin + `/v1/native/${id}`,
          params: { clawrouterRoute: { upstreamModel: "opaque/upstream-model" } },
        });
      },
      body,
      row.models[0].id,
    );
  },
);

it("preserves Vercel's exact Messages precedence over Chat", async () => {
  const body = catalog();
  const row = body.providers[0];
  row.id = "vercel-ai-gateway";
  row.nativeBaseUrl = "/v1/native/vercel-ai-gateway";
  row.openaiCompatible = true;
  row.models[0].id = "vercel-ai-gateway/anthropic/claude-sonnet-4.6";
  row.models[0].upstream = "anthropic/claude-sonnet-4.6";
  row.models[0].capabilities.push("llm.chat");
  row.routes[0].path = "/v1/messages";
  row.offers[0].route = `${row.nativeBaseUrl}/v1/messages`;
  row.offers[0].modelId = row.models[0].id;
  await fixture(
    async ({ prepare, origin }) => {
      expect(await prepare()).toMatchObject({
        api: "anthropic-messages",
        baseUrl: origin + row.nativeBaseUrl,
      });
      row.offers.splice(0);
      clearLiveCatalogCacheForTests();
      await expect(prepare()).rejects.toThrow(
        "ClawRouter catalog does not offer the selected model",
      );
    },
    body,
    row.models[0].id,
  );
});
