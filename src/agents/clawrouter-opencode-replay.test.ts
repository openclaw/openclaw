import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicResponse } from "../../packages/ai/src/provider-transport-parity.test-support.js";
import { createSseResponse } from "../../packages/ai/src/transports/anthropic-transport-stream.test-support.js";
import {
  completedResponse,
  outputItem,
  wireMessage,
} from "../../packages/ai/src/transports/openai-stream-cases.test-support.js";
import { streamSimple } from "../llm/stream.js";
import { registerSingleProviderPlugin } from "../plugin-sdk/plugin-test-runtime.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-live-runtime.js";
import * as catalogRuntime from "../plugin-sdk/provider-catalog-live-runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import {
  fixture,
  rawStream,
  routes,
  type Route,
} from "./clawrouter-opencode-session.test-support.js";
import type { StreamFn } from "./runtime/index.js";
import { completionContext } from "./simple-completion.test-support.js";
import "./ai-transport-runtime-host.js";

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function reasoningReply(route: Route) {
  if (route[2] === "openai-responses") {
    const reasoning = {
      type: "reasoning",
      id: "rs_saved",
      summary: [],
      encrypted_content: "synthetic-opaque-reasoning",
    };
    return createSseResponse([
      outputItem("added", reasoning),
      outputItem("done", reasoning),
      completedResponse("resp_saved", [reasoning, wireMessage("msg_saved", "Prior answer")]),
    ]);
  }
  return createAnthropicResponse([
    {
      type: "message_start",
      message: { id: "msg_saved", model: route[1], usage: { input_tokens: 2, output_tokens: 0 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Prior reasoning" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "synthetic-opaque-reasoning" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Prior answer" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

describe("qualified OpenCode replay and native thinking", () => {
  it.each(
    ["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3"].flatMap((upstream) =>
      [true, false].flatMap((native) =>
        (["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const).map((hook) => ({
          upstream,
          native,
          hook,
        })),
      ),
    ),
  )(
    "matches native Kimi replay policy: $upstream $native $hook",
    async ({ upstream, native, hook }) => {
      const route: Route = [
        "opencode-go",
        upstream,
        "openai-completions",
        "llm.chat",
        "chat_completions",
        "/chat/completions",
        "openai.chat_completions",
      ];
      const entry = await loadBundledPluginFacade<{
        default: Parameters<typeof registerSingleProviderPlugin>[0];
      }>({ pluginId: "opencode-go", artifactBasename: "index.js" });
      const nativePlugin = await registerSingleProviderPlugin(entry.default);
      await fixture(
        route,
        async ({ model, plugin, requests, expectedUrl }) => {
          const nativeModel = {
            ...model,
            id: upstream,
            provider: "opencode-go",
            baseUrl: "https://opencode.ai/inference/go/openai/v1",
          };
          for (const selected of [
            {
              name: "native Go",
              plugin: nativePlugin,
              model: nativeModel,
              url: nativeModel.baseUrl + "/chat/completions",
              wireModel: upstream,
            },
            {
              name: "ClawRouter",
              plugin,
              model,
              url: expectedUrl,
              wireModel: native ? upstream : model.id,
            },
          ]) {
            const stream = selected.plugin[hook]!({
              provider: selected.model.provider,
              modelId: selected.model.id,
              model: selected.model,
              streamFn: hook === "wrapStreamFn" ? rawStream : streamSimple,
            })!;
            const options = { apiKey: "synthetic-router-key", cacheRetention: "none" as const };
            const first = await (
              await stream(selected.model, completionContext("First"), options)
            ).result();
            expect(first.stopReason, first.errorMessage).toBe("stop");
            expect(first.model).toBe(selected.model.id);
            expect(first.content).toContainEqual(
              expect.objectContaining({
                type: "thinking",
                thinking: "Synthetic replay reasoning",
              }),
            );
            const context = {
              messages: [first, { role: "user" as const, content: "Continue", timestamp: 2 }],
            };
            const original = structuredClone(context);
            const second = await (await stream(selected.model, context, options)).result();
            expect(second.stopReason, second.errorMessage).toBe("stop");
            expect(context).toEqual(original);
            const request = requests.at(-1)!;
            expect(request.url).toBe(selected.url);
            expect(request.headers.get("authorization")).toBe("Bearer synthetic-router-key");
            const body = await request.json();
            expect(body.model).toBe(selected.wireModel);
            const replay = body.messages.find(
              (message: { role: string }) => message.role === "assistant",
            );
            expect(replay).toMatchObject({ role: "assistant", content: "Prior answer" });
            if (upstream === "kimi-k3") {
              expect(replay, selected.name).toHaveProperty(
                "reasoning_content",
                "Synthetic replay reasoning",
              );
            } else {
              expect(replay, selected.name).not.toHaveProperty("reasoning_content");
            }
          }
          expect(requests).toHaveLength(4);
        },
        {
          native,
          respond: () =>
            new Response(
              `data: ${JSON.stringify({
                id: "k2-replay",
                object: "chat.completion.chunk",
                model: upstream,
                choices: [
                  {
                    index: 0,
                    delta: {
                      reasoning_content: "Synthetic replay reasoning",
                      content: "Prior answer",
                    },
                    finish_reason: "stop",
                  },
                ],
              })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
        },
      );
    },
  );

  it.each([
    { provider: "opencode-go", upstream: "kimi-k2.5", api: "openai-completions", strip: true },
    { provider: "opencode-go", upstream: "kimi-k2.6", api: "openai-completions", strip: true },
    { provider: "opencode-go", upstream: "kimi-k2.7-code", api: "openai-completions", strip: true },
    { provider: "opencode-go", upstream: "kimi-k3", api: "openai-completions", strip: false },
    { provider: "opencode", upstream: "kimi-k2.7-code", api: "openai-completions", strip: false },
    { provider: "opencode-go", upstream: "future-kimi", api: "openai-completions", strip: false },
    { provider: "opencode-go", upstream: "kimi-k2.7-code", api: "openai-responses", strip: false },
  ] as const)(
    "bounds replay sanitation to $provider $upstream $api",
    async ({ provider, upstream, api, strip }) => {
      const chat = api === "openai-completions";
      const route: Route = [
        provider,
        upstream,
        api,
        chat ? "llm.chat" : "llm.responses",
        chat ? "chat_completions" : "responses",
        chat ? "/chat/completions" : "/responses",
        chat ? "openai.chat_completions" : "openai.responses",
      ];
      for (const native of [true, false]) {
        await fixture(
          route,
          async ({ model, plugin, requests }) => {
            for (const hook of ["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const) {
              const stream = plugin[hook]!({
                provider: "clawrouter",
                modelId: model.id,
                model,
                streamFn: hook === "wrapStreamFn" ? rawStream : streamSimple,
              })!;
              const controls = {
                reasoning_content: "synthetic",
                reasoning_details: [],
                reasoning: { effort: "high" },
                reasoning_text: "synthetic",
                reasoning_effort: "high",
                reasoningEffort: "high",
                messages: [
                  {
                    role: "assistant",
                    content: [{ type: "thinking", thinking: "synthetic" }],
                    reasoning_content: "synthetic",
                  },
                ],
                input: [
                  { type: "reasoning", summary: [] },
                  { role: "assistant", content: "visible", reasoning_details: [] },
                ],
              };
              const original = structuredClone(controls);
              const result = await (
                await stream(model, completionContext("Continue"), {
                  apiKey: "synthetic-router-key",
                  cacheRetention: "none",
                  onPayload: (payload) => ({ ...payload, ...structuredClone(controls) }),
                })
              ).result();
              expect(result.stopReason, result.errorMessage).toBe("stop");
              const body = await requests.at(-1)!.json();
              expect(controls).toEqual(original);
              if (strip) {
                for (const key of [
                  "reasoning_content",
                  "reasoning_details",
                  "reasoning",
                  "reasoning_text",
                  "reasoning_effort",
                  "reasoningEffort",
                ]) {
                  expect(body).not.toHaveProperty(key);
                }
                expect(body.messages).toEqual([
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "[assistant reasoning omitted]" }],
                  },
                ]);
                expect(body.input).toEqual([{ role: "assistant", content: "visible" }]);
              } else {
                expect(body).toMatchObject(original);
              }
            }
            expect(requests).toHaveLength(2);
          },
          { native },
        );
      }
    },
  );

  it.each([
    { route: routes[2], native: true },
    { route: routes[2], native: false },
    { route: routes[3], native: true },
    { route: routes[3], native: false },
    { route: routes[4], native: true },
    { route: routes[5], native: true },
  ])(
    "replays only the selected identity without mutating history: $route $native",
    async ({ route, native }) => {
      await fixture(
        route,
        async ({ model, plugin, requests, expectedUrl }) => {
          for (const hook of ["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const) {
            let observed: Parameters<StreamFn>[1] | undefined;
            const underlying = hook === "wrapStreamFn" ? rawStream : streamSimple;
            const delegate: StreamFn = (selected, context, options) => {
              observed = context;
              return underlying(selected, context, options);
            };
            const stream = plugin[hook]!({
              provider: "clawrouter",
              modelId: model.id,
              model,
              streamFn: delegate,
            })!;
            const options = {
              apiKey: "synthetic-router-key",
              cacheRetention: "none" as const,
              reasoning: "low" as const,
              thinkingBudgets: { low: 1024 },
              thinkingEnabled: true,
              thinkingBudgetTokens: 1024,
            };
            const first = await (await stream(model, completionContext("First"), options)).result();
            expect(first.stopReason, first.errorMessage).toBe("stop");
            expect(first.model).toBe(model.id);
            expect(JSON.stringify(first.content)).toContain("synthetic-opaque-reasoning");
            const context = {
              ...completionContext("First"),
              messages: [first, { role: "user" as const, content: "Continue", timestamp: 2 }],
            };
            const original = structuredClone(context);
            const second = await (await stream(model, context, options)).result();
            expect(second.stopReason, second.errorMessage).toBe("stop");
            const request = requests.at(-1)!;
            expect(request.url).toBe(expectedUrl);
            expect(request.headers.get("authorization")).toBe("Bearer synthetic-router-key");
            const body = await request.json();
            expect(body.model).toBe(native ? route[1] : model.id);
            expect(JSON.stringify(body)).toContain("synthetic-opaque-reasoning");
            expect(context).toEqual(original);
            expect(observed?.messages[0]).toEqual({
              ...first,
              role: "assistant",
              model: native ? route[1] : model.id,
            });
            for (const patch of [
              { model: "foreign-model" },
              { provider: "foreign-provider" },
              { api: "foreign-api" },
            ]) {
              const foreign = structuredClone(context);
              Object.assign(foreign.messages[0]!, patch);
              const before = structuredClone(foreign);
              await (await stream(model, foreign, options)).result();
              const foreignBody = await requests.at(-1)!.json();
              // The native Claude contract may preserve a concrete responseModel across
              // compatible Claude aliases; this wrapper must not weaken that policy.
              if (route[2] !== "anthropic-messages") {
                expect(JSON.stringify(foreignBody)).not.toContain("synthetic-opaque-reasoning");
              }
              expect(foreign).toEqual(before);
              expect(observed?.messages[0]).toEqual(before.messages[0]);
            }
          }
          expect(requests).toHaveLength(10);
        },
        { native, respond: () => reasoningReply(route) },
      );
    },
  );

  it.each(["deepseek-v4-flash", "deepseek-v4.1-flash"])(
    "uses native Flash thinking and replay for %s",
    async (upstream) => {
      const route: Route = [
        "opencode-go",
        upstream,
        "openai-completions",
        "llm.chat",
        "chat_completions",
        "/chat/completions",
        "openai.chat_completions",
      ];
      for (const native of [true, false]) {
        await fixture(
          route,
          async ({ model, plugin, requests }) => {
            for (const hook of ["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const) {
              for (const [configured, requested, effort] of [
                ["high", "low", "low"],
                ["off", "max", "max"],
                ["off", "xhigh", "high"],
                ["off", "medium", "high"],
                ["high", "off", undefined],
                ["high", "none", undefined],
                ["low", undefined, "low"],
              ] as const) {
                const stream = plugin[hook]!({
                  provider: "clawrouter",
                  modelId: model.id,
                  model,
                  streamFn: hook === "wrapStreamFn" ? rawStream : streamSimple,
                  thinkingLevel: configured,
                })!;
                const options = {
                  apiKey: "synthetic-router-key",
                  onPayload: (payload: unknown) => ({
                    // SAFETY: The actual Chat transport supplies its constructed JSON request object.
                    ...(payload as Record<string, unknown>),
                    messages: [
                      {
                        role: "assistant",
                        content: "Prior answer",
                        reasoning_content: "Prior reasoning",
                      },
                      { role: "assistant", content: "No reasoning" },
                      { role: "user", content: "Continue" },
                    ],
                  }),
                };
                if (requested !== undefined) {
                  Object.assign(options, { reasoning: requested });
                }
                const result = await (
                  await stream(model, completionContext("Think"), options)
                ).result();
                expect(result.stopReason, result.errorMessage).toBe("stop");
                const body = await requests.at(-1)!.json();
                expect(body).toMatchObject({
                  model: native ? upstream : model.id,
                  thinking: { type: effort ? "enabled" : "disabled" },
                });
                expect(body.reasoning_effort).toBe(effort);
                expect(body.messages[0].reasoning_content).toBe(
                  effort ? "Prior reasoning" : undefined,
                );
                expect(body.messages[1].reasoning_content).toBe(effort ? "" : undefined);
              }
            }
            expect(requests).toHaveLength(14);
          },
          { native },
        );
        clearLiveCatalogCacheForTests();
      }
    },
  );

  it("admits the exact bundled Qwen reasoning fact through its selected offer", async () => {
    await fixture(routes[5], async ({ model, plugin, requests }) => {
      expect(model.reasoning).toBe(true);
      const stream = plugin.wrapSimpleCompletionStreamFn!({
        provider: "clawrouter",
        modelId: model.id,
        model,
        streamFn: streamSimple,
      })!;
      const result = await (
        await stream(model, completionContext("Think"), {
          apiKey: "synthetic-router-key",
          reasoning: "low",
          thinkingBudgets: { low: 1024 },
        })
      ).result();
      expect(result.stopReason, result.errorMessage).toBe("stop");
      expect(await requests[0]!.json()).toMatchObject({
        model: "qwen3.8-max",
        thinking: { type: "enabled", budget_tokens: 1024 },
      });
    });
  });

  it.each([
    [
      "opencode",
      "qwen3.8-max",
      "anthropic-messages",
      "llm.messages",
      "messages",
      "/v1/messages",
      "anthropic.messages",
    ],
    [
      "opencode-go",
      "qwen3.8-max",
      "openai-completions",
      "llm.chat",
      "chat_completions",
      "/chat/completions",
      "openai.chat_completions",
    ],
    [
      "opencode-go",
      "Qwen3.8-Max",
      "anthropic-messages",
      "llm.messages",
      "messages",
      "/v1/messages",
      "anthropic.messages",
    ],
    [
      "opencode-go",
      "qwen3.8-max-latest",
      "anthropic-messages",
      "llm.messages",
      "messages",
      "/v1/messages",
      "anthropic.messages",
    ],
    [
      "opencode-go",
      "qwen-future",
      "anthropic-messages",
      "llm.messages",
      "messages",
      "/v1/messages",
      "anthropic.messages",
    ],
  ] satisfies Route[])(
    "does not infer a native reasoning fact across %s %s %s",
    async (...route) => {
      await fixture(route, async ({ model }) => expect(model.reasoning).toBe(false));
    },
  );

  it.each([
    { providerPatch: { offers: [] } },
    { offerPatch: { eligible: false } },
    { offerPatch: { modelId: "opencode-go/foreign" } },
    { modelPatch: { upstream: "foreign" } },
    { routePatch: { responseFormat: "unknown" } },
  ])("does not admit Qwen through an absent or mismatched offer: %j", async (patch) => {
    await fixture(routes[5], async () => {}, { ...patch, missing: true });
  });

  it("rejects ambiguous Qwen endpoint declarations", async () => {
    await fixture(routes[5], async () => {}, {
      missing: true,
      providerPatch: {
        routes: ["messages", "other_messages"].map((endpoint) => ({
          endpoint,
          path: "/v1/messages",
          methods: ["POST"],
          requestFormat: "anthropic.messages",
          responseFormat: "anthropic.messages",
        })),
        offers: ["messages", "other_messages"].map((endpoint) => ({
          endpoint,
          modelId: "opencode-go/qwen3.8-max",
          transport: "http",
          routeKind: "native",
          route: "/v1/native/opencode-go/v1/messages",
          eligible: true,
          affordability: "request-dependent",
        })),
      },
    });
  });

  it("keeps explicit native false below catalog effort metadata and outside unrelated routes", async () => {
    // Supply a false native fact at the existing resolver seam. The real bundled
    // Qwen positive above independently exercises the actual manifest loader.
    vi.spyOn(catalogRuntime, "loadBundledModelIdentityFactsResolver").mockResolvedValue(() => ({
      reasoning: false,
    }));
    await fixture(routes[1], async ({ model }) => expect(model.reasoning).toBe(false));
    clearLiveCatalogCacheForTests();
    await fixture(
      routes[1],
      async ({ model }) => {
        expect(model.reasoning).toBe(true);
        expect(model.compat).toMatchObject({ supportedReasoningEfforts: ["low"] });
      },
      { modelPatch: { supportedReasoningEfforts: ["low"] } },
    );
    clearLiveCatalogCacheForTests();
    await fixture(routes[0], async ({ model }) => expect(model.reasoning).toBe(true), {
      providerPatch: { id: "unrelated" },
    });
  });
});
