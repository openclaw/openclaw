// Replay synthetic provider events through the real embedded subscriber; no provider or Gateway I/O.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/reply-directives-stream-measure.ts
// Optionally pass a workload name to isolate a cell; imports are untimed.
// Compare identical runs on base/candidate, interleaving five A/A/B rounds.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadavg } from "node:os";
import { getHeapStatistics } from "node:v8";
import { subscribeEmbeddedAgentSession } from "../../src/agents/embedded-agent-subscribe.js";
import { Agent } from "../../src/agents/runtime/index.js";
import { sessionManagerReadTranscriptStart } from "../../src/agents/sessions/session-manager-current-turn.js";
import { makeAgentAssistantMessage } from "../../src/agents/test-helpers/agent-message-fixtures.js";
import type { ReplyPayload } from "../../src/auto-reply/types.js";

const body = "Ordinary prose for the operator. ".repeat(1100).slice(0, 32_768).trimEnd();
const workloads = {
  plain: body,
  media: `MEDIA: ./chart.png\n${body}`,
  reply: `[[reply_to_current]]${body}`,
  voice: `[[audio_as_voice]]${body}`,
  mixed: `[[reply_to_current]]${body.slice(0, 16000)}\n\nMEDIA: ./chart.png\n${body.slice(16000)}`,
};
const selected = process.argv[2];
assert(!selected || Object.hasOwn(workloads, selected), "Unknown workload");
const collect = globalThis.gc;
assert(collect, "Run with --expose-gc");
assert(Number.isFinite(getHeapStatistics().total_allocated_bytes), "Requires Node 26.12+");
const turns = 8;
const chunkSize = 32;
type Params = Parameters<typeof subscribeEmbeddedAgentSession>[0];
type Listener = Parameters<Params["session"]["subscribe"]>[0];

async function replay(text: string, block: boolean) {
  let listener: Listener | undefined;
  let lastPartial = "";
  const blocks: ReplyPayload[] = [];
  // The session supplies only the event source; parsing, projection, chunking and delivery are real.
  const session = {
    agent: new Agent(),
    sessionManager: { [sessionManagerReadTranscriptStart]: () => null },
    subscribe(callback: Listener) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as Params["session"];
  const subscription = subscribeEmbeddedAgentSession({
    session,
    runId: "synthetic-directive-stream",
    onPartialReply: (payload) => {
      lastPartial = payload.text ?? "";
    },
    ...(block
      ? {
          onBlockReply: (payload: ReplyPayload) => {
            blocks.push(payload);
          },
        }
      : {}),
    blockReplyBreak: "text_end",
    blockReplyChunking: { minChars: 600, maxChars: 1200, breakPreference: "paragraph" },
  });
  assert(listener);
  const message = (value: string) =>
    makeAgentAssistantMessage({
      content: [
        {
          type: "text",
          text: value,
          textSignature: JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
        },
      ],
    });
  try {
    listener({ type: "message_start", message: message("") });
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      const partial = message(text.slice(0, offset + chunkSize));
      listener({
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: text.slice(offset, offset + chunkSize),
          partial,
        },
      });
    }
    const final = message(text);
    listener({
      type: "message_update",
      message: final,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: text,
        partial: final,
      },
    });
    listener({ type: "message_end", message: final });
    await subscription.waitForPendingEvents();
    subscription.flushPartialAssistantText();
    assert(lastPartial.includes("Ordinary prose"));
    assert(!lastPartial.includes("[[reply_to_current]]"));
    assert(!lastPartial.includes("[[audio_as_voice]]"));
    assert(!lastPartial.includes("MEDIA:"));
    if (block) {
      assert(blocks.length > 0);
    }
    return createHash("sha256").update(JSON.stringify({ lastPartial, blocks })).digest("hex");
  } finally {
    subscription.unsubscribe();
  }
}

console.log(JSON.stringify({ node: process.version, load: loadavg(), turns, chunkSize }));
for (const [workload, text] of Object.entries(workloads)) {
  if (selected && selected !== workload) {
    continue;
  }
  for (const block of [false, true]) {
    const expected = await replay(text, block);
    await replay(text, block);
    collect();
    const allocated = getHeapStatistics().total_allocated_bytes;
    const cpu = process.cpuUsage();
    const started = performance.now();
    for (let turn = 0; turn < turns; turn++) {
      assert.equal(await replay(text, block), expected);
    }
    const wallMs = (performance.now() - started) / turns;
    const used = process.cpuUsage(cpu);
    console.log(
      JSON.stringify({
        workload,
        block,
        chars: text.length,
        deltas: Math.ceil(text.length / chunkSize),
        wallMs,
        cpuMs: (used.user + used.system) / 1000 / turns,
        allocatedBytes: (getHeapStatistics().total_allocated_bytes - allocated) / turns,
        outputHash: expected,
      }),
    );
  }
}
