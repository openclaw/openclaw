// Real loopback HTTP corroboration for provider admission retention.
// timeout 120s node --expose-gc --import ./scripts/tsx.mjs scripts/perf/provider-rate-limit-http-retention.ts --turns 100 --scenario abort
// Repeat unchanged on both revisions for success, retry, and abort. Keep completed
// streams reachable; measure callback payloads only, not provider continuation state.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getEventStreamCompletion } from "@openclaw/ai/internal/runtime";
import { cleanupSessionResources } from "../../packages/ai/src/session-resources.ts";
import { createOpenAIResponsesTransportStreamFn } from "../../packages/ai/src/transports/openai-responses-client.ts";
import { admitProviderRateLimitStream } from "../../src/llm/provider-rate-limit-stream.ts";
import "../../src/llm/stream.ts";
import type { AssistantMessageEventStreamLike, Model } from "../../src/llm/types.ts";

const { values } = parseArgs({
  options: {
    turns: { type: "string", default: "100" },
    scenario: { type: "string", default: "abort" },
  },
});
const turns = Number(values.turns);
const scenario = values.scenario;
assert(Number.isSafeInteger(turns) && turns > 0);
assert(scenario === "success" || scenario === "retry" || scenario === "abort");
const gc = globalThis.gc;
assert(gc, "Run with --expose-gc");
const payloadBytes = 32768;
const references: WeakRef<number[]>[] = [];
const held: AssistantMessageEventStreamLike[] = [];
let calls = 0;
let rateLimits = 0;
const server = createServer((request, response) => {
  request.resume();
  request.once("end", () => {
    calls++;
    if (scenario === "retry" && calls % 2 === 1) {
      const organization = request.headers["openai-organization"];
      assert(typeof organization === "string");
      rateLimits++;
      response.writeHead(429, { "content-type": "application/json", "retry-after-ms": "1" });
      response.end(
        JSON.stringify({
          error: {
            message: `Rate limit reached in organization ${organization} on tokens per min (TPM).`,
            type: "tokens",
            code: "rate_limit_exceeded",
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const frame = `data: ${JSON.stringify({
      type: scenario === "abort" ? "response.created" : "response.completed",
      response: {
        id: `resp_${calls}`,
        status: scenario === "abort" ? "in_progress" : "completed",
        output: [],
        usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
      },
    })}\n\n`;
    if (scenario === "abort") {
      response.write(frame);
    } else {
      response.end(frame);
    }
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const model: Model = {
  id: "synthetic",
  name: "Synthetic",
  provider: "synthetic",
  api: "openai-responses",
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  reasoning: false,
  input: ["text"],
  contextWindow: 200000,
  maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
Object.defineProperty(model, Symbol.for("openclaw.modelProviderRequestTransport"), {
  value: { allowPrivateNetwork: true },
});
const transport = createOpenAIResponsesTransportStreamFn();
async function turn(index: number) {
  const payload = Array.from({ length: payloadBytes / 8 }, () => index);
  references.push(new WeakRef(payload));
  const controller = new AbortController();
  const options = {
    apiKey: `synthetic-${index}`,
    headers: { "openai-organization": `org-http-retention-${index}` },
    signal: controller.signal,
    onPayload: () => {
      assert.equal(payload.length, payloadBytes / 8);
    },
  };
  const start = () =>
    admitProviderRateLimitStream(model, options, (admitted) =>
      transport(
        model,
        {
          messages: [{ role: "user", content: `Synthetic turn ${index}`, timestamp: index }],
        },
        admitted,
      ),
    );
  let output = await start();
  if (scenario === "abort") {
    for await (const event of output) {
      assert.equal(event.type, "start");
      break;
    }
    controller.abort("synthetic stop");
    const completion = getEventStreamCompletion(output);
    assert(completion, "The actual transport must preserve native producer completion");
    await completion;
  } else {
    for await (const event of output) {
      if (event.type === "error") {
        assert.equal(scenario, "retry");
      }
    }
    let result = await output.result();
    if (scenario === "retry") {
      assert.equal(result.stopReason, "error");
      assert.equal(result.retryAfterMs, 1);
      held.push(output);
      output = await start();
      for await (const event of output) {
        assert.notEqual(event.type, "error");
      }
      result = await output.result();
    }
    assert.equal(result.stopReason, "stop", result.errorMessage ?? "Expected a successful result");
  }
  held.push(output);
}
try {
  for (let index = 0; index < turns; index++) {
    await turn(index);
  }
  const control = new WeakRef({ unowned: true });
  for (let pass = 0; pass < 8; pass++) {
    await nextTurn();
    gc();
  }
  assert.equal(control.deref(), undefined);
  assert.equal(calls, turns * (scenario === "retry" ? 2 : 1));
  assert.equal(rateLimits, scenario === "retry" ? turns : 0);
  const retained = references.filter((reference) => reference.deref()).length;
  console.log(
    JSON.stringify({
      scenario,
      turns,
      providerRequests: calls,
      http429: rateLimits,
      heldStreams: held.length,
      retainedCallbacks: retained,
      retainedPayloadBytes: retained * payloadBytes,
    }),
  );
  for (const output of held) {
    const result = await output.result();
    assert.equal(result.role, "assistant");
    if (scenario === "abort") {
      assert.equal(result.stopReason, "aborted");
    }
  }
} finally {
  try {
    cleanupSessionResources();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
