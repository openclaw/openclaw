import { getAiTransportHost } from "@openclaw/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicResponse } from "../../packages/ai/src/provider-transport-parity.test-support.js";
import { createSseResponse } from "../../packages/ai/src/transports/anthropic-transport-stream.test-support.js";
import {
  completedResponse,
  wireMessage,
} from "../../packages/ai/src/transports/openai-stream-cases.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { streamSimple } from "../llm/stream.js";
import type { Model, SimpleStreamOptions } from "../llm/types.js";
import { registerSingleProviderPlugin } from "../plugin-sdk/plugin-test-runtime.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-live-runtime.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeInMemorySessionManager } from "./embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "./embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "./runtime/index.js";
import { convertToLlm } from "./sessions/messages.js";
import { completionChunk, completionContext } from "./simple-completion.test-support.js";
import "./ai-transport-runtime-host.js";
import { resolveTranscriptPolicy } from "./transcript-policy.js";
import { makeZeroUsageSnapshot } from "./usage.js";

const routes = [
  [
    "opencode",
    "minimax-m3",
    "openai-completions",
    "llm.chat",
    "chat_completions",
    "/chat/completions",
    "openai.chat_completions",
  ],
  [
    "opencode-go",
    "deepseek-v4-pro",
    "openai-completions",
    "llm.chat",
    "chat_completions",
    "/chat/completions",
    "openai.chat_completions",
  ],
  [
    "opencode",
    "gpt-5.6-sol",
    "openai-responses",
    "llm.responses",
    "responses",
    "/v1/responses",
    "openai.responses",
  ],
  [
    "opencode-go",
    "gpt-5.6-luna",
    "openai-responses",
    "llm.responses",
    "responses",
    "/v1/responses",
    "openai.responses",
  ],
  [
    "opencode",
    "claude-opus-5",
    "anthropic-messages",
    "llm.messages",
    "messages",
    "/v1/messages",
    "anthropic.messages",
  ],
  [
    "opencode-go",
    "qwen3.8-max",
    "anthropic-messages",
    "llm.messages",
    "messages",
    "/v1/messages",
    "anthropic.messages",
  ],
] as const;
type Route = readonly [
  (typeof routes)[number][0],
  string,
  (typeof routes)[number][2],
  string,
  string,
  string,
  string,
];

function reply(route: Route) {
  if (route[2] === "openai-completions") {
    return new Response(completionChunk("ok", route[1]), {
      headers: { "content-type": "text/event-stream" },
    });
  }
  if (route[2] === "openai-responses") {
    return createSseResponse([
      completedResponse("resp_fixture", [wireMessage("msg_fixture", "ok")]),
    ]);
  }
  return createAnthropicResponse([
    {
      type: "message_start",
      message: { id: "msg_fixture", model: route[1], usage: { input_tokens: 2, output_tokens: 0 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(
  route: Route,
  run: (value: {
    model: Model;
    plugin: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
    requests: Request[];
    catalogKeys: Array<string | null>;
    expectedUrl: string;
  }) => Promise<void>,
  options: {
    native?: boolean;
    missing?: boolean;
    providerPatch?: Record<string, unknown>;
    offerPatch?: Record<string, unknown>;
    modelPatch?: Record<string, unknown>;
    routePatch?: Record<string, unknown>;
  } = {},
) {
  const [upstreamProvider, upstream, api, capability, endpoint, path, format] = route;
  const id = upstreamProvider + "/" + upstream;
  const native = options.native ?? api === "anthropic-messages";
  const publicPath = native
    ? `/v1/native/${upstreamProvider}${path}`
    : api === "openai-completions"
      ? "/v1/chat/completions"
      : "/v1/responses";
  const requests: Request[] = [],
    catalogKeys: Array<string | null> = [];
  vi.stubEnv("OPENCODE_API_KEY", "synthetic-vendor-must-not-win");
  vi.stubEnv("OPENCODE_GO_API_KEY", "synthetic-go-must-not-win");
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-must-not-win");
  vi.stubEnv("CLAWROUTER_API_KEY", "");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/v1/catalog")) {
      catalogKeys.push(request.headers.get("authorization"));
      return Response.json({
        version: "clawrouter.client-catalog.v1",
        providers: [
          {
            id: upstreamProvider,
            displayName: upstreamProvider,
            allowed: true,
            executable: true,
            openaiCompatible: true,
            nativeBaseUrl: `/v1/native/${upstreamProvider}`,
            routes: [
              {
                endpoint,
                path,
                methods: ["POST"],
                requestFormat: format,
                responseFormat: format,
                ...options.routePatch,
              },
            ],
            models: [{ id, upstream, capabilities: [capability], ...options.modelPatch }],
            offers: [
              {
                endpoint,
                modelId: id,
                transport: "http",
                routeKind: native ? "native" : "unified",
                route: publicPath,
                eligible: true,
                affordability: "request-dependent",
                ...options.offerPatch,
              },
            ],
            ...options.providerPatch,
          },
        ],
      });
    }
    requests.push(request);
    if (request.headers.get("authorization") !== "Bearer synthetic-router-key") {
      return Response.json(
        { error: { type: "permission_error", message: "Synthetic foreign grant" } },
        { status: 403 },
      );
    }
    return reply(route);
  });
  const entry = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  const plugin = await registerSingleProviderPlugin(entry.default);
  await withOpenClawTestState({ label: "clawrouter-opencode-session" }, async (state) => {
    const config = {
      models: {
        providers: {
          clawrouter: {
            apiKey: "synthetic-router-key",
            baseUrl: "https://clawrouter.openclaw.ai/tenant/v1",
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = await plugin.catalog?.run({
      config,
      env: {},
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      resolveProviderAuth: () => ({
        apiKey: "synthetic-router-key",
        discoveryApiKey: "synthetic-router-key",
        mode: "api_key",
        source: "profile",
      }),
      resolveProviderApiKey: () => ({
        apiKey: "synthetic-router-key",
        discoveryApiKey: "synthetic-router-key",
      }),
    });
    if (!result || !("provider" in result) || !result.provider) {
      throw new Error("Missing actual ClawRouter catalog");
    }
    const selected = result.provider.models.find((model) => model.id === id);
    if (options.missing) {
      expect(selected).toBeUndefined();
      expect(requests).toHaveLength(0);
      return;
    }
    if (!selected || selected.api !== api || !selected.baseUrl) {
      throw new Error("Missing selected OpenCode route");
    }
    const model: Model = {
      ...selected,
      provider: "clawrouter",
      api,
      baseUrl: selected.baseUrl,
      input: ["text"],
    };
    await run({
      model,
      plugin,
      requests,
      catalogKeys,
      expectedUrl: "https://clawrouter.openclaw.ai/tenant" + publicPath,
    });
  });
}

describe("actual OpenCode proxy SDK session bridge", () => {
  it.each([
    { providerPatch: { offers: [] } },
    { providerPatch: { allowed: false } },
    { offerPatch: { eligible: false } },
    { offerPatch: { route: "https://foreign.example/v1/chat/completions" } },
    { modelPatch: { capabilities: ["llm.embeddings"] } },
    { modelPatch: { upstream: "foreign-model" } },
    { routePatch: { methods: ["GET"] } },
    { routePatch: { responseFormat: "unknown.stream" } },
  ])("does not infer OpenCode execution from broad provider flags: %j", async (patch) => {
    await fixture(routes[0], async () => {}, { ...patch, missing: true });
  });

  it("rejects conflicting static and caller identities before any SDK request", async () => {
    await fixture(routes[0], async ({ model, plugin, requests }) => {
      const stream = plugin.wrapStreamFn!({
        provider: "clawrouter",
        modelId: model.id,
        streamFn: streamSimple,
      })!;
      for (const [modelHeaders, callerHeaders] of [
        [{ "X-OpenCode-Session": "one" }, { "x-opencode-session": "two" }],
        [{ "x-clawrouter-session-id": "other-conversation" }, {}],
        [{}, { "x-clawrouter-session-id": "other-conversation" }],
      ]) {
        expect(() =>
          stream({ ...model, headers: modelHeaders }, completionContext("ok"), {
            apiKey: "synthetic-router-key",
            sessionId: "conversation",
            headers: callerHeaders,
          }),
        ).toThrow("Conflicting");
      }
      expect(requests).toHaveLength(0);
    });
  });

  it.each(routes)("keeps %s %s conversations stable through %s", async (...route) => {
    await fixture(route, async ({ model, plugin, requests, catalogKeys, expectedUrl }) => {
      for (const hook of ["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const) {
        const stream = plugin[hook]?.({
          provider: "clawrouter",
          modelId: model.id,
          model,
          streamFn: streamSimple,
        });
        if (!stream) {
          throw new Error("Missing actual provider hook");
        }
        for (const explicit of [false, true]) {
          const context: Parameters<typeof streamSimple>[1] = completionContext("Reply ok");
          const selected = {
            ...model,
            headers: {
              ...(explicit ? { "X-OpenCode-Session": "caller-session" } : {}),
              "x-clawrouter-session-id": explicit ? "caller-session" : "conversation-123",
            },
          };

          const options: SimpleStreamOptions = {
            apiKey: "synthetic-router-key",
            sessionId: "conversation-123",
            cacheRetention: "none",
            headers: {
              "User-Agent": "fixture-client/1",
              ...(explicit ? { "x-OpEnCoDe-SeSsIoN": "caller-session" } : {}),
            },
          };
          for (let turn = 0; turn < 2; turn++) {
            const result = await (await stream(selected, context, options)).result();
            expect(result.stopReason, result.errorMessage).toBe("stop");
            expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "ok" })]);
            context.messages.push(result, { role: "user", content: "Again", timestamp: turn + 2 });
          }
        }
      }
      const modelOnly = plugin.wrapStreamFn!({
        provider: "clawrouter",
        modelId: model.id,
        streamFn: streamSimple,
      })!;
      expect(
        (
          await (
            await modelOnly(
              { ...model, headers: { "X-OpenCode-Session": "model-only" } },
              completionContext("ok"),
              {
                apiKey: "synthetic-router-key",
                sessionId: "automatic-must-not-win",
                cacheRetention: "none",
              },
            )
          ).result()
        ).stopReason,
      ).toBe("stop");
      expect(catalogKeys).toEqual(["Bearer synthetic-router-key"]);
      expect(requests).toHaveLength(9);
      for (const [index, request] of requests.entries()) {
        expect(request.url).toBe(expectedUrl);
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-router-key");
        expect(request.headers.get("x-clawrouter-client")).toBe("openclaw");
        expect(request.headers.get("x-clawrouter-session-id")).toBe(
          index === 8 ? "model-only" : index % 4 >= 2 ? "caller-session" : "conversation-123",
        );
        expect(request.headers.get("x-opencode-session")).toBeNull();
        expect(request.headers.get("user-agent")).not.toMatch(/opencode/i);
        expect(JSON.stringify([...request.headers])).not.toContain("must-not-win");
        expect(JSON.stringify(await request.json())).not.toMatch(
          /"(?:prompt_cache_key|cachedContent|cache_control)"/,
        );
      }
    });
  });

  it.each([routes[0], routes[1]])(
    "isolates standalone %s calls using the actual turn hook",
    async (...route) => {
      await fixture(route, async ({ model, plugin, requests }) => {
        const stream = plugin.wrapStreamFn!({
          provider: "clawrouter",
          modelId: model.id,
          model,
          streamFn: streamSimple,
        })!;
        for (const turnId of ["turn-one", "turn-two"]) {
          const state = plugin.resolveTransportTurnState?.({
            provider: "clawrouter",
            modelId: model.id,
            model,
            turnId,
            attempt: 0,
            transport: "stream",
          });
          const result = await (
            await stream(model, completionContext("ok"), {
              apiKey: "synthetic-router-key",
              headers: state?.headers,
            })
          ).result();
          expect(result.stopReason, result.errorMessage).toBe("stop");
        }
        expect(requests.map((request) => request.headers.get("x-clawrouter-session-id"))).toEqual(
          route[0] === "opencode-go" ? ["turn-one", "turn-two"] : [null, null],
        );
        expect(requests.every((request) => !request.headers.has("x-opencode-session"))).toBe(true);
      });
    },
  );

  it("denies malformed identities before the actual SDK can dispatch", async () => {
    await fixture(routes[0], async ({ model, plugin, requests }) => {
      const stream = plugin.wrapStreamFn!({
        provider: "clawrouter",
        modelId: model.id,
        streamFn: streamSimple,
      })!;
      for (const identity of ["", " ", "two words", "bad\\nheader", "非ASCII", "a".repeat(257)]) {
        expect(() =>
          stream(model, completionContext("ok"), {
            apiKey: "synthetic-router-key",
            sessionId: "must-not-fallback",
            headers: { "X-OpenCode-Session": identity },
          }),
        ).toThrow("ASCII attribution");
      }
      expect(() =>
        stream(model, completionContext("ok"), {
          headers: { "X-OpenCode-Session": "one", "x-opencode-session": "two" },
        }),
      ).toThrow("Conflicting");
      expect(requests).toHaveLength(0);
    });
  });

  it.each(routes)(
    "retains the selected %s %s owner through native %s projection",
    async (...route) => {
      await fixture(
        route,
        async ({ model, plugin, requests, expectedUrl }) => {
          const prepared = attachModelProviderRuntimePluginHandle(model, {
            provider: "clawrouter",
            modelId: model.id,
            plugin,
          });
          const host = getAiTransportHost();
          const projected = host.inheritManagedTransport(prepared, { ...prepared });
          const state = host.plugin.resolveTransportTurnState({
            provider: "clawrouter",
            modelId: model.id,
            allowRuntimePluginLoad: false,
            context: {
              provider: "clawrouter",
              modelId: model.id,
              model: projected,
              sessionId: "native-conversation",
              turnId: "turn-one",
              attempt: 0,
              transport: "stream",
            },
          });
          const stream = host.plugin.wrapSimpleCompletionStream({
            provider: "clawrouter",
            context: {
              provider: "clawrouter",
              modelId: model.id,
              model: projected,
              streamFn: streamSimple,
            },
          });
          if (!stream) {
            throw new Error("Missing actual prepared ClawRouter stream");
          }
          const aborted = await (
            await stream(projected, completionContext("ok"), {
              apiKey: "synthetic-router-key",
              signal: AbortSignal.abort(new Error("synthetic caller abort")),
              headers: state?.headers,
            })
          ).result();
          expect(aborted.stopReason).not.toBe("stop");
          expect(requests).toHaveLength(0);
          const result = await (
            await stream(projected, completionContext("ok"), {
              apiKey: "synthetic-router-key",
              headers: state?.headers,
              cacheRetention: "none",
            })
          ).result();
          expect(result.stopReason, result.errorMessage).toBe("stop");
          expect(requests).toHaveLength(1);
          expect(requests[0]?.url).toBe(expectedUrl);
          expect(requests[0]?.headers.get("x-clawrouter-session-id")).toBe("native-conversation");
          expect(requests[0]?.headers.get("x-opencode-session")).toBeNull();
          expect(requests[0]?.headers.get("authorization")).toBe("Bearer synthetic-router-key");
          expect((await requests[0]!.json()).model).toBe(route[1]);
        },
        { native: true },
      );
    },
  );

  it("encodes automatic conversation identities without merging distinct sessions", async () => {
    await fixture(routes[0], async ({ model, plugin, requests }) => {
      const stream = plugin.wrapStreamFn!({
        provider: "clawrouter",
        modelId: model.id,
        streamFn: streamSimple,
      })!;
      const identities = ["conversation with spaces", "会話", "a".repeat(300), "\ud800", "\ud801"];
      for (const sessionId of [...identities, ...identities]) {
        expect(
          (
            await (
              await stream(model, completionContext("ok"), {
                apiKey: "synthetic-router-key",
                sessionId,
              })
            ).result()
          ).stopReason,
        ).toBe("stop");
      }
      const sent = requests.map((request) => request.headers.get("x-clawrouter-session-id"));
      expect(sent.slice(0, identities.length)).toEqual(sent.slice(identities.length));
      expect(new Set(sent).size).toBe(identities.length);
      expect(sent.every((value) => value && /^[A-Za-z0-9._~:/+@=-]{1,256}$/u.test(value))).toBe(
        true,
      );
      await (
        await stream(model, completionContext("ok"), {
          apiKey: "synthetic-router-key",
          sessionId: sent[0]!,
        })
      ).result();
      expect(requests.at(-1)?.headers.get("x-clawrouter-session-id")).not.toBe(sent[0]);
    });
  });

  it("preserves signed Messages thinking and tool results through actual replay and SDK conversion", async () => {
    await fixture(routes[4], async ({ model, plugin, requests }) => {
      const history: AgentMessage[] = [
        { role: "user", content: "Look up a record", timestamp: 1 },
        {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [
            {
              type: "thinking",
              thinking: "Use the lookup tool",
              thinkingSignature: "synthetic-signature",
            },
            { type: "toolCall", id: "toolu_fixture", name: "lookup", arguments: { index: 1 } },
          ],
          usage: makeZeroUsageSnapshot(),
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "toolu_fixture",
          toolName: "lookup",
          content: [{ type: "text", text: "synthetic record" }],
          isError: false,
          timestamp: 3,
        },
      ];
      const replay = await sanitizeSessionHistory({
        provider: "clawrouter",
        modelId: model.id,
        modelApi: model.api,
        model,
        policy: resolveTranscriptPolicy({
          provider: "clawrouter",
          modelId: model.id,
          modelApi: model.api,
          model,
          runtimeHandle: { provider: "clawrouter", plugin },
        }),
        config: {},
        env: {},
        sessionId: "tool-conversation",
        sessionManager: makeInMemorySessionManager([]),
        messages: history,
      });
      const context = {
        messages: convertToLlm(replay),
        tools: [
          {
            name: "lookup",
            description: "Synthetic record lookup",
            parameters: { type: "object", properties: { index: { type: "integer" } } },
          },
        ],
      };
      for (const hook of ["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const) {
        const stream = plugin[hook]!({
          provider: "clawrouter",
          modelId: model.id,
          model,
          streamFn: streamSimple,
        })!;
        const result = await (
          await stream(model, context, {
            apiKey: "synthetic-router-key",
            sessionId: "tool-conversation",
            maxTokens: 100,
          })
        ).result();
        expect(result.stopReason, result.errorMessage).toBe("stop");
      }
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.headers.get("x-clawrouter-session-id")).toBe("tool-conversation");
        expect((await request.json()).messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              content: expect.arrayContaining([
                {
                  type: "thinking",
                  thinking: "Use the lookup tool",
                  signature: "synthetic-signature",
                },
                { type: "tool_use", id: "toolu_fixture", name: "lookup", input: { index: 1 } },
              ]),
            }),
            expect.objectContaining({
              role: "user",
              content: expect.arrayContaining([
                expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_fixture" }),
              ]),
            }),
          ]),
        );
      }
    });
  });

  it("denies unqualified Gemini and mismatched catalog routes before dispatch", async () => {
    await fixture(routes[0], async ({ model, plugin, requests }) => {
      const stream = plugin.wrapStreamFn!({
        provider: "clawrouter",
        modelId: model.id,
        streamFn: streamSimple,
      })!;
      const unqualifiedGemini = {
        ...model,
        id: "opencode/gemini-3.6-flash",
        api: "google-generative-ai" as const,
        params: { clawrouterRoute: { api: "google-generative-ai", baseUrl: model.baseUrl } },
      };
      expect(() =>
        stream(unqualifiedGemini, completionContext("ok"), {
          apiKey: "synthetic-router-key",
        }),
      ).toThrow("qualified Chat");
      expect(() =>
        stream({ ...model, baseUrl: "https://foreign.example/v1" }, completionContext("ok"), {
          apiKey: "synthetic-router-key",
        }),
      ).toThrow("qualified Chat");
      expect(requests).toHaveLength(0);
      const boundary = "a".repeat(256);
      expect(
        (
          await (
            await stream(model, completionContext("ok"), {
              apiKey: "synthetic-router-key",
              sessionId: boundary,
            })
          ).result()
        ).stopReason,
      ).toBe("stop");
      expect(requests[0]?.headers.get("x-clawrouter-session-id")).toBe(boundary);
    });
  });

  it.each([routes[0], routes[2], routes[4]])(
    "preserves foreign-grant denial on %s %s",
    async (...route) => {
      await fixture(route, async ({ model, plugin, requests }) => {
        const stream = plugin.wrapStreamFn!({
          provider: "clawrouter",
          modelId: model.id,
          streamFn: streamSimple,
        })!;
        const missing = await (await stream(model, completionContext("ok"), {})).result();
        expect(missing.stopReason).toBe("error");
        expect(requests).toHaveLength(0);
        for (const key of ["synthetic-router-key", "synthetic-foreign-grant"]) {
          const result = await (
            await stream(model, completionContext("ok"), {
              apiKey: key,
              sessionId: "same-conversation",
            })
          ).result();
          expect(result.stopReason).toBe(key === "synthetic-router-key" ? "stop" : "error");
        }
        expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
          "Bearer synthetic-router-key",
          "Bearer synthetic-foreign-grant",
        ]);
        expect(
          requests.every(
            (request) =>
              request.headers.get("x-clawrouter-session-id") === "same-conversation" &&
              !request.headers.has("x-opencode-session"),
          ),
        ).toBe(true);
      });
    },
  );
});
