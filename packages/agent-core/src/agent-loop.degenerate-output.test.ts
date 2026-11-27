import { setImmediate } from "node:timers/promises";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  startSse,
  withServer,
  writeSse,
} from "../../ai/src/transports/openai-completions-suite.test-support.js";
import { createOpenAICompletionsTransportStreamFn } from "../../ai/src/transports/openai-completions-transport.js";
import {
  makeCompletionsChunk,
  makeCompletionsModel,
} from "../../ai/src/transports/openai-completions.test-support.js";
import * as fixtures from "./agent-loop.test-support.js";
import type { AgentTool } from "./types.js";

const callStart = makeCompletionsChunk({
  role: "assistant",
  tool_calls: [
    { index: 0, id: "call_1", type: "function", function: { name: "record", arguments: "" } },
  ],
});
const argumentChunk = (text: string) =>
  makeCompletionsChunk({ tool_calls: [{ index: 0, function: { arguments: text } }] });

function recordTool(calls: unknown[]): AgentTool {
  return {
    name: "record",
    label: "record",
    description: "record",
    parameters: Type.Object({ code: Type.String() }),
    execute: async (_id, args) => {
      calls.push(args);
      return { content: [{ type: "text", text: "recorded" }], details: {} };
    },
  };
}

// The stream owner ends a tool-call argument stream that only grows whitespace, for every
// provider. Real HTTP and the Chat Completions transport; only the wire frames are scripted.
describe("degenerate tool-call arguments through Chat Completions", () => {
  it("stops a whitespace runaway after 4 KiB instead of streaming to the output cap", async () => {
    let whitespaceSent = 0;
    let requests = 0;
    const closed = Promise.withResolvers<void>();
    const calls: unknown[] = [];
    let streaming = Promise.resolve();
    await withServer(
      (_req, res) => {
        requests += 1;
        res.on("close", () => closed.resolve());
        startSse(res);
        writeSse(res, callStart);
        writeSse(res, argumentChunk('{"code":"return 1;"'));
        // The captured runaway: newline and indent forever, ~66 tokens/s until max_output_tokens.
        streaming = (async () => {
          for (let index = 0; index < 20_000 && !res.destroyed; index += 1) {
            writeSse(res, argumentChunk(index % 2 ? "     " : "\n"));
            whitespaceSent += index % 2 ? 5 : 1;
            await setImmediate();
          }
          res.end();
        })();
      },
      async (baseUrl) => {
        const { run } = fixtures.captureToolLoop({
          tools: [recordTool(calls)],
          config: { model: makeCompletionsModel({ baseUrl }), apiKey: "synthetic-test-key" },
          streamFn: createOpenAICompletionsTransportStreamFn(),
        });
        const messages = await run;
        await closed.promise;
        await streaming;
        expect(messages.at(-1)).toMatchObject({
          role: "assistant",
          stopReason: "error",
          errorCode: "degenerate_output",
        });
        expect(JSON.stringify(messages.at(-1))).not.toContain('"type":"toolCall"');
      },
    );
    expect(calls).toEqual([]);
    expect(requests).toBe(1);
    // 4 KiB plus what was in flight when the abort reached the socket; main sent all 60,000.
    expect(whitespaceSent).toBeGreaterThanOrEqual(4 * 1024);
    expect(whitespaceSent).toBeLessThan(16 * 1024);
  });

  it("runs a 200 KiB argument whose whitespace runs stay below 4 KiB", async () => {
    const code = `${" ".repeat(4 * 1024 - 1)};`.repeat(50);
    const args = JSON.stringify({ code });
    const calls: unknown[] = [];
    await withServer(
      (_req, res) => {
        startSse(res);
        if (calls.length > 0) {
          writeSse(res, makeCompletionsChunk({ role: "assistant", content: "done" }));
          writeSse(res, makeCompletionsChunk({}, "stop"));
        } else {
          writeSse(res, callStart);
          for (let offset = 0; offset < args.length; offset += 1024) {
            writeSse(res, argumentChunk(args.slice(offset, offset + 1024)));
          }
          writeSse(res, makeCompletionsChunk({}, "tool_calls"));
        }
        res.end("data: [DONE]\n\n");
      },
      async (baseUrl) => {
        const { run } = fixtures.captureToolLoop({
          tools: [recordTool(calls)],
          config: { model: makeCompletionsModel({ baseUrl }), apiKey: "synthetic-test-key" },
          streamFn: createOpenAICompletionsTransportStreamFn(),
        });
        const messages = await run;
        expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
      },
    );
    expect(calls).toEqual([{ code }]);
  });
});
