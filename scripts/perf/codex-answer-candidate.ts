// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/codex-answer-candidate.ts
// Run identical baseline A/A controls and candidate B in separate processes.
// This text projection has no database, session inventory, or workspace I/O.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { CodexAssistantProjection } from "../../extensions/codex/src/app-server/event-projector-assistant.js";
import { readItem } from "../../extensions/codex/src/app-server/event-projector-values.js";

const deltas = Number(process.argv[2] ?? 2_000);
const rounds = Number(process.argv[3] ?? 10);
const chunk = "Synthetic answer.   ";
const answer = chunk.repeat(deltas);
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.enable");

async function run() {
  let candidateEvents = 0;
  let candidateBytes = 0;
  let assistantEvents = 0;
  let selectedText = "";
  const streamed: string[] = [];
  const projection = new CodexAssistantProjection(
    // SAFETY: this owner-only fixture reads only optional presentation callbacks.
    {} as ConstructorParameters<typeof CodexAssistantProjection>[0],
    (event) => {
      if (event.stream === "item" && event.data.kind === "answer_candidate") {
        candidateEvents++;
        const text = String(event.data.progressText);
        candidateBytes += Buffer.byteLength(text);
        // Model one subscriber serializing the actual event, without retaining copies.
        JSON.stringify(event);
        if (event.data.status === "selected") {
          selectedText = text;
        }
      } else if (event.stream === "assistant") {
        assistantEvents++;
        streamed.push(String(event.data.delta));
      }
    },
    () => false,
    () => 1,
  );
  const item = readItem({ type: "agentMessage", id: "answer", phase: "final_answer", text: "" });
  assert.ok(item);
  await projection.recordItemStarted(item, item.id);
  for (let index = 0; index < deltas; index++) {
    await projection.handleAssistantDelta({ itemId: item.id, delta: chunk });
  }
  item.text = answer;
  projection.recordItemCompleted(item, { itemId: item.id, activeItemIds: new Set() });
  projection.finalizeAnswerCandidate({ status: "completed", items: [item] });
  assert.equal(streamed.join(""), answer);
  assert.equal(selectedText, answer.trim());
  return { candidateEvents, candidateBytes, assistantEvents };
}

for (let index = 0; index < 5; index++) {
  await run();
}
const samples = [];
for (let index = 0; index < rounds; index++) {
  globalThis.gc?.();
  const cpu = process.cpuUsage();
  const start = performance.now();
  const counts = await run();
  const elapsedMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  samples.push({ elapsedMs, cpuMs: (used.user + used.system) / 1_000, ...counts });
}
// Allocation sampling is a separate pass so profiling overhead cannot skew timings.
await inspector.post("HeapProfiler.startSampling", {
  samplingInterval: 4096,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
for (let index = 0; index < rounds; index++) {
  await run();
}
const { profile } = await inspector.post("HeapProfiler.stopSampling");
const allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0) / rounds;
inspector.disconnect();
console.log(
  JSON.stringify({
    deltas,
    answerBytes: answer.length,
    load: os.loadavg(),
    allocatedBytes,
    samples,
  }),
);
