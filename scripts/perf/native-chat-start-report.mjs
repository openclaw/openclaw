import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Join synthetic identities, never clocks from different processes. */
export function summarizeNativeChatStart(client, captures) {
  const phases = [
    "acknowledged",
    "run-start",
    "provider-start",
    "provider-serialized",
    "provider-headers",
    "provider-output",
  ];
  assert.equal(client.outcome, "measured", "Client workload or stop request was not successful");
  assert(Array.isArray(client.samples) && client.samples.length > 0);
  return client.samples.map((sample) => {
    assert.equal(
      sample.mockRequests,
      1,
      "Require exactly one mock request; report retries/background work separately",
    );
    const candidates = captures.filter((capture) =>
      capture.some(
        (event) =>
          event.type === "mark" && event.phase === "run-start" && event.runId === sample.runId,
      ),
    );
    assert.equal(candidates.length, 1, "Require exactly one server process per synthetic run");
    const capture = candidates[0];
    const start = capture.find((event) => event.type === "capture-start");
    const end = capture.find((event) => event.type === "capture-end");
    assert(start && end, "Collect the completed task-owned Gateway capture after shutdown");
    for (const name of ["droppedEvents", "unclassifiedIdentities", "writeFailures"]) {
      assert.equal(end[name], 0, `Invalid native capture: ${name}`);
    }
    assert(
      phases.every((phase) => end.anchors.includes(phase)),
      "Incomplete owner coverage",
    );
    assert(
      capture.every((event) => event.pid === start.pid),
      "Mixed capture process identities",
    );
    const marks = capture.filter((event) => event.type === "mark");
    const unique = (phase, runId, relatedId) => {
      const selected = marks.filter(
        (event) =>
          event.phase === phase &&
          event.runId === runId &&
          (relatedId === undefined || event.relatedId === relatedId),
      );
      assert.equal(selected.length, 1, `Require exactly one server milestone: ${phase}`);
      return selected[0];
    };
    const run = unique("run-start", sample.runId);
    const agentRunId = run.relatedId;
    assert(typeof agentRunId === "string");
    const ack = unique("acknowledged", sample.runId);
    const provider = marks.filter(
      (event) => event.runId === agentRunId && event.phase === "provider-start",
    );
    assert(ack && provider.length === 1, "Require one complete single-provider-call turn");
    const selected = new Map([
      ["acknowledged", ack],
      ["run-start", run],
      ["provider-start", provider[0]],
    ]);
    for (const phase of phases.slice(3)) {
      const event = unique(phase, agentRunId, provider[0].relatedId);
      selected.set(phase, event);
    }
    let previous = -Infinity;
    for (const phase of phases) {
      const time = selected.get(phase).atMs;
      assert(Number.isFinite(time) && time >= previous, "Server anchors are out of order");
      previous = time;
    }
    return {
      sample: sample.sample,
      serverPid: start.pid,
      architecture: start.architecture,
      serverClock: "same-process performance.now; instrumented diagnostic run",
      ackToRunStartMs: run.atMs - ack.atMs,
      runStartToProviderStartMs: provider[0].atMs - run.atMs,
      providerStartToSerializedMs: selected.get("provider-serialized").atMs - provider[0].atMs,
      serializedToHeadersMs:
        selected.get("provider-headers").atMs - selected.get("provider-serialized").atMs,
      headersToFirstSemanticOutputMs:
        selected.get("provider-output").atMs - selected.get("provider-headers").atMs,
      clientReceipt: sample,
      unavailable: ["raw network first byte", "paint", "unexplained work within each interval"],
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { client: { type: "string" }, "capture-dir": { type: "string" } },
  });
  assert(values.client && values["capture-dir"]);
  const client = JSON.parse(readFileSync(values.client, "utf8"));
  const captures = readdirSync(values["capture-dir"])
    .filter((name) => /^native-chat-\d+\.jsonl$/u.test(name))
    .map((name) =>
      readFileSync(path.join(values["capture-dir"], name), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  console.log(JSON.stringify(summarizeNativeChatStart(client, captures), null, 2));
}
