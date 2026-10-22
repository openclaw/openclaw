import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { OpenAIResponsesOptions } from "@openclaw/ai/internal/openai";
import MarkdownIt from "markdown-it";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { streamSimple } from "../llm/stream.js";
import type { Model } from "../llm/types.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-live-runtime.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerSingleProviderPlugin } from "../test-utils/plugin-registration.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { applyModelProviderToolPolicy } from "./agent-tools.model-provider-policy.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { applyExtraParamsToAgent } from "./embedded-agent-runner/extra-params.js";
import { createEmptyPreparedModelRuntimeFixture } from "./embedded-agent-runner/model.fixture.test-support.js";
import { createEmptyAgentDiscoveryStores } from "./embedded-agent-runner/model.js";
import { prepareEmbeddedRunTransport } from "./embedded-agent-runner/run/runtime-preparation.js";
import { resolveNativeWebSearchRoute } from "./native-web-search.js";
import type { StreamFn } from "./runtime/index.js";

const sse = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";
const search = {
  type: "web_search_call",
  id: "search_fixture",
  status: "completed",
  action: { type: "search", query: "synthetic" },
};
const citation = {
  type: "url_citation",
  start_index: 0,
  end_index: 16,
  url: "https://example.test/source",
  title: "Fixture source",
};
const message = {
  type: "message",
  id: "msg_fixture",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: "Synthetic source.",
      annotations: [citation],
    },
  ],
};
const response = {
  id: "resp_search_fixture",
  object: "response",
  status: "completed",
  output: [search, message],
  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
};
const createTool = (name: string): AnyAgentTool => ({
  name,
  label: name,
  description: name,
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
});
const tools = ["web_search", "read"].map(createTool);

describe("ClawRouter admitted hosted search HTTP composition", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let server: Awaited<ReturnType<typeof reserveTestPortListener<Server>>>;
  let provider: ProviderPlugin;
  let baseUrl: string;
  let catalog: ModelProviderConfig;
  let deniedCatalog: ModelProviderConfig;
  let mode:
    | "json"
    | "sse"
    | "terminal"
    | "reject"
    | "rotate"
    | "stream-error"
    | "hold"
    | "annotation"
    | "late-citation"
    | "multipart-citation"
    | "earlier-citation"
    | "stale-citation"
    | "citation-title"
    | "json-failed"
    | "json-invalid" = "sse";
  let held = createDeferred<ServerResponse>();
  let closed = createDeferred();
  let rejectedRotationKey: string | undefined;
  const requests: Array<{ path?: string; authorization?: string; body: Record<string, unknown> }> =
    [];
  const catalogAuth: string[] = [];
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "clawrouter",
        providers: ["clawrouter"],
        rootDir: path.resolve(import.meta.dirname, "../../extensions/clawrouter"),
      },
    ],
  });

  beforeAll(async () => {
    state = await createOpenClawTestState({
      label: "clawrouter-search",
      env: {
        OPENAI_API_KEY: "synthetic-unrelated-openai",
        CLAWROUTER_API_KEY: "synthetic-unrelated-router",
      },
    });
    const entry = await loadBundledPluginFacade<{
      default: Parameters<typeof registerSingleProviderPlugin>[0];
    }>({ pluginId: "clawrouter", artifactBasename: "index.ts" });
    provider = await registerSingleProviderPlugin(entry.default);
    server = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, reply) => {
          void (async () => {
            if (request.url === "/v1/catalog") {
              catalogAuth.push(request.headers.authorization ?? "");
              const admitted = request.headers.authorization === "Bearer synthetic-admitted";
              const rows = [
                { id: "alias/search-fixture", supported: true, admission: "admitted" },
                { id: "openai/gpt-5.4", supported: false, admission: "admitted" },
                { id: "openai/pricing-required", supported: true, admission: "pricing_required" },
                { id: "openai/unknown", supported: true },
                { id: "openai/future", supported: true, admission: "admitted", version: "future" },
                { id: "openai/malformed", supported: true, admission: "admitted", malformed: true },
                {
                  id: "openai/future-admission",
                  supported: true,
                  admission: "admitted",
                  admissionVersion: "future",
                },
                {
                  id: "openai/wrong-offer",
                  supported: true,
                  admission: "admitted",
                  route: "/v1/chat/completions",
                },
              ];
              reply.writeHead(200, { "content-type": "application/json" });
              reply.end(
                JSON.stringify({
                  providers: [
                    {
                      id: "openai",
                      openaiCompatible: true,
                      nativeBaseUrl: "/v1/native/openai",
                      routes: [],
                      models: rows.map((row) => ({
                        id: row.id,
                        upstream: "fixture",
                        capabilities: ["llm.responses"],
                        ...(row.supported
                          ? {
                              nativeCapabilities: {
                                version: row.version ?? "clawrouter.native-capabilities.v1",
                                endpoints: {
                                  responses: {
                                    hostedTools: row.malformed
                                      ? [true, "web_search"]
                                      : ["web_search"],
                                  },
                                },
                              },
                            }
                          : {}),
                      })),
                      offers: rows.map((row) => ({
                        modelId: row.id,
                        endpoint: "responses",
                        transport: "http",
                        routeKind: "unified",
                        route: row.route ?? "/v1/responses",
                        eligible: true,
                        hostedToolAdmission: row.admission
                          ? {
                              version:
                                row.admissionVersion ?? "clawrouter.hosted-tool-admission.v1",
                              web_search: admitted ? row.admission : "pricing_required",
                            }
                          : undefined,
                      })),
                    },
                  ],
                }),
              );
              return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.from(chunk));
            }
            requests.push({
              path: request.url,
              authorization: request.headers.authorization,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
            if (mode === "rotate" && request.headers.authorization === rejectedRotationKey) {
              reply.writeHead(429, { "content-type": "application/json" });
              reply.end(JSON.stringify({ error: { message: "Synthetic profile rate limit" } }));
              return;
            }
            if (mode === "reject") {
              reply.writeHead(400, { "content-type": "application/json" });
              reply.end(
                JSON.stringify({
                  error: {
                    code: "pricing_required",
                    message:
                      "Hosted web_search is not admitted for this key; ask your ClawRouter administrator to qualify this route.",
                  },
                }),
              );
              return;
            }
            if (mode === "json" || mode === "json-failed" || mode === "json-invalid") {
              reply.writeHead(200, { "content-type": "application/json" });
              reply.end(
                JSON.stringify(
                  mode === "json-failed"
                    ? {
                        ...response,
                        status: "failed",
                        error: { code: "search_failed", message: "Synthetic hosted search failed" },
                      }
                    : mode === "json-invalid"
                      ? { object: "not-a-response", status: "completed" }
                      : response,
                ),
              );
              return;
            }
            const firstPart = {
              ...message.content[0],
              text: "Synthetic ",
              annotations: [citation],
            };
            const secondPart = {
              ...message.content[0],
              text: "source.",
              annotations: [{ ...citation, url: "https://example.test/second", title: "Second" }],
            };
            const terminalMessage =
              mode === "multipart-citation" || mode === "earlier-citation"
                ? { ...message, content: [firstPart, secondPart] }
                : mode === "stale-citation"
                  ? { ...message, content: [{ ...message.content[0], text: "Stale prose." }] }
                  : mode === "citation-title"
                    ? {
                        ...message,
                        content: [
                          {
                            ...message.content[0],
                            annotations: [
                              {
                                ...citation,
                                title: "<https://other.test/> <img src=x> [label] `code` *bold*",
                              },
                            ],
                          },
                        ],
                      }
                    : message;
            const completedMessage =
              mode === "multipart-citation"
                ? {
                    ...message,
                    content: [
                      { ...firstPart, annotations: [] },
                      { ...secondPart, annotations: [] },
                    ],
                  }
                : mode === "earlier-citation"
                  ? { ...message, content: [{ ...firstPart, annotations: [] }, secondPart] }
                  : mode === "late-citation" || mode === "stale-citation"
                    ? { ...message, content: [{ ...message.content[0], annotations: [] }] }
                    : terminalMessage;
            reply.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
            reply.write(
              sse({
                type: "response.created",
                response: { ...response, status: "in_progress", output: [] },
              }),
            );
            if (mode === "hold") {
              reply.once("close", () => closed.resolve());
              held.resolve(reply);
              return;
            }
            if (mode !== "terminal") {
              const events = [
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { ...search, status: "in_progress" },
                },
                { type: "response.web_search_call.searching", output_index: 0, item_id: search.id },
                { type: "response.output_item.done", output_index: 0, item: search },
                { type: "response.output_item.done", output_index: 0, item: search },
                {
                  type: "response.output_item.added",
                  output_index: 1,
                  item: { ...message, content: [] },
                },
                {
                  type: "response.output_text.delta",
                  output_index: 1,
                  item_id: message.id,
                  content_index: 0,
                  delta: "Synthetic source.",
                },
                ...(mode === "annotation"
                  ? [
                      {
                        type: "response.output_text.annotation.added",
                        output_index: 1,
                        item_id: message.id,
                        content_index: 0,
                        annotation_index: 0,
                        annotation: null,
                      },
                      {
                        type: "response.output_text.annotation.added",
                        output_index: 1,
                        item_id: message.id,
                        content_index: 0,
                        annotation_index: 0,
                        annotation: citation,
                      },
                    ]
                  : []),
                {
                  type: "response.output_item.done",
                  output_index: 1,
                  item:
                    mode === "annotation" ? { ...message, content: undefined } : completedMessage,
                },
              ];
              const bytes = Buffer.from(events.map(sse).join(""));
              for (let offset = 0; offset < bytes.length; offset += 17) {
                reply.write(bytes.subarray(offset, offset + 17));
              }
            }
            if (mode === "stream-error") {
              reply.end(
                sse({
                  type: "error",
                  code: "search_failed",
                  message: "Synthetic hosted search failed",
                }),
              );
              return;
            }
            const terminal = sse({
              type: "response.completed",
              response: { ...response, output: [search, terminalMessage] },
            });
            // Identical terminal replay must not produce another delta or absolute text_end.
            reply.end(terminal + terminal);
          })().catch((error: unknown) =>
            reply.destroy(error instanceof Error ? error : new Error(String(error))),
          );
        }),
    });
    baseUrl = "http://127.0.0.1:" + server.claim.port + "/v1";
    async function discover(key: string) {
      const result = await provider.catalog?.run({
        config: { models: { providers: { clawrouter: { baseUrl, models: [] } } } },
        env: {},
        agentDir: state.agentDir("fixture"),
        workspaceDir: state.workspaceDir,
        resolveProviderAuth: () => ({
          apiKey: key,
          discoveryApiKey: key,
          mode: "api_key",
          source: "profile",
        }),
        resolveProviderApiKey: () => ({ apiKey: key, discoveryApiKey: key }),
      });
      if (!result || !("provider" in result) || !result.provider) {
        throw new Error("Missing real catalog projection");
      }
      return result.provider;
    }
    catalog = await discover("synthetic-admitted");
    deniedCatalog = await discover("synthetic-denied");
    await discover("synthetic-admitted");
  });
  afterAll(async () => {
    server?.listener.closeAllConnections();
    await server?.releaseListener();
    await server?.claim.release();
    clearLiveCatalogCacheForTests();
    await state?.cleanup();
  });

  function prepare(config: OpenClawConfig = {}, id = "alias/search-fixture", source = catalog) {
    const row = source.models.find((candidate) => candidate.id === id);
    if (!row) {
      throw new Error("Missing catalog model " + id);
    }
    const model = attachModelProviderRuntimePluginHandle(
      {
        ...row,
        api: "openai-responses",
        baseUrl,
        provider: "clawrouter",
        input: ["text"],
        headers: { Authorization: "Bearer synthetic-stale-key" },
      } satisfies Model<"openai-responses">,
      { provider: "clawrouter", modelId: id, config, plugin: provider },
    );
    return assemble(model, config);
  }
  function assemble(model: Model, config: OpenClawConfig) {
    const policy = {
      config,
      modelProvider: model.provider,
      modelId: model.id,
      modelApi: model.api,
      modelBaseUrl: model.baseUrl,
      modelParams: model.params,
      agentId: "fixture",
      agentDir: state.agentDir("fixture"),
      pluginMetadataSnapshot: metadataSnapshot,
    };
    const assembled = applyModelProviderToolPolicy(tools, {
      ...policy,
      preparedModelRuntime: { metadataSnapshot },
    });
    const agent: { streamFn: StreamFn } = { streamFn: streamSimple };
    applyExtraParamsToAgent(
      agent,
      config,
      "clawrouter",
      model.id,
      {},
      "high",
      "fixture",
      state.workspaceDir,
      model,
      state.agentDir("fixture"),
      undefined,
      { nativeWebSearchPolicyContext: { agentId: "fixture" } },
    );
    return { model, streamFn: agent.streamFn, assembled, policy };
  }
  async function call(
    prepared = prepare(),
    options?: Parameters<StreamFn>[2] &
      Pick<
        OpenAIResponsesOptions,
        "openclawCodeModeToolSurface" | "openclawCodeModeAllowedHostedToolTypes"
      >,
  ) {
    const stream = await prepared.streamFn(
      prepared.model,
      {
        messages: [{ role: "user", content: "Synthetic search", timestamp: 1 }],
        tools: prepared.assembled,
      },
      { apiKey: "synthetic-admitted", maxRetries: 0, ...options },
    );
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    return { result: await stream.result(), events };
  }

  it.each(["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const)(
    "%s preserves the isolated-completion tool boundary on an admitted route",
    async (hook) => {
      mode = "terminal";
      const prepared = prepare();
      const wrapped = provider[hook]?.({
        provider: "clawrouter",
        modelId: prepared.model.id,
        agentId: "fixture",
        streamFn: streamSimple,
      });
      if (!wrapped) {
        throw new Error("Missing ClawRouter stream hook");
      }
      const allowed = new Set<string>();
      const { result } = await call(
        { ...prepared, streamFn: wrapped, assembled: [] },
        {
          sessionId: "synthetic-session",
          onPayload: (payload) => {
            // An explicit caller payload must not gain tools or change its effort in isolation.
            return { ...(payload as Record<string, unknown>), reasoning: { effort: "minimal" } };
          },
          openclawCodeModeAllowedHostedToolTypes: allowed,
        },
      );
      expect(result.stopReason).toBe("stop");
      const regular = hook === "wrapStreamFn";
      expect(requests.at(-1)?.body.tools ?? []).toEqual(regular ? [{ type: "web_search" }] : []);
      expect(requests.at(-1)?.body.reasoning).toMatchObject({
        effort: regular ? "low" : "minimal",
      });
      expect(allowed).toEqual(new Set(regular ? ["web_search"] : []));
      expect(requests.at(-1)?.authorization).toBe("Bearer synthetic-admitted");
    },
  );

  it.each(["admitted", "denied"] as const)(
    "rematerializes catalog admission after production auth-controller rotation from %s",
    async (first) => {
      const second = first === "admitted" ? "denied" : "admitted";
      const ids = [first, second].map((key) => "clawrouter:" + key);
      await state.writeAuthProfiles(
        {
          version: 1,
          profiles: Object.fromEntries(
            ["admitted", "denied"].map((key) => [
              "clawrouter:" + key,
              { type: "api_key", provider: "clawrouter", key: "synthetic-" + key },
            ]),
          ),
        },
        "fixture",
      );
      const config: OpenClawConfig = {
        auth: { order: { clawrouter: ids } },
        // Authored configuration must not pin a discovered key's private route facts.
        models: { providers: { clawrouter: { baseUrl, models: [] } } },
      };
      const registry = createEmptyPluginRegistry();
      registry.providers.push({ pluginId: "clawrouter", source: "bundled", provider });
      const generation = {
        ...createEmptyPreparedModelRuntimeFixture({
          agentDir: state.agentDir("fixture"),
          config,
          metadataSnapshot,
          createStores: createEmptyAgentDiscoveryStores,
        }),
        workspaceDir: state.workspaceDir,
        pluginRegistry: registry,
      };
      await withPluginRuntimeGenerationScope(generation, async () => {
        const runtime = await prepareEmbeddedRunTransport({
          assertCurrent() {},
          runParams: {
            runId: "synthetic-rotation-" + first,
            sessionId: "synthetic-rotation",
            agentId: "fixture",
            prompt: "Synthetic search",
            config,
            workspaceDir: state.workspaceDir,
            timeoutMs: 5000,
          },
          provider: "clawrouter",
          modelId: "alias/search-fixture",
          agentDir: generation.agentDir,
          workspaceDir: state.workspaceDir,
          globalLane: "test",
          hookRunner: undefined,
          hookContext: { sessionId: "synthetic-rotation", workspaceDir: state.workspaceDir },
          markStartupStage() {},
          notifyExecutionPhase() {},
          fallbackConfigured: false,
          preparedModelRuntime: generation,
        });
        const before = requests.length;
        mode = "rotate";
        rejectedRotationKey = "Bearer synthetic-" + first;
        try {
          const dispatch = async () => {
            const snapshot = runtime.snapshot();
            return call(assemble(snapshot.effectiveModel, config), {
              apiKey: snapshot.apiKeyInfo?.apiKey,
            });
          };
          expect(runtime.snapshot().lastProfileId).toBe(ids[0]);
          const failed = await dispatch();
          expect(failed.result.stopReason).toBe("error");
          expect(failed.result.errorMessage).toContain("Synthetic profile rate limit");
          expect(await runtime.advanceAttemptAuthProfile()).toBe(true);
          expect(runtime.snapshot().lastProfileId).toBe(ids[1]);
          expect((await dispatch()).result.stopReason).toBe("stop");
          const attempts = requests.slice(before);
          expect(attempts.map((request) => request.authorization)).toEqual([
            "Bearer synthetic-" + first,
            "Bearer synthetic-" + second,
          ]);
          for (const [index, key] of [first, second].entries()) {
            expect(attempts[index]?.body.tools).toMatchObject(
              key === "admitted"
                ? [{ type: "function", name: "read" }, { type: "web_search" }]
                : [
                    { type: "function", name: "read" },
                    { type: "function", name: "web_search" },
                  ],
            );
          }
          expect(await runtime.advanceAttemptAuthProfile()).toBe(false);
        } finally {
          runtime.stopRuntimeAuthRefreshTimer();
          rejectedRotationKey = undefined;
        }
      });
    },
  );

  it.each(["json", "sse", "terminal", "annotation", "late-citation"] as const)(
    "sends admitted hosted search and projects clickable citations from %s",
    async (wire) => {
      mode = wire;
      const prepared = prepare();
      expect(resolveNativeWebSearchRoute(prepared.policy).kind).toBe("native");
      expect(prepared.assembled.map((tool) => tool.name)).toEqual(["read"]);
      const allowed = new Set<string>();
      const { result, events } = await call(prepared, {
        openclawCodeModeAllowedHostedToolTypes: allowed,
      });
      expect(result.stopReason).toBe("stop");
      expect(result.content).toMatchObject([
        {
          type: "text",
          text: "Synthetic source.\n\n[Fixture source](https://example.test/source)",
        },
      ]);
      expect(result.content.filter((part) => part.type === "toolCall")).toEqual([]);
      const fullText = "Synthetic source.\n\n[Fixture source](https://example.test/source)";
      expect(
        events.filter((event) => event.type === "text_end").map((event) => event.content),
      ).toEqual(wire === "late-citation" ? ["Synthetic source.", fullText] : [fullText]);
      if (wire === "late-citation") {
        expect(events.map((event) => event.type)).toEqual([
          "start",
          "text_start",
          "text_delta",
          "text_end",
          "text_delta",
          "text_end",
          "done",
        ]);
        expect(
          events
            .filter((event) => event.type.startsWith("text_"))
            .map((event) => ({
              type: event.type,
              index: "contentIndex" in event ? event.contentIndex : undefined,
              text: "delta" in event ? event.delta : "content" in event ? event.content : undefined,
            })),
        ).toEqual([
          { type: "text_start", index: 0, text: undefined },
          { type: "text_delta", index: 0, text: "Synthetic source." },
          { type: "text_end", index: 0, text: "Synthetic source." },
          {
            type: "text_delta",
            index: 0,
            text: "\n\n[Fixture source](https://example.test/source)",
          },
          { type: "text_end", index: 0, text: fullText },
        ]);
      }
      expect(allowed).toEqual(new Set(["web_search"]));
      expect(requests.at(-1)).toMatchObject({
        path: "/v1/responses",
        authorization: "Bearer synthetic-admitted",
        body: {
          model: "alias/search-fixture",
          tools: [{ type: "function", name: "read" }, { type: "web_search" }],
        },
      });
      expect(requests.at(-1)?.body).not.toHaveProperty("clawrouterRoute");
      expect(requests.at(-1)?.body).not.toHaveProperty("max_tool_calls");
    },
  );

  it.each(["multipart-citation", "earlier-citation"] as const)(
    "recovers earlier-part terminal sources without duplicating prose or prior sources: %s",
    async (wire) => {
      mode = wire;
      const { result, events } = await call();
      const text = result.content.find((part) => part.type === "text")?.text ?? "";
      const paragraphs = new MarkdownIt()
        .parse(text, {})
        .filter((token) => token.type === "inline");
      const parsed = paragraphs.flatMap((token) => token.children ?? []);
      expect(result.stopReason).toBe("stop");
      expect(
        paragraphs.map((paragraph) =>
          (paragraph.children ?? [])
            .filter((token) => token.type === "text")
            .map((token) => token.content)
            .join(""),
        ),
      ).toEqual([
        "Synthetic source.",
        wire === "earlier-citation" ? "Second Fixture source" : "Fixture source Second",
      ]);
      expect(
        parsed.filter((token) => token.type === "link_open").map((token) => token.attrGet("href")),
      ).toEqual(
        wire === "earlier-citation"
          ? ["https://example.test/second", "https://example.test/source"]
          : ["https://example.test/source", "https://example.test/second"],
      );
      expect(
        events.filter((event) => event.type === "text_end").map((event) => event.content),
      ).toEqual(
        wire === "earlier-citation"
          ? ["Synthetic source.\n\n[Second](https://example.test/second)", text]
          : ["Synthetic source.", text],
      );
    },
  );
  it("does not replace completed prose or attach sources from a stale terminal message", async () => {
    mode = "stale-citation";
    const { result } = await call();
    expect(result.content).toMatchObject([{ type: "text", text: "Synthetic source." }]);
  });
  it("renders page-controlled citation titles as literal Markdown, never extra links or HTML", async () => {
    mode = "citation-title";
    const { result } = await call();
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const tokens = new MarkdownIt({ html: true })
      .parse(text, {})
      .flatMap((token) => token.children ?? []);
    expect(
      tokens.filter((token) => token.type === "link_open").map((token) => token.attrGet("href")),
    ).toEqual(["https://example.test/source"]);
    expect(
      tokens.filter((token) => ["html_inline", "code_inline", "em_open"].includes(token.type)),
    ).toEqual([]);
    expect(
      tokens
        .filter((token) => token.type === "text")
        .map((token) => token.content)
        .join(""),
    ).toBe("Synthetic source.<https://other.test/> <img src=x> [label] `code` *bold*");
  });

  it.each([
    "openai/gpt-5.4",
    "openai/pricing-required",
    "openai/unknown",
    "openai/future",
    "openai/malformed",
    "openai/future-admission",
    "openai/wrong-offer",
  ])("keeps managed search for unsupported or unadmitted %s", async (id) => {
    mode = "terminal";
    const prepared = prepare({}, id);
    expect(resolveNativeWebSearchRoute(prepared.policy).kind).toBe("managed");
    expect(prepared.assembled.map((tool) => tool.name)).toEqual(["web_search", "read"]);
    const allowed = new Set<string>();
    expect(
      (await call(prepared, { openclawCodeModeAllowedHostedToolTypes: allowed })).result.stopReason,
    ).toBe("stop");
    expect(allowed.size).toBe(0);
    expect(requests.at(-1)?.body.tools).toMatchObject([
      { type: "function", name: "read" },
      { type: "function", name: "web_search" },
    ]);
  });
  it("keeps only admitted hosted search through the actual Code Mode egress guard", async () => {
    mode = "sse";
    const allowed = new Set<string>();
    const prepared = prepare();
    prepared.assembled = ["exec", "wait"].map(createTool);
    const { result } = await call(prepared, {
      openclawCodeModeToolSurface: true,
      openclawCodeModeAllowedHostedToolTypes: allowed,
      onPayload: (payload) => {
        const body = payload as { tools: unknown[] };
        body.tools.push({ type: "image_generation" });
      },
    });
    expect(result.stopReason).toBe("stop");
    expect(requests.at(-1)?.body.tools).toMatchObject([
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
      { type: "web_search" },
    ]);
    expect(allowed).toEqual(new Set(["web_search"]));
  });
  it("does not grant policy authority to an untrusted plugin claiming this provider", () => {
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "untrusted",
          providers: ["clawrouter"],
          origin: "config",
          rootDir: "/synthetic/untrusted",
        },
      ],
    });
    expect(
      resolveNativeWebSearchRoute({
        ...prepare({ plugins: { allow: ["untrusted"] } }).policy,
        pluginMetadataSnapshot: snapshot,
      }).kind,
    ).toBe("managed");
  });
  it("keeps one key's catalog admission out of another key's projection", () => {
    expect(catalogAuth).toEqual(["Bearer synthetic-admitted", "Bearer synthetic-denied"]);
    expect(resolveNativeWebSearchRoute(prepare({}, undefined, deniedCatalog).policy).kind).toBe(
      "managed",
    );
    expect(resolveNativeWebSearchRoute(prepare().policy).kind).toBe("native");
  });
  it.each([
    { tools: { web: { search: { enabled: false } } } },
    { tools: { web: { search: { provider: "brave" } } } },
    { agents: { entries: { fixture: { tools: { deny: ["web_search"] } } } } },
  ] satisfies OpenClawConfig[])(
    "honors configured disable, external provider and agent deny %#",
    async (config) => {
      mode = "terminal";
      const prepared = prepare(config);
      expect(resolveNativeWebSearchRoute(prepared.policy).kind).not.toBe("native");
      await call(prepared);
      expect(requests.at(-1)?.body.tools).not.toContainEqual({ type: "web_search" });
    },
  );
  it("honors sandbox tool policy and mismatched resolved route facts", () => {
    const { policy } = prepare();
    expect(
      resolveNativeWebSearchRoute({
        ...policy,
        sandboxToolPolicy: { allow: [], deny: ["web_search"] },
      }).kind,
    ).toBe("disabled");
    expect(
      resolveNativeWebSearchRoute({ ...policy, modelBaseUrl: "https://other.example/v1" }).kind,
    ).toBe("managed");
    expect(resolveNativeWebSearchRoute({ ...policy, modelApi: "openai-completions" }).kind).toBe(
      "managed",
    );
  });
  it.each(["reject", "stream-error", "json-failed", "json-invalid"] as const)(
    "surfaces %s without another route/key retry",
    async (failure) => {
      mode = failure;
      const before = requests.length;
      const { result } = await call();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain(
        failure === "reject"
          ? "ask your ClawRouter administrator"
          : failure === "json-invalid"
            ? "malformed event"
            : "Synthetic hosted search failed",
      );
      expect(requests).toHaveLength(before + 1);
      expect(requests.at(-1)?.authorization).toBe("Bearer synthetic-admitted");
      expect(requests.at(-1)?.body.tools).toContainEqual({ type: "web_search" });
    },
  );
  it("cancels the one admitted HTTP stream once", async () => {
    mode = "hold";
    held = createDeferred<ServerResponse>();
    closed = createDeferred();
    const controller = new AbortController();
    const before = requests.length;
    const pending = call(undefined, { signal: controller.signal });
    try {
      await Promise.race([
        held.promise,
        pending.then(() => {
          throw new Error("Completed before held HTTP response");
        }),
      ]);
      controller.abort();
      expect((await pending).result.stopReason).toBe("aborted");
      await closed.promise;
      expect(requests).toHaveLength(before + 1);
      expect(requests.at(-1)?.body.tools).toContainEqual({ type: "web_search" });
      expect(requests.at(-1)?.authorization).toBe("Bearer synthetic-admitted");
    } finally {
      controller.abort();
      server.listener.closeAllConnections();
      await pending;
    }
  });
});
