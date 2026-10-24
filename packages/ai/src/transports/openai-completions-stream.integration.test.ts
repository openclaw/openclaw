import { afterAll, describe, expect, it, vi } from "vitest";
import { streamWithIdleTimeout } from "../../../../src/agents/embedded-agent-runner/run/llm-idle-timeout.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticRunProgress,
  resetDiagnosticRunActivityForTest,
} from "../../../../src/logging/diagnostic-run-activity.js";
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

describe("openai completions stream", () => {
  afterAll(() => {
    resetDiagnosticRunActivityForTest();
  });

  describe.each([
    { name: "direct", createStream: streamOpenAICompletions },
    { name: "managed", createStream: createOpenAICompletionsTransportStreamFn() },
  ])("$name cache-creation usage", ({ name, createStream }) => {
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
            for (const chunk of [
              makeCompletionsChunk({ role: "assistant", content: "Usage preserved." }),
              makeCompletionsChunk({}, "stop"),
              makeCompletionsChunk({}, null, { choices: [], usage }),
            ]) {
              writeSse(res, chunk);
            }
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
  });

  it("emits Qwen thinking streams when enabled without reasoning_effort support", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    await withServer(
      (_req, res, body) => {
        capturedPayload = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-qwen-thinking",
            object: "chat.completion",
            model: "qwen3.5-32b",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  reasoning_content: "Need a Qwen answer.",
                  content: "qwen-ok",
                },
                finish_reason: "stop",
              },
            ],
          }),
        );
      },
      async (baseUrl) => {
        const model = makeCompletionsModel({
          id: "qwen3.5-32b",

          provider: "qwen",
          baseUrl,

          compat: { thinkingFormat: "qwen", supportsReasoningEffort: false },
        });
        const stream = createOpenAICompletionsTransportStreamFn()(
          model,
          replyContext("Reply qwen-ok"),
          { apiKey: "test-key", reasoning: "medium" } as never,
        );
        const { thinking, text } = await captureStream(stream);
        expect(capturedPayload?.enable_thinking).toBe(true);
        expect(capturedPayload).not.toHaveProperty("reasoning_effort");
        expect(thinking).toBe("Need a Qwen answer.");
        expect(text).toBe("qwen-ok");
      },
    );
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
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_lookup",
                    type: "function",
                    function: { name: "lookup", arguments: '{"query":"local"}' },
                  },
                ],
              }
            : { role: "assistant", content: "No tool required." };
          for (const chunk of [
            makeCompletionsChunk(delta),
            makeCompletionsChunk({}, finishReason),
          ]) {
            writeSse(res, chunk);
          }
          res.end("data: [DONE]\n\n");
        },
        async (baseUrl) => {
          const model = makeCompletionsModel({
            id: "minimax-m2.5-8bit",
            provider: "mlx-lm",
            baseUrl,
            reasoning: false,
          });
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
      // The regression under guard is "hidden reasoning stops resetting the idle
      // watchdog", so the hidden phase has to outlast idleTimeoutMs or a broken
      // build would pass. Pace chunks far below that budget instead of near it:
      // a loaded runner stretches every inter-chunk gap, and one gap wider than
      // the timeout inverts the ratio into a false idle timeout.
      const idleTimeoutMs = 1_000;
      const sessionProgressStaleMs = 750;
      const reasoningChunkDelayMs = 5;
      const hiddenReasoningDurationMs = idleTimeoutMs + 200;
      const runId = `hidden-${reasoningField}-run`;
      let hiddenReasoningElapsedMs = 0;
      let crossedSessionProgressThreshold = false;
      let resolveSessionProgressThreshold!: () => void;
      const sessionProgressThresholdReached = new Promise<void>((resolve) => {
        resolveSessionProgressThreshold = resolve;
      });
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
              resolveSessionProgressThreshold();
            }
            if (hiddenReasoningElapsedMs < hiddenReasoningDurationMs) {
              const reasoningChunk = {
                id: "chatcmpl-local-reasoning",
                object: "chat.completion.chunk",
                created: 1,
                model: "nemotron-local",
                choices: [
                  {
                    index: 0,
                    delta: { [reasoningField]: "private reasoning" },
                    finish_reason: null,
                  },
                ],
              };
              writeSse(res, reasoningChunk);
              setTimeout(writeNextChunk, reasoningChunkDelayMs);
              return;
            }

            writeSse(res, makeCompletionsChunk({ role: "assistant", content: "OK" }));
            writeSse(res, makeCompletionsChunk({}, "stop"));
            res.write("data: [DONE]\n\n");
            res.end();
          };

          writeNextChunk();
        },
        async (baseUrl) => {
          const model = makeCompletionsModel({
            id: "nemotron-local",

            provider: "inference",
            baseUrl,
            reasoning: false,
          });
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
          await sessionProgressThresholdReached;
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

  it("promotes native tool calls through fetch wrapper when SSE terminates cleanly with [DONE] without finish_reason", async () => {
    await withServer(
      (_req, res) => {
        startSse(res, true);
        // Emit a delta.tool_calls chunk with no finish_reason
        writeSse(
          res,
          makeCompletionsChunk({
            tool_calls: [
              {
                index: 0,
                id: "call_loopback_done",
                function: { name: "bash", arguments: '{"cmd":"echo loopback"}' },
              },
            ],
          }),
        );
        // Split CRLF-formatted terminal proof across chunks. The SDK accepts this
        // framing, so the raw terminal observer must preserve the same contract.
        res.write("data: [DO");
        res.write("NE]\r\n\r\n");
        res.end();
      },
      async (baseUrl) => {
        const baseModel = makeCompletionsModel({
          id: "qwen3.6-27b",

          provider: "vllm",
          baseUrl,
          reasoning: false,
        });
        const stream = createOpenAICompletionsTransportStreamFn()(
          baseModel,
          replyContext("Run a command"),
          { apiKey: "test-key" } as never,
        );
        const { terminal, events } = await captureStream(stream);
        expect(terminal).toMatchObject({ type: "done", reason: "toolUse" });
        expect(events.some((event) => event.type === "toolcall_start")).toBe(true);
        expect(
          terminal?.type === "done"
            ? terminal.message.content.filter((block) => block.type === "toolCall")
            : [],
        ).toHaveLength(1);
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
              makeCompletionsChunk({
                tool_calls: [
                  {
                    index: 0,
                    id: "call_interrupted",
                    function: { name: "bash", arguments: '{"cmd":"echo loopback"}' },
                  },
                ],
              }),
            );
          }
          res.end();
        },
        async (baseUrl) => {
          const baseModel = makeCompletionsModel({
            id: "qwen3.6-27b",

            provider: "vllm",
            baseUrl,
            reasoning: false,
          });
          const stream = createOpenAICompletionsTransportStreamFn()(
            baseModel,
            replyContext("Run a command"),
            { apiKey: "test-key" } as never,
          );
          const { terminal, result } = await captureStream(stream);
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
      makeCompletionsChunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_spurious",
              function: { name: "bash", arguments: '{"cmd":"echo hi"}' },
            },
          ],
        },
        "stop",
      ),
    ] as const;
    await run(chunks);

    expect(output.stopReason).toBe("stop");
    expect(output.content).toStrictEqual([{ type: "text", text: "Here is the answer." }]);
  });
});
