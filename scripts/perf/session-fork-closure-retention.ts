// Run on the benchmark host with --expose-gc and the repository's scripts/tsx.mjs preload.
// One fresh process is one sample; alternate baseline/candidate processes at least five times.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { registerHooks } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import type {
  Context,
  Message,
  Model,
  StreamFn,
  StreamOptions,
} from "../../packages/ai/src/types.js";

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "32" },
    turns: { type: "string", default: "4" },
    history: { type: "string", default: "128" },
    model: { type: "string" },
    snapshot: { type: "string" },
    "expect-released": { type: "boolean", default: false },
  },
});
assert(global.gc, "Run with --expose-gc");
assert(values.model, "Supply --model with a model supported by the native steering transport");
const sessions = Number(values.sessions);
const turns = Number(values.turns);
const history = Number(values.history);
for (const count of [sessions, turns, history]) {
  assert(Number.isSafeInteger(count) && count > 0);
}

type WireEvent = { type: "open" } | { type: "message"; message: Record<string, unknown> };
let responseSerial = 0;
let createCalls = 0;
let continuationCalls = 0;
let steerCalls = 0;
let openSockets = 0;
let expectSteer = false;

function completion(id: string) {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          id: `msg_${id}`,
          status: "completed",
          content: [{ type: "output_text", text: "Synthetic answer", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  };
}

// Only the physical SDK socket is fake. Request preparation, steering, continuation,
// streaming, fork capture/replay, cache ownership and their real expiry timers remain live.
class SyntheticResponsesWS {
  socket = { readyState: 1 };
  private queue: WireEvent[] = [];
  private waiting: Array<(result: IteratorResult<WireEvent>) => void> = [];
  private responseId = "";
  private listeners: Array<() => void> = [];

  constructor() {
    openSockets++;
  }

  on(_event: string, listener: () => void) {
    this.listeners.push(listener);
    return this;
  }

  close() {
    if (this.socket.readyState === 1) {
      openSockets--;
      this.socket.readyState = 3;
    }
  }

  private push(event: WireEvent) {
    const resolve = this.waiting.shift();
    if (resolve) {
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  private emit(message: Record<string, unknown>) {
    this.push({ type: "message", message });
  }

  send(request: Record<string, unknown>) {
    assert.equal(request.type, "response.create");
    createCalls++;
    continuationCalls += Number(Boolean(request.previous_response_id));
    this.responseId = `resp_${++responseSerial}`;
    this.emit({ type: "response.created", response: { id: this.responseId } });
    if (!expectSteer) {
      this.emit(completion(this.responseId));
    }
  }

  sendRaw(data: string) {
    const request = JSON.parse(data) as Record<string, unknown>;
    assert.equal(request.type, "response.steer");
    assert.equal(request.previous_response_id, this.responseId);
    steerCalls++;
    this.emit({
      type: "response.steer.accepted",
      steer: { id: `steer_${steerCalls}`, previous_response_id: this.responseId },
    });
    this.emit(completion(this.responseId));
  }

  stream(): AsyncIterableIterator<WireEvent> {
    this.push({ type: "open" });
    const iterator: AsyncIterableIterator<WireEvent> = {
      next: () => {
        const event = this.queue.shift();
        return event
          ? Promise.resolve({ value: event, done: false })
          : new Promise((resolve) => {
              this.waiting.push(resolve);
            });
      },
      return: () => {
        for (const resolve of this.waiting.splice(0)) {
          resolve({ value: undefined, done: true });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }
}

const socketKey = Symbol.for("openclaw.perf.syntheticResponsesWS");
Reflect.set(globalThis, socketKey, SyntheticResponsesWS);
const socketModule = `data:text/javascript,${encodeURIComponent(
  'export const ResponsesWS = globalThis[Symbol.for("openclaw.perf.syntheticResponsesWS")];',
)}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "openai/resources/responses/ws.js"
      ? { url: socketModule, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

let forkChecks = 0;
const fakeFetch: typeof fetch = async (url, init) => {
  const body = (await new Request(url, init).json()) as Record<string, unknown>;
  assert.equal(body.previous_response_id, undefined, "forks must send an independent prefix");
  const serialized = JSON.stringify(body.input);
  assert(serialized.includes("Synthetic parent"));
  assert(serialized.includes("Synthetic steering"));
  assert(serialized.includes("Synthetic fork"));
  forkChecks++;
  const event = completion(`fork_${forkChecks}`);
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
};
globalThis.fetch = fakeFetch;
const runDetached = AsyncLocalStorage.snapshot();
const { createAiTransportHost, runWithAiTransportHost } =
  await import("../../packages/ai/src/host.js");
const { cleanupSessionResources } = await import("../../packages/ai/src/session-resources.js");
const { createOpenAIResponsesTransportStreamFn } =
  await import("../../packages/ai/src/transports/openai-responses-client.js");
const { wrapStreamFnWithSessionFork, runEmbeddedSessionFork } =
  await import("../../src/agents/embedded-agent-runner/session-fork.js");
const host = createAiTransportHost({
  runInDetachedAsyncContext: runDetached,
  buildModelFetch: () => fakeFetch,
});
const model: Model = {
  api: "openai-responses",
  provider: "openai",
  id: values.model,
  name: "Synthetic steering fixture",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 1024,
};
const references = {
  capturedOptions: [] as WeakRef<object>[],
  contexts: [] as WeakRef<object>[],
};
// Named arrays expose only weak edges for following surviving targets in heap snapshots.
Reflect.set(globalThis, "sessionForkRetentionReferences", references);
const transport = createOpenAIResponsesTransportStreamFn();
const observedTransport: StreamFn = (requestModel, context, options) => {
  if (options?.asyncToolExecution !== false) {
    const label = `${options?.sessionId}:${references.capturedOptions.length}`;
    Object.defineProperty(options!, "__forkClosureProbe", { value: `options:${label}` });
    Object.defineProperty(context, "__forkClosureProbe", { value: `context:${label}` });
    references.capturedOptions.push(new WeakRef(options!));
    references.contexts.push(new WeakRef(context));
  }
  return transport(requestModel, context, options);
};

async function populate(count: number) {
  for (let session = 0; session < count; session++) {
    const identity = { agentId: "synthetic", sessionId: `synthetic-${session}`, runId: "run" };
    const parent = wrapStreamFnWithSessionFork(observedTransport, identity);
    const messages: Message[] = Array.from({ length: history }, (_, index) => ({
      role: "user",
      content: [{ type: "text", text: `Synthetic history ${session}:${index} ${"x".repeat(256)}` }],
      timestamp: index,
    }));
    for (let turn = 0; turn < turns; turn++) {
      expectSteer = turn === turns - 1;
      messages.push({
        role: "user",
        content: `Synthetic parent ${session}:${turn}`,
        timestamp: history + turn,
      });
      const context: Context = { messages: [...messages] };
      let admission: Promise<boolean> | undefined;
      const options: StreamOptions = {
        apiKey: "synthetic-key",
        sessionId: identity.sessionId,
        transport: "websocket-cached",
        ...(expectSteer
          ? {
              onActiveResponse: (
                control: Parameters<NonNullable<StreamOptions["onActiveResponse"]>>[0],
              ) => {
                admission = control.steer([
                  { role: "user", content: "Synthetic steering", timestamp: history + turns },
                ]);
              },
            }
          : {}),
      };
      const result = await (await parent(model, context, options)).result();
      assert.equal(result.stopReason, "stop", result.errorMessage ?? "Synthetic request failed");
      if (expectSteer) {
        assert.equal(await admission, true, "the selected model must support native steering");
      }
      messages.push(result);
    }
  }
}

async function verifyForks(count: number) {
  for (let session = 0; session < count; session++) {
    assert.equal(
      await runEmbeddedSessionFork({
        agentId: "synthetic",
        sessionId: `synthetic-${session}`,
        model,
        apiKey: "synthetic-key",
        question: "Synthetic fork",
        assertCurrent: () => {},
      }),
      "Synthetic answer",
    );
  }
}

async function collect() {
  for (let round = 0; round < 4; round++) {
    await nextTurn();
    global.gc!();
  }
}
const survivors = (refs: WeakRef<object>[]) => refs.filter((reference) => reference.deref()).length;
const watchdog = setTimeout(() => {
  throw new Error("Synthetic transport did not settle; verify the model supports native steering");
}, 120000);
try {
  await runWithAiTransportHost(host, async () => {
    await populate(1);
    await verifyForks(1);
  });
  cleanupSessionResources(undefined, host);
  references.capturedOptions.length = 0;
  references.contexts.length = 0;
  createCalls = continuationCalls = steerCalls = forkChecks = 0;
  await collect();
  const before = process.memoryUsage();
  await runWithAiTransportHost(host, () => populate(sessions));
  await collect();
  const after = process.memoryUsage();
  const counts = {
    capturedOptions: survivors(references.capturedOptions),
    contexts: survivors(references.contexts),
  };
  assert.equal(createCalls, sessions * turns);
  assert.equal(steerCalls, sessions);
  assert.equal(openSockets, sessions);
  if (values["expect-released"]) {
    assert.deepEqual(counts, { capturedOptions: 0, contexts: 0 });
  }
  if (values.snapshot) {
    await nextTurn();
    writeHeapSnapshot(values.snapshot);
  }
  await runWithAiTransportHost(host, () => verifyForks(sessions));
  assert.equal(forkChecks, sessions);
  console.log(
    JSON.stringify({
      protocol: "session-fork-closure-retention-v1",
      node: process.version,
      sessions,
      turns,
      history,
      createCalls,
      continuationCalls,
      steerCalls,
      forkChecks,
      openSockets,
      observedOptions: references.capturedOptions.length,
      retained: counts,
      before,
      after,
      retainedHeapBytes: after.heapUsed - before.heapUsed,
      heapBytesPerSettledRequest: (after.heapUsed - before.heapUsed) / (sessions * turns),
      heapBytesPerSession: (after.heapUsed - before.heapUsed) / sessions,
      externalDeltaBytes: after.external - before.external,
      arrayBuffersDeltaBytes: after.arrayBuffers - before.arrayBuffers,
      scope:
        "real fork and Responses transport owners; fake physical socket/fetch; no Gateway or live provider",
    }),
  );
} finally {
  clearTimeout(watchdog);
  cleanupSessionResources(undefined, host);
  hooks.deregister();
  Reflect.deleteProperty(globalThis, socketKey);
  Reflect.deleteProperty(globalThis, "sessionForkRetentionReferences");
}
