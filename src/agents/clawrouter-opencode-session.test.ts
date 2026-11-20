import { getAiTransportHost } from "@openclaw/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseResponse } from "../../packages/ai/src/transports/anthropic-transport-stream.test-support.js";
import {
  argumentDelta,
  completedResponse,
  outputItem,
  wireCall,
} from "../../packages/ai/src/transports/openai-stream-cases.test-support.js";
import { withinTest } from "../../test/helpers/promise.js";
import { streamSimple } from "../llm/stream.js";
import type { SimpleStreamOptions } from "../llm/types.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-live-runtime.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { routes, fixture, rawStream } from "./clawrouter-opencode-session.test-support.js";
import { makeInMemorySessionManager } from "./embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "./embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "./runtime/index.js";
import { convertToLlm } from "./sessions/messages.js";
import { completionContext } from "./simple-completion.test-support.js";
import "./ai-transport-runtime-host.js";
import { resolveTranscriptPolicy } from "./transcript-policy.js";
import { makeZeroUsageSnapshot } from "./usage.js";

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("actual OpenCode proxy SDK session bridge", () => {
  it.each([true, false])("restores Console Responses tools through native=%s", async (native) => {
    await fixture(
      routes[2],
      async ({ model, plugin, requests, expectedUrl }) => {
        for (const hook of ["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const) {
          const stream = plugin[hook]!({
            provider: "clawrouter",
            modelId: model.id,
            model,
            streamFn: hook === "wrapStreamFn" ? rawStream : streamSimple,
          })!;
          const context: Parameters<typeof streamSimple>[1] = {
            ...completionContext("Search"),
            tools: ["web_search", "openclaw_web_search"].map((name) => ({
              name,
              description: "Synthetic search",
              parameters: {
                type: "object",
                properties: {
                  options: { type: "object", patternProperties: { "^.*$": { type: "string" } } },
                },
              },
            })),
          };
          const result = await stream(model, context, {
            apiKey: "synthetic-router-key",
            cacheRetention: "none",
          });
          const events = [];
          for await (const event of result) {
            events.push(event);
          }
          const message = await result.result();
          expect(message.content).toMatchObject([
            { type: "toolCall", name: "web_search", arguments: { options: { region: "us" } } },
          ]);
          for (const event of events) {
            if ("partial" in event && event.partial) {
              for (const block of event.partial.content) {
                if (block.type === "toolCall") {
                  expect(block.name).toBe("web_search");
                }
              }
            }
            if (event.type === "toolcall_end") {
              expect(event.toolCall).toMatchObject({
                type: "toolCall",
                name: "web_search",
                arguments: { options: { region: "us" } },
              });
            }
            if (event.type === "done") {
              expect(event.message).toEqual(message);
            }
          }
          expect(message.provider).toBe("clawrouter");
          expect(message.model).toBe(model.id);
          const request = requests.at(-1)!;
          expect(request.url).toBe(expectedUrl);
          expect(request.headers.get("authorization")).toBe("Bearer synthetic-router-key");
          const body = await request.json();
          expect(body.model).toBe(native ? routes[2][1] : model.id);
          expect(body.tools).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: "openclaw_web_search_2",
                parameters: expect.objectContaining({
                  properties: expect.objectContaining({
                    options: expect.objectContaining({ type: "array" }),
                  }),
                }),
              }),
              expect.objectContaining({ name: "openclaw_web_search" }),
            ]),
          );
          const call = message.content[0];
          if (call?.type !== "toolCall") {
            throw new Error("Missing restored call");
          }
          context.messages.push(message, {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: "Synthetic result" }],
            isError: false,
            timestamp: 2,
          });
          const replay = await (
            await stream(model, context, { apiKey: "synthetic-router-key", cacheRetention: "none" })
          ).result();
          expect(replay.content).toMatchObject([
            { name: "web_search", arguments: { options: { region: "us" } } },
          ]);
          const replayBody = await requests.at(-1)!.json();
          expect(replayBody.input).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "function_call",
                name: "openclaw_web_search_2",
                arguments: JSON.stringify({ options: [{ key: "region", value: "us" }] }),
              }),
            ]),
          );
        }
        expect(requests).toHaveLength(4);
      },
      {
        native,
        respond: () => {
          const call = wireCall(
            "proxy",
            "openclaw_web_search_2",
            JSON.stringify({ options: [{ key: "region", value: "us" }] }),
          );
          return createSseResponse([
            outputItem("added", { ...call, arguments: "" }),
            argumentDelta(call.id, call.arguments),
            outputItem("done", call),
            completedResponse("resp_proxy", [call]),
          ]);
        },
      },
    );
  });

  it.each([true, false])("applies Go pro thinking through native=%s", async (native) => {
    await fixture(
      routes[1],
      async ({ model, plugin, requests, expectedUrl }) => {
        const cases = [
          { configured: "high", requested: "xhigh", effort: "max" },
          { configured: "off", requested: "max", effort: "max" },
          { configured: "off", requested: "low", effort: "high" },
          { configured: "off", requested: "medium", effort: "high" },
          { configured: "high", requested: "off", effort: undefined },
          { configured: "high", requested: "none", effort: undefined },
          { configured: "high", requested: undefined, effort: "high" },
        ] as const;
        for (const hook of ["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const) {
          for (const item of cases) {
            const stream = plugin[hook]!({
              provider: "clawrouter",
              modelId: model.id,
              model,
              streamFn: hook === "wrapStreamFn" ? rawStream : streamSimple,
              thinkingLevel: item.configured,
            })!;
            const options: SimpleStreamOptions = {
              apiKey: "synthetic-router-key",
              onPayload: (payload) => ({
                ...(payload as Record<string, unknown>),
                messages: [
                  {
                    role: "assistant",
                    content: "Prior answer",
                    reasoning_content: "Prior reasoning",
                  },
                  { role: "assistant", content: "Prior answer without reasoning" },
                  { role: "user", content: "Continue" },
                ],
              }),
            };
            // Exercise the shared policy's legacy runtime `none` spelling too.
            if (item.requested !== undefined) {
              Object.assign(options, { reasoning: item.requested });
            }
            const result = await (
              await stream(model, completionContext("Think"), options)
            ).result();
            expect(result.stopReason, result.errorMessage).toBe("stop");
            const request = requests.at(-1)!;
            expect(request.url).toBe(expectedUrl);
            expect(request.headers.get("authorization")).toBe("Bearer synthetic-router-key");
            const body = await request.json();
            expect(body).toMatchObject({
              model: native ? routes[1][1] : model.id,
              thinking: { type: item.effort ? "enabled" : "disabled" },
            });
            expect(body.reasoning_effort).toBe(item.effort);
            expect(body.messages[0].reasoning_content).toBe(
              item.effort ? "Prior reasoning" : undefined,
            );
            expect(body.messages[1].reasoning_content).toBe(item.effort ? "" : undefined);
          }
        }
        expect(requests).toHaveLength(cases.length * 2);
      },
      { native },
    );
  });

  it.each([routes[1], routes[2]])(
    "rejects stale or foreign %s %s associations before transport",
    async (...route) => {
      await fixture(route, async ({ model, plugin, requests }) => {
        const stream = plugin.wrapStreamFn!({
          provider: "clawrouter",
          modelId: model.id,
          streamFn: rawStream,
        })!;
        for (const patch of [
          { providerId: "foreign" },
          { modelId: "stale-model" },
          { upstream: "stale-upstream" },
          { api: "anthropic-messages" },
          { baseUrl: "https://foreign.example" },
          { url: "https://foreign.example/responses" },
          { routeKind: "unknown" },
        ]) {
          const invalid = structuredClone(model);
          const metadata = invalid.params?.clawrouterRoute as { openCode: Record<string, unknown> };
          Object.assign(metadata.openCode, patch);
          expect(() =>
            stream(invalid, completionContext("Denied"), { apiKey: "synthetic-router-key" }),
          ).toThrow("qualified Chat, Responses or Messages route");
        }
        expect(requests).toHaveLength(0);
      });
    },
  );

  it("isolates concurrent Console aliases and restores terminal error views", async (test) => {
    const releaseFirst = Promise.withResolvers<void>();
    let requestIndex = 0;
    await fixture(
      routes[2],
      async ({ model, plugin, requests }) => {
        const stream = plugin.wrapStreamFn!({
          provider: "clawrouter",
          modelId: model.id,
          streamFn: rawStream,
        })!;
        const run = async (name: string) => {
          const output = await stream(
            model,
            {
              ...completionContext("Independent request"),
              tools: [
                {
                  name,
                  description: "Synthetic tool",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
            { apiKey: "synthetic-router-key" },
          );
          const events = [];
          for await (const event of output) {
            events.push(event);
          }
          return { events, message: await output.result() };
        };
        const pending = [run("web_search"), run("openclaw_web_search")] as const;
        try {
          const [first, second] = await withinTest(Promise.all(pending), test.signal);
          expect(first.message.stopReason).toBe("error");
          expect(first.message.errorMessage).toContain("synthetic rejection");
          expect(first.message.content).toMatchObject([{ type: "toolCall", name: "web_search" }]);
          const terminal = first.events.find((event) => event.type === "error");
          expect(terminal).toMatchObject({ type: "error", error: first.message });
          expect(second.message.content).toMatchObject([
            { type: "toolCall", name: "openclaw_web_search" },
          ]);
          expect(requests).toHaveLength(2);
        } finally {
          releaseFirst.resolve();
          await Promise.allSettled(pending);
        }
      },
      {
        native: true,
        respond: async () => {
          const first = requestIndex++ === 0;
          if (first) {
            await releaseFirst.promise;
          } else {
            releaseFirst.resolve();
          }
          const call = wireCall(first ? "first" : "second", "openclaw_web_search");
          return createSseResponse([
            outputItem("added", call),
            outputItem("done", call),
            first
              ? {
                  type: "response.failed",
                  response: {
                    id: "resp_first",
                    status: "failed",
                    error: { code: "invalid_prompt", message: "synthetic rejection" },
                  },
                }
              : completedResponse("resp_second", [call]),
          ]);
        },
      },
    );
  });

  it("leaves unknown Go Chat policy unqualified", async () => {
    await fixture(
      [
        "opencode-go",
        "future-chat-model",
        "openai-completions",
        "llm.chat",
        "chat_completions",
        "/chat/completions",
        "openai.chat_completions",
      ],
      async ({ model, plugin, requests }) => {
        const stream = plugin.wrapStreamFn!({
          provider: "clawrouter",
          modelId: model.id,
          model,
          streamFn: rawStream,
          thinkingLevel: "high",
        })!;
        expect(
          (
            await (
              await stream(model, completionContext("Unrelated"), {
                apiKey: "synthetic-router-key",
              })
            ).result()
          ).stopReason,
        ).toBe("stop");
        expect(requests).toHaveLength(1);
        expect(await requests[0]!.json()).not.toHaveProperty("thinking");
      },
      { native: true },
    );
  });

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
