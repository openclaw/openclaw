import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeAssistantMessage, model as baseModel, user } from "./agent-loop.test-support.js";
import { Agent } from "./agent.js";
import type { AgentMessage } from "./types.js";

export type ContextRetentionResult = {
  calls: number;
  replacements: number;
  observedHistories: number;
  retained: number[];
  completed: boolean;
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
const result: ContextRetentionResult = {
  calls,
  replacements,
  observedHistories: histories.length,
  retained,
  completed: true,
};
process.stdout.write(JSON.stringify(result));
