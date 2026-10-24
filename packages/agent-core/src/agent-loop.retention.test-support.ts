import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createTurnSequenceStream,
  makeAssistantMessage,
  makeCall,
  makeTool,
  model as baseModel,
  user,
} from "./agent-loop.test-support.js";
import { Agent } from "./agent.js";
import { getAgentToolExecutionContext } from "./tool-execution-context.js";
import type { AgentMessage } from "./types.js";

export type ContextRetentionResult = {
  calls: number;
  replacements: number;
  observedHistories: number;
  retained: number[];
  completed: boolean;
  settledToolContext: {
    snapshots: number;
    agentRetained: boolean;
    historyRetained: boolean;
    attributionPreserved: boolean;
    pendingInput: boolean;
  };
};

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const model = { ...baseModel, contextWindow: 1_000_000 };
const histories: WeakRef<AgentMessage>[] = [];
function history(): AgentMessage {
  const message = user(`old-history-${histories.length}:` + "x".repeat(1024 * 1024), 0);
  histories.push(new WeakRef(message));
  return message;
}
const finalMessage = () => makeAssistantMessage([{ type: "text", text: "complete" }]);
const held = createDeferred();
const parked = createAssistantMessageEventStream();
let calls = 0;
let replacements = 0;
let runSignal: AbortSignal | undefined;
const agent = new Agent({
  initialState: { model, messages: [history()] },
  streamFn: () => {
    if (++calls === 5) {
      held.resolve();
      return parked;
    }
    const response = createAssistantMessageEventStream();
    response.push({ type: "done", reason: "stop", message: finalMessage() });
    response.end();
    return response;
  },
  prepareNextTurnWithContext: (turn, signal) => {
    if (runSignal) {
      assert.equal(signal, runSignal);
    }
    runSignal = signal;
    if (replacements === 4) {
      return undefined;
    }
    replacements += 1;
    const summary = replacements < 4 ? history() : user("compact summary", 0);
    const messages = [summary, ...turn.newMessages];
    // The transcript owner must release history too; ordinary compaction runs after the core.
    agent.state.messages = messages;
    agent.steer(user("continue", replacements));
    return { context: { ...turn.context, messages } };
  },
});
const run = agent.prompt("begin");
let retained: number[] = [];
try {
  await Promise.race([
    held.promise,
    run.then(() => {
      throw new Error(
        `Run ended before its retention checkpoint: ${agent.state.errorMessage ?? "no error"}`,
      );
    }),
  ]);
  // Do not dereference during collection: WeakRef.deref keeps its target alive for that job.
  for (let pass = 0; pass < 8; pass += 1) {
    gc();
    await setImmediate();
  }
  retained = histories.flatMap((reference, index) => (reference.deref() ? [index] : []));
} finally {
  parked.push({ type: "done", reason: "stop", message: finalMessage() });
  parked.end();
  await run;
}
assert.equal(agent.state.errorMessage, undefined);

const snapshots: ReturnType<typeof AsyncLocalStorage.snapshot>[] = [];
function createContextCapturingTool() {
  return {
    ...makeTool("capture_context"),
    execute: async () => {
      assert.ok(getAgentToolExecutionContext()?.pendingInput);
      snapshots.push(AsyncLocalStorage.snapshot());
      return { content: [{ type: "text" as const, text: "captured" }], details: {} };
    },
  };
}

async function completeToolRun() {
  const oldHistory = user("settled-history:" + "x".repeat(1024 * 1024), 0);
  const completedAgent = new Agent({
    initialState: { model, messages: [oldHistory], tools: [createContextCapturingTool()] },
    streamFn: createTurnSequenceStream([
      [makeCall("capture_context", "retained-tool-call")],
      [{ type: "text", text: "complete" }],
    ]),
  });
  await completedAgent.prompt("capture this tool invocation");
  assert.equal(completedAgent.state.errorMessage, undefined);
  assert.equal(completedAgent.state.isStreaming, false);
  return { agent: new WeakRef(completedAgent), history: new WeakRef(oldHistory) };
}

const settled = await completeToolRun();
const unowned = new WeakRef({});
await setImmediate();
for (let pass = 0; pass < 8; pass += 1) {
  gc();
  await setImmediate();
}
assert.equal(unowned.deref(), undefined, "The unowned GC control must collect");
const restoredContext = snapshots[0]?.(() => {
  const context = getAgentToolExecutionContext();
  return {
    attributionPreserved:
      context?.toolCall.id === "retained-tool-call" &&
      context.assistantMessage.content.includes(context.toolCall),
    pendingInput: context?.pendingInput?.hasPending() ?? false,
  };
});
const result: ContextRetentionResult = {
  calls,
  replacements,
  observedHistories: histories.length,
  retained,
  completed: true,
  settledToolContext: {
    snapshots: snapshots.length,
    agentRetained: settled.agent.deref() !== undefined,
    historyRetained: settled.history.deref() !== undefined,
    attributionPreserved: restoredContext?.attributionPreserved === true,
    pendingInput: restoredContext?.pendingInput ?? false,
  },
};
process.stdout.write(JSON.stringify(result));
