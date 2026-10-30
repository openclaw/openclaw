import { afterAll, describe, expect, it, vi } from "vitest";
import { streamWithIdleTimeout } from "../../../../src/agents/embedded-agent-runner/run/llm-idle-timeout.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticRunProgress,
  resetDiagnosticRunActivityForTest,
} from "../../../../src/logging/diagnostic-run-activity.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { streamOpenAICompletions } from "../providers/openai-completions.js";
import { registerBuiltInApiProviders } from "../providers/register-builtins.js";
import { createLlmRuntime } from "../stream.js";
import {
  collectStream as captureStream,
  replyContext,
  startSse,
  streamFixture,
  withServer,
  writeSse,
} from "./openai-completions-suite.test-support.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsChunk, makeCompletionsModel } from "./openai-completions.test-support.js";

function nativeTool(id: string, name: string, args: string) {
  return { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] };
}

function localModel(baseUrl: string, overrides: Parameters<typeof makeCompletionsModel>[0] = {}) {
  return makeCompletionsModel({
    id: "qwen3.6-27b",
    provider: "vllm",
    reasoning: false,
    baseUrl,
    ...overrides,
  });
}

function collectLocal(baseUrl: string) {
  return captureStream(
    createOpenAICompletionsTransportStreamFn()(localModel(baseUrl), replyContext("Run a command"), {
      apiKey: "test-key",
    }),
  );
}

describe("openai completions stream", () => {
  afterAll(resetDiagnosticRunActivityForTest);
  describe.each([
    { name: "direct", createStream: streamOpenAICompletions },
    { name: "managed", createStream: createOpenAICompletionsTransportStreamFn() },
  ])("$name HTTP streams", ({ name, createStream }) => {
    const usageCases = [
      ["top-level fallback", {}, 300, 0.001075, undefined],
      ["nested write zero", { cache_write_tokens: 0 }, 0, 0.001, undefined],
      ["nested creation zero", { cache_creation_input_tokens: 0 }, 0, 0.001, undefined],
      ["provider-billed zero", {}, 300, 0, 0],
    ] as const;
    it.each(name === "direct" ? usageCases.slice(0, 1) : usageCases)(
      "preserves %s over HTTP",
      async (_name, details, cacheWrite, cost, billedCost) => {
        let capturedPayload: Record<string, unknown> | undefined;
        let capturedRoute: string | undefined;
        await withServer(
          (req, res, body) => {
            capturedRoute = `${req.method} ${req.url}`;
            capturedPayload = JSON.parse(body) as Record<string, unknown>;
            startSse(res);
            // TrueFoundry documents inclusive prompt tokens with a top-level write bucket:
            // https://www.truefoundry.com/docs/ai-gateway/chat-completions-advanced
            const usage = {
              prompt_tokens: 1500,
              completion_tokens: 200,
              total_tokens: 1700,
              prompt_tokens_details: { cached_tokens: 1200, ...details },
              cache_read_input_tokens: 1200,
              cache_creation_input_tokens: 300,
              ...(billedCost === undefined ? {} : { cost: billedCost }),
            };
            writeSse(res, makeCompletionsChunk({ role: "assistant", content: "Usage preserved." }));
            writeSse(res, makeCompletionsChunk({}, "stop"));
            writeSse(res, makeCompletionsChunk({}, null, { choices: [], usage }));
            res.end("data: [DONE]\n\n");
          },
          async (baseUrl) => {
            const model = makeCompletionsModel({
              provider: "compatible-proxy",
              baseUrl,
              reasoning: false,
              cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 1.25 },
            });
            const stream = await createStream(
              model,
              { messages: [{ role: "user", content: "Explain the usage.", timestamp: 1 }] },
              { apiKey: "synthetic-test-key" },
            );
            const result = await stream.result();
            expect(capturedRoute).toBe("POST /v1/chat/completions");
            expect(capturedPayload).toMatchObject({ model: model.id, stream: true });
            expect(result.stopReason).toBe("stop");
            expect(result.content).toEqual([expect.objectContaining({ text: "Usage preserved." })]);
            expect(result.usage).toMatchObject({
              input: 300 - cacheWrite,
              output: 200,
              cacheRead: 1200,
              cacheWrite,
              totalTokens: 1700,
            });
            expect(result.usage.cost.cacheWrite).toBeCloseTo((cacheWrite * 1.25) / 1_000_000, 10);
            expect(result.usage.cost.total).toBeCloseTo(cost, 10);
            if (billedCost !== undefined) {
              expect(result.usage.cost.totalOrigin).toBe("provider-billed");
            }
          },
        );
      },
    );
    it.each([
      ["thinking", { reasoning_content: "Need a Qwen answer.", content: "qwen-ok" }],
      ["text", { content: "qwen-ok" }],
      ["hidden reasoning", { reasoning_content: "Private reasoning" }],
      ["tool call", nativeTool("call_1", "read", "{}")],
      ["finish", {}],
      ["usage", {}],
      ["error", {}],
    ] as const)("attributes %s after transport keepalives", async (kind, delta) => {
      const failed = kind === "error";
      let capturedPayload: Record<string, unknown> | undefined;
      await withServer(
        (_req, res, body) => {
          capturedPayload = JSON.parse(body) as Record<string, unknown>;
          startSse(res);
          const heartbeat = { id: "heartbeat", model: "keepalive", choices: [] };
          [
            heartbeat,
            { ...heartbeat, choices: [{ delta: { role: "assistant", content: "" } }] },
            { ...heartbeat, choices: [], usage: {} },
            failed
              ? { error: { message: "Synthetic upstream failure", type: "server_error" } }
              : makeCompletionsChunk(delta, kind === "finish" ? "stop" : null, {
                  id: "real-response",
                  model: kind === "thinking" ? "qwen3.5-32b" : "served-model",
                  ...(kind === "usage"
                    ? {
                        choices: [],
                        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                      }
                    : {}),
                }),
            ...(failed ? [] : [heartbeat, makeCompletionsChunk({}, "stop", { id: "", model: "" })]),
          ].forEach((chunk) => writeSse(res, chunk));
          res.end("data: [DONE]\n\n");
        },
        async (baseUrl) => {
          const model = localModel(baseUrl, {
            id: "qwen3.5-32b",
            provider: "qwen",
            reasoning: true,
            compat: { thinkingFormat: "qwen", supportsReasoningEffort: false },
          });
          const stream = await createStream(model, replyContext("Reply qwen-ok"), {
            apiKey: "test-key",
            reasoning: kind === "thinking" ? "medium" : "off",
            reasoningEffort: kind === "thinking" ? "medium" : "off",
          });
          const { result, thinking, text } = await captureStream(stream);
          expect(result.responseId).toBe(failed ? undefined : "real-response");
          expect(result.responseModel).toBe(
            failed || kind === "thinking" ? undefined : "served-model",
          );
          expect(result.stopReason === "error").toBe(failed);
          expect(result.errorMessage).toEqual(
            failed ? expect.stringContaining("Synthetic upstream failure") : undefined,
          );
          if (kind === "thinking") {
            expect(capturedPayload?.enable_thinking).toBe(true);
            expect(capturedPayload).not.toHaveProperty("reasoning_effort");
          }
          expect(thinking).toBe(kind === "thinking" ? "Need a Qwen answer." : "");
          expect(text).toBe(kind === "thinking" || kind === "text" ? "qwen-ok" : "");
        },
      );
    });
  });
  it.each([
    { finishReason: "tool_call", emitsTool: true, stopReason: "toolUse" },
    { finishReason: "tool_call", emitsTool: false, stopReason: "stop" },
    { finishReason: "tool_calls", emitsTool: true, stopReason: "toolUse" },
    { finishReason: "function_call", emitsTool: true, stopReason: "toolUse" },
    { finishReason: "unknown", emitsTool: true, stopReason: "error" },
  ])(
    "handles $finishReason with emitsTool=$emitsTool through the public LLM runtime",
    async ({ finishReason, emitsTool, stopReason }) => {
      await withServer(
        (_req, res) => {
          startSse(res);
          const delta = emitsTool
            ? nativeTool("call_lookup", "lookup", '{"query":"local"}')
            : { role: "assistant", content: "No tool required." };
          writeSse(res, makeCompletionsChunk(delta));
          writeSse(res, makeCompletionsChunk({}, finishReason));
          res.end("data: [DONE]\n\n");
        },
        async (baseUrl) => {
          const model = localModel(baseUrl, { id: "minimax-m2.5-8bit", provider: "mlx-lm" });
          const runtime = createLlmRuntime();
          registerBuiltInApiProviders(runtime.registry);
          const stream = runtime.streamSimple(
            model,
            { messages: [{ role: "user", content: "Look it up.", timestamp: 1 }] },
            { apiKey: "synthetic-test-key" },
          );
          const result = await stream.result();
          expect(result.stopReason).toBe(stopReason);
          const toolCalls = result.content.filter((block) => block.type === "toolCall");
          if (stopReason === "toolUse") {
            expect(toolCalls).toEqual([
              expect.objectContaining({
                id: "call_lookup",
                name: "lookup",
                arguments: { query: "local" },
              }),
            ]);
          } else {
            expect(toolCalls).toEqual([]);
          }
          if (finishReason === "unknown") {
            expect(result.errorMessage).toBe("Provider finish_reason: unknown");
          }
        },
      );
    },
  );

  it.concurrent.each(["reasoning_content", "reasoning"] as const)(
    "keeps hidden local %s streams alive beyond the model idle timeout",
    async (reasoningField) => {
      // Outlast the watchdog while pacing chunks well below its timeout on loaded runners.
      const idleTimeoutMs = 1_000;
      const sessionProgressStaleMs = 750;
      const reasoningChunkDelayMs = 5;
      const hiddenReasoningDurationMs = idleTimeoutMs + 200;
      const runId = `hidden-${reasoningField}-run`;
      let hiddenReasoningElapsedMs = 0;
      let crossedSessionProgressThreshold = false;
      const sessionProgressThresholdReached = createDeferred();
      await withServer(
        (_req, res) => {
          startSse(res, true);

          const hiddenReasoningStartedAt = Date.now();
          const writeNextChunk = () => {
            if (res.destroyed) {
              return;
            }
            hiddenReasoningElapsedMs = Date.now() - hiddenReasoningStartedAt;
            if (
              !crossedSessionProgressThreshold &&
              hiddenReasoningElapsedMs > sessionProgressStaleMs + 100
            ) {
              crossedSessionProgressThreshold = true;
              sessionProgressThresholdReached.resolve();
            }
            if (hiddenReasoningElapsedMs < hiddenReasoningDurationMs) {
              const reasoningChunk = makeCompletionsChunk(
                { [reasoningField]: "private reasoning" },
                null,
                {
                  id: "chatcmpl-local-reasoning",
                  model: "nemotron-local",
                },
              );
              writeSse(res, reasoningChunk);
              setTimeout(writeNextChunk, reasoningChunkDelayMs);
              return;
            }

            writeSse(res, makeCompletionsChunk({ role: "assistant", content: "OK" }));
            writeSse(res, makeCompletionsChunk({}, "stop"));
            res.end("data: [DONE]\n\n");
          };

          writeNextChunk();
        },
        async (baseUrl) => {
          const model = localModel(baseUrl, { id: "nemotron-local", provider: "inference" });
          const onIdleTimeout = vi.fn();
          markDiagnosticRunProgress({ runId, sessionId: runId, reason: "model_call:started" });
          const streamFn = streamWithIdleTimeout(
            createOpenAICompletionsTransportStreamFn(),
            idleTimeoutMs,
            onIdleTimeout,
            { runId },
          );
          const stream = streamFn(model, replyContext("Reply OK"), { apiKey: "test-key" } as never);
          const collecting = captureStream(stream);
          await sessionProgressThresholdReached.promise;
          const activity = getDiagnosticSessionActivitySnapshot({ sessionId: runId });
          expect(activity.lastProgressAgeMs).toBeLessThan(sessionProgressStaleMs);
          expect(activity.lastProgressReason).toBe("model_call:stream_progress");
          const { text, thinking } = await collecting;
          expect(text).toBe("OK");
          expect(thinking).toBe("");
          expect(onIdleTimeout).not.toHaveBeenCalled();
          expect(hiddenReasoningElapsedMs).toBeGreaterThan(idleTimeoutMs);
        },
      );
    },
  );

  it.each([
    { name: "split CRLF", prefix: "", terminal: ["data: [DO", "NE]\r\n\r\n"], valid: true },
    { name: "initial BOM", prefix: "\uFEFF", terminal: ["data: [DONE]\n\n"], valid: true },
    { name: "mixed line endings", prefix: "", terminal: ["data:[DONE]\r\n\n"], valid: true },
    { name: "padded marker", prefix: "", terminal: ["data:\t[DONE]\t\n\n"], valid: false },
    {
      name: "oversized marker line",
      prefix: "",
      terminal: [`data:${" ".repeat(1_014)}[DONE]\n\n`],
      valid: false,
    },
    { name: "comment marker", prefix: "", terminal: [":data: [DONE]\n\n"], valid: false },
    {
      name: "embedded marker",
      prefix: "",
      terminal: [`data: ${JSON.stringify(makeCompletionsChunk({ content: "[DONE]" }))}\n\n`],
      valid: false,
    },
  ])(
    "preserves native tool terminal proof over HTTP: $name",
    async ({ prefix, terminal, valid }) => {
      await withServer(
        (_req, res) => {
          startSse(res, true);
          res.write(prefix);
          writeSse(
            res,
            makeCompletionsChunk(
              nativeTool("call_loopback_done", "bash", '{"cmd":"echo loopback"}'),
            ),
          );
          for (const part of terminal) {
            res.write(part);
          }
          res.end();
        },
        async (baseUrl) => {
          const { terminal: event, events, result } = await collectLocal(baseUrl);
          expect(events.some((entry) => entry.type === "toolcall_start")).toBe(true);
          if (valid) {
            expect(event).toMatchObject({ type: "done", reason: "toolUse" });
            expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(1);
          } else {
            expect(event?.type).toBe("error");
            expect(events.some((entry) => entry.type === "toolcall_end")).toBe(false);
            expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
          }
        },
      );
    },
  );

  it("observes terminal proof without walking every SSE character", async () => {
    const chunks = Array.from({ length: 200 }, () =>
      makeCompletionsChunk({ content: "Streaming text 🦞 " }),
    );
    chunks.push(makeCompletionsChunk({}, "stop"));
    const body =
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    await withServer(
      (_req, res) => {
        startSse(res);
        res.end(body);
      },
      async (baseUrl) => {
        const iteratedCharacters = [];
        for (const createStream of [
          streamOpenAICompletions,
          createOpenAICompletionsTransportStreamFn(),
        ]) {
          const iterate = String.prototype[Symbol.iterator];
          let characters = 0;
          const iterator = vi
            .spyOn(String.prototype, Symbol.iterator)
            .mockImplementation(function* (this: string) {
              for (const character of iterate.call(this)) {
                characters++;
                yield character;
              }
              return undefined;
            });
          try {
            const result = await captureStream(
              createStream(localModel(baseUrl), replyContext(), { apiKey: "test-key" }),
            );
            expect(result.text).toBe("Streaming text 🦞 ".repeat(200));
            expect(result.result.stopReason).toBe("stop");
            iteratedCharacters.push(characters);
          } finally {
            iterator.mockRestore();
          }
        }
        expect(iteratedCharacters[1]).toBe(iteratedCharacters[0]);
      },
    );
  });

  it.each(["empty", "tool", "text and tool"] as const)(
    "reports a %s response without a terminal marker as interrupted",
    async (content) => {
      await withServer(
        (_req, res) => {
          startSse(res, true);
          if (content === "text and tool") {
            writeSse(res, makeCompletionsChunk({ content: "Running a command." }));
          }
          if (content !== "empty") {
            writeSse(
              res,
              makeCompletionsChunk(
                nativeTool("call_interrupted", "bash", '{"cmd":"echo loopback"}'),
              ),
            );
          }
          res.end();
        },
        async (baseUrl) => {
          const { terminal, result } = await collectLocal(baseUrl);
          expect(terminal?.type).toBe("error");
          expect(result.stopReason).toBe("error");
          expect(result.errorMessage).toContain("Stream ended without finish_reason");
          expect(result.content.filter((block) => block.type === "toolCall")).toStrictEqual([]);
        },
      );
    },
  );

  it("rolls back provisional tags when stop strips spurious tool calls", async () => {
    const model = makeCompletionsModel({
      id: "grok-4.5",

      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      reasoning: false,
    });
    const { output, run } = streamFixture(model);
    const chunks = [
      makeCompletionsChunk({ role: "assistant" as const, content: "" }),
      makeCompletionsChunk({ content: "Here is the answer." }),
      makeCompletionsChunk(nativeTool("call_spurious", "bash", '{"cmd":"echo hi"}'), "stop"),
    ] as const;
    await run(chunks);

    expect(output.stopReason).toBe("stop");
    expect(output.content).toStrictEqual([{ type: "text", text: "Here is the answer." }]);
  });
});
