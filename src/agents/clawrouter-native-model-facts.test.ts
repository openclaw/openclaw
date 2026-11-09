import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { streamSimple } from "../llm/stream.js";
import type { Model } from "../llm/types.js";
import { registerSingleProviderPlugin } from "../plugin-sdk/plugin-test-runtime.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-live-runtime.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { catalogProvider } from "./clawrouter-catalog.test-support.js";
import { isCodeModeEngagedForModel, resolveCodeModeConfig } from "./code-mode-runtime.js";
import {
  makeInMemorySessionManager,
  makeModelSnapshotEntry,
} from "./embedded-agent-runner.sanitize-session-history.test-harness.js";
import { createEmptyPreparedModelRuntimeFixture } from "./embedded-agent-runner/model.fixture.test-support.js";
import {
  createEmptyAgentDiscoveryStores,
  resolveModelAsync,
} from "./embedded-agent-runner/model.js";
import { createPreparedConfiguredRuntimeModelLookup } from "./embedded-agent-runner/model.static-id.js";
import { sanitizeSessionHistory } from "./embedded-agent-runner/replay-history.js";
import { resolveImageCompressionModelPolicy } from "./image-compression-policy.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import type { AgentMessage } from "./runtime/index.js";
import { convertToLlm } from "./sessions/messages.js";
import { ModelRegistry } from "./sessions/model-registry.js";
import { resolveTranscriptPolicy } from "./transcript-policy.js";
import { makeZeroUsageSnapshot } from "./usage.js";

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Real ClawRouter catalog, model registry, provider runtime hooks, and runtime decisions.
// The native side resolves the same model ids through the bundled first-party catalogs.
it("resolves routed GPT and Claude models with the native runtime decisions", async () => {
  const { default: clawrouter } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  await withOpenClawTestState({ label: "clawrouter-native-facts" }, async (state) => {
    const catalogRequests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      catalogRequests.push(new Request(input).url);
      return Response.json({
        providers: [
          catalogProvider("openai", ["gpt-6.1-sol", "gpt-6-unknown"], "llm.responses"),
          catalogProvider(
            "anthropic",
            ["claude-opus-5-5", "claude-haiku-4-5", "claude-opus-6"],
            "llm.messages",
          ),
        ],
      });
    });
    const credential = "synthetic-clawrouter-native-facts-key";
    // Typical ClawRouter-only setup: a key, the default router origin, no authored routes.
    const cfg = {
      models: { providers: { clawrouter: { apiKey: credential } } },
    } as unknown as OpenClawConfig;
    const provider = await registerSingleProviderPlugin(clawrouter);
    const catalog = await provider.catalog?.run({
      config: cfg,
      env: {},
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      resolveProviderAuth: () => ({
        apiKey: credential,
        discoveryApiKey: credential,
        mode: "api_key",
        source: "profile",
      }),
      resolveProviderApiKey: () => ({ apiKey: credential, discoveryApiKey: credential }),
    });
    if (!catalog || !("provider" in catalog) || !catalog.provider) {
      throw new Error("Expected a discovered ClawRouter provider");
    }
    // Prepared runtimes pin the bundled manifests, including disabled first-party plugins.
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: ["openai", "anthropic", "clawrouter"].map((pluginId) => {
        const loaded = loadPluginManifest(join(process.cwd(), "extensions", pluginId));
        if (!loaded.ok) {
          throw new Error(loaded.error);
        }
        return loaded.manifest;
      }),
    });
    const stores = createEmptyAgentDiscoveryStores();
    stores.modelRegistry = ModelRegistry.fromCapturedSources(
      stores.authStorage,
      join(state.agentDir(), "models.json"),
      {
        modelsJsonContents: null,
        pluginCatalogs: [],
        staticProviderConfigs: { clawrouter: catalog.provider },
        pluginMetadataSnapshot: metadataSnapshot,
      },
    );
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({ pluginId: "clawrouter", source: "bundled-test", provider });
    const configuredRuntimeModels = stores.modelRegistry.getAll().map((model) => ({
      provider: "clawrouter",
      modelId: model.id,
      model,
    }));
    const preparedModelRuntime: PreparedModelRuntimeSnapshot = {
      ...createEmptyPreparedModelRuntimeFixture({
        agentDir: state.agentDir(),
        config: cfg,
        metadataSnapshot,
        createStores: () => stores,
      }),
      agentId: "main",
      workspaceDir: state.workspaceDir,
      pluginRegistry,
      configuredRuntimeModels,
      findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
        configuredRuntimeModels,
        metadataSnapshot,
      ),
    };
    const decisions = async (target: "clawrouter" | "openai" | "anthropic", modelId: string) => {
      const routed = target === "clawrouter";
      const config = routed ? cfg : {};
      const resolved = await resolveModelAsync(target, modelId, state.agentDir(), config, {
        workspaceDir: state.workspaceDir,
        ...(routed ? { preparedModelRuntime } : { skipAgentDiscovery: true }),
        allowBundledStaticCatalogFallback: true,
      });
      if (!resolved.model) {
        throw new Error(`unresolved ${target}/${modelId}: ${resolved.error}`);
      }
      const compat = resolved.model.compat as { supportsTemperature?: boolean } | undefined;
      return {
        codeModeEngaged: isCodeModeEngagedForModel(
          resolveCodeModeConfig(config, "main", { provider: target, modelId }),
          resolved.model,
        ),
        supportsTemperature: compat?.supportsTemperature,
        image: await resolveImageCompressionModelPolicy({
          cfg: config,
          provider: target,
          model: modelId,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          ...(routed ? { preparedModelRuntime } : {}),
        }),
      };
    };

    for (const [nativeProvider, upstream] of [
      ["openai", "gpt-6.1-sol"],
      ["anthropic", "claude-opus-5-5"],
      ["anthropic", "claude-haiku-4-5"],
    ] as const) {
      expect(await decisions("clawrouter", `${nativeProvider}/${upstream}`)).toEqual(
        await decisions(nativeProvider, upstream),
      );
    }
    // Pin the oracle: preferred tiers engage default Code Mode; capable Haiku 4.5 does not.
    expect(await decisions("clawrouter", "openai/gpt-6.1-sol")).toMatchObject({
      codeModeEngaged: true,
      supportsTemperature: false,
    });
    expect(await decisions("clawrouter", "anthropic/claude-opus-5-5")).toMatchObject({
      codeModeEngaged: true,
      image: { maxSidePx: 2576, preferredSidePx: 2576 },
    });
    expect(await decisions("clawrouter", "anthropic/claude-haiku-4-5")).toMatchObject({
      codeModeEngaged: false,
      image: { maxSidePx: 1568 },
    });
    // Unknown ids keep generic defaults instead of borrowing a sibling's facts.
    for (const unknown of ["openai/gpt-6-unknown", "anthropic/claude-opus-6"]) {
      expect(await decisions("clawrouter", unknown)).toEqual({
        codeModeEngaged: false,
        supportsTemperature: undefined,
        image: {},
      });
    }
    // Every routed decision reused the one key-scoped catalog response.
    expect(new Set(catalogRequests)).toEqual(
      new Set(["https://clawrouter.openclaw.ai/v1/catalog"]),
    );
  });
});

it("uses Vercel's granted native Messages SDK route for catalog, replay and streaming", async () => {
  const upstream = "anthropic/claude-sonnet-4.6";
  const id = `vercel-ai-gateway/${upstream}`;
  const nativePath = "/v1/native/vercel-ai-gateway/v1/messages";
  const credential = "synthetic-router-vercel-key";
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-unused-anthropic-key");
  vi.stubEnv("AI_GATEWAY_API_KEY", "synthetic-unused-gateway-key");
  vi.stubEnv("CLAWROUTER_API_KEY", "");
  const { default: entry } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  const plugin = await registerSingleProviderPlugin(entry);
  await withOpenClawTestState({ label: "clawrouter-vercel-sdk" }, async (state) => {
    const row = {
      ...catalogProvider("vercel-ai-gateway", [upstream], ["llm.chat", "llm.messages"]),
      allowed: true,
      executable: true,
      openaiCompatible: true,
      routes: [
        {
          endpoint: "messages",
          path: "/v1/messages",
          methods: ["POST"],
          requestFormat: "anthropic.messages",
          responseFormat: "anthropic.messages",
        },
        {
          endpoint: "chat_completions",
          path: "/chat/completions",
          methods: ["POST"],
          requestFormat: "openai.chat_completions",
          responseFormat: "openai.chat_completions",
        },
      ],
      offers: [
        {
          endpoint: "messages",
          modelId: id,
          transport: "http",
          routeKind: "native",
          route: nativePath,
          eligible: true,
          affordability: "request-dependent",
        },
        {
          endpoint: "chat_completions",
          modelId: id,
          transport: "http",
          routeKind: "native",
          route: "/v1/native/vercel-ai-gateway/chat/completions",
          eligible: true,
          affordability: "request-dependent",
        },
      ],
    };
    let providers: unknown[] = [row];
    let reject = false;
    const requests: Request[] = [];
    const bodies: Record<string, unknown>[] = [];
    const catalogKeys: Array<string | null> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/v1/catalog")) {
        catalogKeys.push(request.headers.get("authorization"));
        return Response.json({ version: "clawrouter.client-catalog.v1", providers });
      }
      requests.push(request);
      bodies.push((await request.json()) as Record<string, unknown>);
      if (reject) {
        return Response.json(
          { error: { type: "permission_error", message: "Synthetic revoked grant" } },
          { status: 403 },
        );
      }
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_synthetic",
            type: "message",
            role: "assistant",
            model: upstream,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 11, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "verified" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 3 },
        },
        { type: "message_stop" },
      ];
      const bytes = new TextEncoder().encode(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      );
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 7) {
              controller.enqueue(bytes.slice(offset, offset + 7));
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const config = {
      models: { providers: { clawrouter: { apiKey: credential } } },
    } as unknown as OpenClawConfig;
    const discover = async (key: string) => {
      const catalog = await plugin.catalog?.run({
        config,
        env: {},
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        resolveProviderAuth: () => ({
          apiKey: key,
          discoveryApiKey: key,
          mode: "api_key",
          source: "profile",
        }),
        resolveProviderApiKey: () => ({ apiKey: key, discoveryApiKey: key }),
      });
      if (!catalog || !("provider" in catalog) || !catalog.provider) {
        throw new Error("Missing catalog");
      }
      return catalog.provider;
    };
    const catalog = await discover(credential);
    expect(catalog.models).toHaveLength(1);
    const selected = catalog.models[0]!;
    expect(selected).toMatchObject({
      id,
      api: "anthropic-messages",
      baseUrl: "https://clawrouter.openclaw.ai/v1/native/vercel-ai-gateway",
    });
    const model: Model = {
      ...selected,
      provider: "clawrouter",
      api: "anthropic-messages",
      baseUrl: selected.baseUrl!,
      input: ["text", "image"],
    };
    const history: AgentMessage[] = [
      { role: "user", content: "look up a record", timestamp: 1 },
      {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-6-luna",
        content: [
          { type: "toolCall", id: "call_previous|fc_one", name: "lookup", arguments: { index: 1 } },
        ],
        usage: makeZeroUsageSnapshot(),
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_previous|fc_one",
        toolName: "lookup",
        content: [{ type: "text", text: "synthetic record" }],
        isError: false,
        timestamp: 3,
      },
    ];
    const replay = await sanitizeSessionHistory({
      provider: "clawrouter",
      modelId: id,
      modelApi: model.api,
      model,
      policy: resolveTranscriptPolicy({
        provider: "clawrouter",
        modelId: id,
        modelApi: model.api,
        model,
        runtimeHandle: { provider: "clawrouter", plugin },
      }),
      config,
      env: {},
      workspaceDir: state.workspaceDir,
      sessionId: "vercel-replay",
      sessionManager: makeInMemorySessionManager([
        makeModelSnapshotEntry({
          timestamp: 0,
          provider: "openai",
          modelApi: "openai-responses",
          modelId: "gpt-6-luna",
        }),
      ]),
      messages: history,
    });
    const stream =
      plugin.wrapStreamFn?.({ provider: "clawrouter", modelId: id, streamFn: streamSimple }) ??
      streamSimple;
    const context = {
      messages: convertToLlm(replay),
      tools: [
        {
          name: "lookup",
          description: "Look up a synthetic record",
          parameters: { type: "object", properties: { index: { type: "integer" } } },
        },
      ],
    };
    const result = await (
      await stream(model, context, { apiKey: credential, maxTokens: 100 })
    ).result();
    expect(result).toMatchObject({
      stopReason: "stop",
      model: id,
      content: [{ type: "text", text: "verified" }],
      usage: { input: 11, output: 3 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`https://clawrouter.openclaw.ai${nativePath}`);
    expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${credential}`);
    expect(requests[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(JSON.stringify([...requests[0]!.headers])).not.toContain("synthetic-unused");
    expect(bodies[0]).toMatchObject({ model: upstream, stream: true });
    const messages = bodies[0]!.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    const use = messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_use");
    const answer = messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");
    expect(use).toMatchObject({ name: "lookup", input: { index: 1 } });
    expect(use?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(answer).toMatchObject({ tool_use_id: use?.id, content: "synthetic record" });
    expect(JSON.stringify(bodies[0])).not.toContain("clawrouterRoute");

    // Missing router auth never acquires either ambient upstream credential.
    expect((await (await stream(model, context, {})).result()).stopReason).toBe("error");
    expect(requests).toHaveLength(1);
    reject = true;
    expect((await (await stream(model, context, { apiKey: credential })).result()).stopReason).toBe(
      "error",
    );
    expect(requests).toHaveLength(2);

    // Keep the valid Chat offer: denial must not silently switch this native model to Chat.
    const denied = [
      { ...row, allowed: false },
      { ...row, offers: [row.offers[1]] },
      { ...row, offers: row.offers.map((offer) => ({ ...offer, eligible: false })) },
      { ...row, offers: [{ ...row.offers[0], route: "https://foreign.example/v1/messages" }] },
      {
        ...row,
        routes: [{ ...row.routes[0], path: "/messages" }],
        offers: [{ ...row.offers[0], route: "/v1/native/vercel-ai-gateway/messages" }],
      },
      { ...row, routes: [{ ...row.routes[0], responseFormat: "unknown.messages" }] },
      { ...row, models: [{ ...row.models[0], upstream: "anthropic/unknown-model" }] },
    ];
    for (const [index, provider] of denied.entries()) {
      providers = [provider];
      expect((await discover(`synthetic-denied-router-key-${index}`)).models).toEqual([]);
    }
    expect(catalogKeys[0]).toBe(`Bearer ${credential}`);
    expect(new Set(catalogKeys).size).toBe(denied.length + 1);
    expect(requests).toHaveLength(2);
    providers = [
      {
        ...row,
        models: [
          {
            id: "vercel-ai-gateway/synthetic-chat",
            upstream: "synthetic-chat",
            capabilities: ["llm.chat", "llm.messages"],
          },
        ],
      },
    ];
    expect((await discover("synthetic-other-vercel-key")).models[0]?.api).toBe(
      "openai-completions",
    );
    providers = [
      {
        ...row,
        id: "other-gateway",
        nativeBaseUrl: "/v1/native/other-gateway",
        models: [
          {
            id: "other-gateway/model",
            upstream: "model",
            capabilities: ["llm.chat", "llm.messages"],
          },
        ],
      },
    ];
    expect((await discover("synthetic-other-key")).models[0]?.api).toBe("openai-completions");
  });
});

// Exercise the runner's actual model-switch cleanup and the actual Chat serializer.
it("replays prior-provider tool history with the same strict9 IDs as native Mistral", async () => {
  await withOpenClawTestState({ label: "clawrouter-mistral-replay" }, async (state) => {
    const entry = await loadBundledPluginFacade<{
      default: Parameters<typeof registerSingleProviderPlugin>[0];
    }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
    const router = await registerSingleProviderPlugin(entry.default);
    const nativeEntry = await loadBundledPluginFacade<{
      default: Parameters<typeof registerSingleProviderPlugin>[0];
    }>({ pluginId: "mistral", artifactBasename: "index.js" });
    const native = await registerSingleProviderPlugin(nativeEntry.default);
    const requests: Array<{ body: Record<string, unknown>; authorization: string | null }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/v1/catalog")) {
        return Response.json({
          providers: [
            {
              ...catalogProvider("mistral", ["mistral-large-latest"], "llm.chat"),
              openaiCompatible: true,
            },
          ],
        });
      }
      requests.push({
        body: (await request.json()) as Record<string, unknown>,
        authorization: request.headers.get("authorization"),
      });
      return Response.json(
        { error: { message: "synthetic end of request capture" } },
        { status: 400 },
      );
    });
    const credential = "synthetic-router-replay-key";
    const config = {
      models: { providers: { clawrouter: { apiKey: credential } } },
    } as unknown as OpenClawConfig;
    const catalog = await router.catalog?.run({
      config,
      env: {},
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      resolveProviderAuth: () => ({
        apiKey: credential,
        discoveryApiKey: credential,
        mode: "api_key",
        source: "profile",
      }),
      resolveProviderApiKey: () => ({ apiKey: credential, discoveryApiKey: credential }),
    });
    if (!catalog || !("provider" in catalog) || !catalog.provider) {
      throw new Error("missing router catalog");
    }
    const row = catalog.provider.models[0];
    if (!row || row.api !== "openai-completions") {
      throw new Error("missing routed Mistral");
    }
    const callIds = [
      "call_previous_provider_shared_prefix_one|fc_one",
      "call_previous_provider_shared_prefix_two|fc_two",
    ];
    const history: AgentMessage[] = [
      { role: "user", content: "look up both records", timestamp: 1 },
      {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-6-luna",
        content: callIds.map((id, index) => ({
          type: "toolCall",
          id,
          name: "lookup",
          arguments: { index },
        })),
        usage: makeZeroUsageSnapshot(),
        stopReason: "toolUse",
        timestamp: 2,
      },
      ...callIds.map((toolCallId, index): AgentMessage => ({
        role: "toolResult",
        toolCallId,
        toolName: "lookup",
        content: [{ type: "text", text: `record ${index}` }],
        isError: false,
        timestamp: 3 + index,
      })),
    ];
    for (const [providerId, plugin] of [
      ["clawrouter", router],
      ["mistral", native],
    ] as const) {
      const model: Model = {
        ...row,
        provider: providerId,
        api: row.api,
        input: ["text"],
        id: providerId === "clawrouter" ? row.id : "mistral-large-latest",
        baseUrl: catalog.provider.baseUrl,
      };
      const sessionManager = makeInMemorySessionManager([
        makeModelSnapshotEntry({
          timestamp: 0,
          provider: "openai",
          modelApi: "openai-responses",
          modelId: "gpt-6-luna",
        }),
      ]);
      const policy = resolveTranscriptPolicy({
        provider: providerId,
        modelId: model.id,
        modelApi: model.api,
        model,
        runtimeHandle: { provider: providerId, plugin },
      });
      const params = {
        provider: providerId,
        modelId: model.id,
        modelApi: model.api,
        model,
        policy,
        config,
        env: {},
        workspaceDir: state.workspaceDir,
        sessionId: "mistral-replay",
        sessionManager,
      };
      const replay = await sanitizeSessionHistory({ ...params, messages: history });
      expect(await sanitizeSessionHistory({ ...params, messages: replay })).toEqual(replay);
      expect(sessionManager.getEntries()).toHaveLength(2);
      const stream =
        plugin.wrapStreamFn?.({
          provider: providerId,
          modelId: model.id,
          streamFn: streamSimple,
        }) ?? streamSimple;
      await (
        await stream(
          model,
          {
            messages: convertToLlm(replay),
            tools: [
              {
                name: "lookup",
                description: "Look up a synthetic record",
                parameters: { type: "object", properties: { index: { type: "integer" } } },
              },
            ],
          },
          { apiKey: credential },
        )
      ).result();
    }
    expect(requests).toHaveLength(2);
    expect(requests.map(({ authorization }) => authorization)).toEqual([
      `Bearer ${credential}`,
      `Bearer ${credential}`,
    ]);
    const [routedRequest, nativeRequest] = requests;
    if (!routedRequest || !nativeRequest) {
      throw new Error("missing routed or native request");
    }
    expect(routedRequest.body.messages).toEqual(nativeRequest.body.messages);
    const messages = routedRequest.body.messages as Array<{
      role: string;
      tool_calls?: Array<{ id: string }>;
      tool_call_id?: string;
    }>;
    const ids = messages.flatMap((message) => message.tool_calls?.map(({ id }) => id) ?? []);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    }
    expect(
      messages.filter(({ role }) => role === "tool").map(({ tool_call_id }) => tool_call_id),
    ).toEqual(ids);
    expect(history[1]).toMatchObject({ content: callIds.map((id) => ({ id })) });
  });
});
