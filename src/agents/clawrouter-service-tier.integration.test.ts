import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readRequestText, respondJson } from "../../test/helpers/gateway-integration-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { streamSimple } from "../llm/stream.js";
import type { Model } from "../llm/types.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-live-runtime.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { resolveFastModeForElapsed } from "../shared/fast-mode.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerSingleProviderPlugin } from "../test-utils/plugin-registration.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { applyExtraParamsToAgent } from "./embedded-agent-runner/extra-params.js";
import { createModelSpeedPolicyResolver } from "./model-fast-mode.js";
import type { StreamFn } from "./runtime/index.js";

const sse = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";
const response = {
  id: "resp_tier_fixture",
  object: "response",
  status: "completed",
  output: [
    {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "fixture answer", annotations: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
};

type CapturedRequest = {
  path: string | undefined;
  authorization: string | undefined;
  agent: string | string[] | undefined;
  session: string | string[] | undefined;
  requestId: string | string[] | undefined;
  body: Record<string, unknown>;
};

describe("ClawRouter agent service-tier HTTP composition", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let server: Awaited<ReturnType<typeof reserveTestPortListener<Server>>>;
  let provider: ProviderPlugin;
  let baseUrl: string;
  let discovered: ModelProviderConfig;
  const catalogRequests: Array<{ path?: string; authorization?: string }> = [];
  const requests: CapturedRequest[] = [];
  let mode: "complete" | "reject" | "reject-tier" | "hold" = "complete";
  let held = createDeferred<ServerResponse>();
  let peerClosed = createDeferred();

  beforeAll(async () => {
    state = await createOpenClawTestState({
      label: "clawrouter-tier",
      env: {
        OPENAI_API_KEY: "synthetic-unrelated-openai-key",
        CLAWROUTER_API_KEY: "synthetic-unrelated-router-key",
      },
    });
    const entry = await loadBundledPluginFacade<{
      default: Parameters<typeof registerSingleProviderPlugin>[0];
    }>({
      pluginId: "clawrouter",
      artifactBasename: "index.ts",
    });
    provider = await registerSingleProviderPlugin(entry.default);
    server = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, reply) => {
          void (async () => {
            if (request.url === "/v1/catalog") {
              catalogRequests.push({
                path: request.url,
                authorization: request.headers.authorization,
              });
              const tierCards = (ids: string[]) => ids.map((id) => ({ id, aliases: [] }));
              const model = (id: string, tiers?: unknown, capabilities = ["llm.responses"]) => ({
                id,
                upstream: id.slice(id.indexOf("/") + 1),
                capabilities,
                supportedReasoningEfforts: ["high"],
                pricing: { serviceTiers: tiers },
              });
              respondJson(reply, {
                providers: [
                  {
                    id: "openai",
                    openaiCompatible: true,
                    nativeBaseUrl: "/v1/native/openai",
                    routes: [],
                    models: [
                      model("openai/tier-fixture", tierCards(["default", "flex", "priority"])),
                      model("alias/tier-fixture", tierCards(["default", "priority"])),
                      model("openai/default-only", tierCards(["default"])),
                      model("openai/unknown-tiers"),
                      model("openai/malformed-tiers", ["priority", null, {}]),
                      model(
                        "openai/ultra-fixture",
                        tierCards(["default", "priority", "ultrafast"]),
                      ),
                      model("openai/chat-fixture", tierCards(["default", "priority"]), [
                        "llm.chat",
                      ]),
                    ],
                  },
                  ...["anthropic", "google", "openrouter"].map((id) => ({
                    id,
                    openaiCompatible: true,
                    nativeBaseUrl: "/v1/native/" + id,
                    routes: [],
                    models: [
                      model(
                        id === "openrouter" ? "openrouter/auto" : id + "/tier-fixture",
                        tierCards(["default", "priority"]),
                      ),
                    ],
                  })),
                ],
              });
              return;
            }
            const bodyText = await readRequestText(request);
            requests.push({
              path: request.url,
              authorization: request.headers.authorization,
              agent: request.headers["x-clawrouter-agent-id"],
              session: request.headers["x-clawrouter-session-id"],
              requestId: request.headers["x-request-id"],
              body: JSON.parse(bodyText),
            });
            if (mode === "reject-tier") {
              respondJson(
                reply,
                {
                  error: {
                    code: "service_tier_not_allowed",
                    message:
                      "Service tier priority is not allowed for openai/tier-fixture on this key; allowed tiers: default.",
                  },
                },
                400,
              );
              return;
            }
            if (mode === "reject") {
              respondJson(
                reply,
                {
                  error: { message: "Synthetic route policy denied", type: "permission_error" },
                },
                403,
              );
              return;
            }
            reply.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
            reply.write(
              sse({
                type: "response.created",
                response: { ...response, status: "in_progress", output: [] },
              }),
            );
            if (mode === "hold") {
              reply.once("close", () => peerClosed.resolve());
              held.resolve(reply);
              return;
            }
            reply.end(sse({ type: "response.completed", response }));
          })().catch((error: unknown) =>
            reply.destroy(error instanceof Error ? error : new Error(String(error))),
          );
        }),
    });
    baseUrl = "http://127.0.0.1:" + server.claim.port + "/v1";
    const catalog = await provider.catalog?.run({
      config: { models: { providers: { clawrouter: { baseUrl, models: [] } } } },
      env: {},
      agentDir: state.agentDir("fixture-agent"),
      workspaceDir: state.workspaceDir,
      resolveProviderAuth: () => ({
        apiKey: "synthetic-catalog-key",
        discoveryApiKey: "synthetic-catalog-key",
        mode: "api_key",
        source: "profile",
      }),
      resolveProviderApiKey: () => ({
        apiKey: "synthetic-catalog-key",
        discoveryApiKey: "synthetic-catalog-key",
      }),
    });
    if (!catalog || !("provider" in catalog) || !catalog.provider) {
      throw new Error("Expected the real ClawRouter catalog projection");
    }
    discovered = catalog.provider;
  });

  afterAll(async () => {
    server?.listener.closeAllConnections();
    await server?.releaseListener();
    await server?.claim.release();
    await state?.cleanup();
    clearLiveCatalogCacheForTests();
  });

  function prepare(
    params: {
      configured?: Record<string, unknown>;
      override?: Record<string, unknown>;
      id?: string;
      api?:
        | "openai-responses"
        | "openai-completions"
        | "anthropic-messages"
        | "google-generative-ai";
    } = {},
  ) {
    const id = params.id ?? "openai/tier-fixture";
    const row = discovered.models.find((candidate) => candidate.id === id);
    if (!row) {
      throw new Error("Missing fixture catalog model: " + id);
    }
    const api = params.api ?? row.api ?? "openai-responses";
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: { ["clawrouter/" + id]: { params: params.configured ?? {} } },
        },
      },
    };
    const model = attachModelProviderRuntimePluginHandle(
      {
        ...row,
        id,
        name: "Synthetic routed model",
        provider: "clawrouter",
        api,
        baseUrl,
        reasoning: true,
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 64,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        headers: { Authorization: "Bearer synthetic-stale-catalog-key" },
      } satisfies Model<typeof api>,
      { provider: "clawrouter", modelId: id, config: cfg, plugin: provider },
    );
    const agent: { streamFn: StreamFn } = { streamFn: streamSimple };
    applyExtraParamsToAgent(
      agent,
      cfg,
      "clawrouter",
      id,
      params.override,
      "high",
      "fixture-agent",
      state.workspaceDir,
      model,
      state.agentDir("fixture-agent"),
    );
    return { model, streamFn: agent.streamFn };
  }

  async function call(params: Parameters<typeof prepare>[0], options?: Parameters<StreamFn>[2]) {
    const agent = prepare(params);
    const stream = await agent.streamFn(
      agent.model,
      {
        messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }],
      },
      {
        apiKey: "synthetic-scoped-router-key",
        sessionId: "fixture-session",
        requestId: "fixture-run:model:1",
        maxRetries: 0,
        reasoning: "high",
        ...options,
      },
    );
    return await stream.result();
  }

  async function rejectedCall(
    rejection: "reject" | "reject-tier",
    params: Parameters<typeof prepare>[0],
  ) {
    mode = rejection;
    const before = requests.length;
    try {
      const result = await call(params);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain(
        rejection === "reject-tier" ? "allowed tiers: default" : "Synthetic route policy denied",
      );
      expect(requests).toHaveLength(before + 1);
      expect(requests.at(-1)?.authorization).toBe("Bearer synthetic-scoped-router-key");
      return requests.at(-1)!;
    } finally {
      mode = "complete";
    }
  }

  it.each<[string, NonNullable<Parameters<typeof prepare>[0]>, string | undefined]>([
    ["unset speed preference", {}, undefined],
    ["Standard without inherited tier", { override: { fastMode: false } }, undefined],
    ["regular Fast", { override: { fastMode: true } }, "priority"],
    ["catalog alias", { id: "alias/tier-fixture", override: { fastMode: true } }, "priority"],
    ["Ultrafast", { id: "openai/ultra-fixture", override: { fastMode: "ultrafast" } }, "ultrafast"],
    ["inherited tier", { configured: { serviceTier: "flex" } }, "flex"],
    [
      "Standard override",
      { configured: { serviceTier: "priority" }, override: { fastMode: false } },
      "default",
    ],
    [
      "Fast override",
      { configured: { serviceTier: "flex" }, override: { fastMode: true } },
      "priority",
    ],
    [
      "snake-case override",
      { configured: { serviceTier: "priority" }, override: { service_tier: "flex" } },
      "flex",
    ],
  ])(
    "sends %s through the real agent hook and Responses transport",
    async (_name, params, tier) => {
      const result = await call(params);
      expect(result.stopReason).toBe("stop");
      expect(result.content).toMatchObject([{ type: "text", text: "fixture answer" }]);
      expect(requests.at(-1)).toMatchObject({
        path: "/v1/responses",
        authorization: "Bearer synthetic-scoped-router-key",
        agent: "fixture-agent",
        session: "fixture-session",
        requestId: "fixture-run:model:1",
        body: { model: params.id ?? "openai/tier-fixture", reasoning: { effort: "high" } },
      });
      expect(requests.at(-1)?.body.service_tier).toBe(tier);
    },
  );

  it("advertises exact catalog tiers through the picker light-policy owner", () => {
    expect(catalogRequests).toEqual([
      { path: "/v1/catalog", authorization: "Bearer synthetic-catalog-key" },
    ]);
    const catalog = discovered.models.map((row) =>
      Object.assign({}, row, { provider: "clawrouter" }),
    );
    const resolve = createModelSpeedPolicyResolver({
      cfg: {},
      agentId: "fixture-agent",
      catalog,
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "clawrouter",
            providers: ["clawrouter"],
            rootDir: path.resolve(import.meta.dirname, "../../extensions/clawrouter"),
          },
        ],
      }),
    });
    const evaluation = { availability: true, routeResolution: null, selectedAuthMode: "api_key" };
    const expected = new Map<string, string[]>([
      ["openai/tier-fixture", ["default", "flex", "priority"]],
      ["alias/tier-fixture", ["default", "priority"]],
      ["openai/default-only", ["default"]],
      ["openai/ultra-fixture", ["default", "priority", "ultrafast"]],
    ]);
    for (const entry of catalog) {
      const tiers = expected.get(entry.id);
      expect(resolve(entry, evaluation, "openclaw"), entry.id).toEqual({
        serviceTiers: tiers,
        supportsFastMode: tiers?.includes("priority") ?? false,
        supportsServiceTierRecovery: false,
      });
    }
    const first = catalog.find((entry) => entry.id === "openai/tier-fixture");
    if (!first) {
      throw new Error("Expected the catalog route used by the endpoint-scope assertion");
    }
    expect(resolve(first, evaluation, "codex")).toEqual({
      serviceTiers: undefined,
      supportsFastMode: undefined,
      supportsServiceTierRecovery: false,
    });
    expect(
      resolve(first, { availability: undefined, routeResolution: { kind: "indeterminate" } }),
    ).toEqual({});
    expect(
      resolve(
        { ...first, baseUrl: "https://different-endpoint.example/v1" },
        evaluation,
        "openclaw",
      ).supportsFastMode,
    ).toBe(false);
  });

  it.each(["openai/default-only", "openai/unknown-tiers", "openai/malformed-tiers"])(
    "does not invent Fast support for catalog model %s",
    async (id) => {
      const result = await call({ id, override: { fastMode: true } });
      expect(result.stopReason).toBe("stop");
      expect(requests.at(-1)?.body).not.toHaveProperty("service_tier");
    },
  );

  it("rejects explicit Ultrafast when the model catalog does not declare it", async () => {
    const before = requests.length;
    const result = await call({ override: { fastMode: "ultrafast" } });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      "does not advertise ultrafast; supported tiers: default, flex, priority",
    );
    expect(requests).toHaveLength(before);
  });

  it("surfaces a disallowed requested tier with allowed tiers and never silently downgrades", async () => {
    const request = await rejectedCall("reject-tier", { override: { fastMode: true } });
    expect(request.body.service_tier).toBe("priority");
  });

  it.each([true, "ultrafast"] as const)(
    "keeps an explicit async payload tier ahead of Fast %s",
    async (fastMode) => {
      const result = await call(
        { override: { fastMode } },
        {
          onPayload: async (payload, model) => {
            expect(model.provider).toBe("clawrouter");
            expect(model.id).toBe("openai/tier-fixture");
            return { ...(payload as Record<string, unknown>), service_tier: "flex" };
          },
        },
      );
      expect(result.stopReason).toBe("stop");
      expect(requests.at(-1)?.body.service_tier).toBe("flex");
    },
  );

  it("expires Auto between requests without resampling during an async payload replacement", async () => {
    let nowMs = 1000;
    let reads = 0;
    const fastMode = () => {
      reads++;
      return resolveFastModeForElapsed({
        mode: "auto",
        fastAutoOnSeconds: 30,
        startedAtMs: 1000,
        nowMs,
      }).enabled;
    };
    const agent = prepare({ configured: { serviceTier: "flex" }, override: { fastMode } });
    const invoke = async () => {
      const stream = await agent.streamFn(
        agent.model,
        { messages: [{ role: "user", content: "Synthetic Auto", timestamp: 1 }] },
        {
          apiKey: "synthetic-scoped-router-key",
          maxRetries: 0,
          reasoning: "high",
          onPayload: async (payload) => {
            nowMs = 31001;
            return { ...(payload as Record<string, unknown>) };
          },
        },
      );
      expect((await stream.result()).stopReason).toBe("stop");
    };
    await invoke();
    expect(requests.at(-1)?.body.service_tier).toBe("priority");
    await invoke();
    expect(requests.at(-1)?.body.service_tier).toBe("default");
    expect(reads).toBe(2);
  });

  it.each(["anthropic/tier-fixture", "google/tier-fixture", "openrouter/auto"])(
    "does not apply OpenAI tiers to compatible non-OpenAI route %s",
    async (id) => {
      const result = await call({
        id,
        configured: { serviceTier: "priority" },
        override: { fastMode: true },
      });
      expect(result.stopReason).toBe("stop");
      expect(requests.at(-1)?.body).not.toHaveProperty("service_tier");
    },
  );

  it.each([
    { id: "anthropic/tier-fixture", api: "anthropic-messages", path: "/messages" },
    { id: "google/tier-fixture", api: "google-generative-ai", path: ":streamGenerateContent" },
    { id: "openai/tier-fixture", api: "openai-completions", path: "/chat/completions" },
  ] as const)(
    "leaves native $api HTTP requests free of OpenAI service tiers",
    async ({ path: httpPath, ...route }) => {
      const request = await rejectedCall("reject", {
        ...route,
        configured: { serviceTier: "priority" },
        override: { fastMode: true },
      });
      expect(request.path).toContain(httpPath);
      expect(request.body).not.toHaveProperty("service_tier");
    },
  );

  it("surfaces HTTP rejection without retrying or borrowing a native provider credential", async () => {
    await rejectedCall("reject", { override: { fastMode: true } });
  });

  it("preserves abort through the composed hook and closes the HTTP response", async () => {
    mode = "hold";
    held = createDeferred<ServerResponse>();
    peerClosed = createDeferred();
    const controller = new AbortController();
    const result = call({ override: { fastMode: true } }, { signal: controller.signal });
    try {
      await awaitGateBeforeSettlement(
        held.promise,
        result,
        "Request completed before the held HTTP response",
      );
      controller.abort();
      expect((await result).stopReason).toBe("aborted");
      await peerClosed.promise;
    } finally {
      controller.abort();
      server.listener.closeAllConnections();
      await result;
      mode = "complete";
    }
  });
});
