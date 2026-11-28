import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Join producer ordinals and synthetic identities, never clocks from different processes. */
export function summarizeNativeChatStart(client, captures, mockFinal) {
  const phases = [
    "acknowledged",
    "run-start",
    "provider-start",
    "provider-serialized",
    "provider-headers",
    "provider-output",
  ];
  const knownBackground = new Set([
    "session-activity-summary",
    "session-observer",
    "session-title",
  ]);
  const counter = (value) => {
    assert(Number.isSafeInteger(value) && value >= 0, "Invalid mock counter");
    return value;
  };
  const uuid = (value) =>
    typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value);
  const pid = (value) => Number.isSafeInteger(value) && value > 0;
  const validCallId = (value, runId) =>
    uuid(value) ||
    (typeof value === "string" &&
      value.startsWith(`${runId}:model:`) &&
      /^[1-9]\d*$/u.test(value.slice(runId.length + 7)));
  assert.equal(client.outcome, "measured", "Client workload or stop request was not successful");
  assert(Array.isArray(client.samples) && client.samples.length > 0);
  assert(
    mockFinal?.mock?.requests?.accounting,
    "Require a retained final mock accounting snapshot after Gateway exit",
  );
  const mock = mockFinal.mock.requests;
  assert(uuid(mock.id), "Missing valid mock instance identity");
  assert.equal(mock.accounting.version, 1);
  assert.equal(mock.accounting.dropped, 0, "Mock request accounting lost observations");
  assert.equal(client.mockInitial?.id, mock.id, "Missing or changed mock instance identity");
  const ingress = { responses: 0, embeddings: 0, chatCompletions: 0, other: 0 };
  assert(Array.isArray(mock.accounting.entries));
  for (const entry of mock.accounting.entries) {
    assert(Object.hasOwn(ingress, entry.route), "Unknown mock route");
    assert.equal(entry.ordinal, ++ingress[entry.route], "Missing or duplicated producer ordinal");
  }
  for (const route of Object.keys(ingress)) {
    assert.equal(
      ingress[route],
      counter(mock.ingress[route]),
      "Producer accounting does not cover every mock request",
    );
  }
  assert.equal(
    ingress.chatCompletions + ingress.other,
    0,
    "Unexplained non-Responses completion traffic",
  );
  let priorResponses = counter(client.mockInitial.responses);
  let priorEmbeddings = counter(client.mockInitial.embeddings);
  for (const sample of client.samples) {
    assert(uuid(sample.runId), "Missing measured run identity");
    assert.equal(sample.mockBefore?.id, mock.id, "Missing sample mock identity");
    assert.equal(sample.mockAfter?.id, mock.id, "Mock changed during a sample");
    const before = counter(sample.mockBefore.responses);
    const after = counter(sample.mockAfter.responses);
    const embeddingsBefore = counter(sample.mockBefore.embeddings);
    const embeddingsAfter = counter(sample.mockAfter.embeddings);
    assert(
      before >= priorResponses && after >= before && after <= ingress.responses,
      "Mock response windows moved backwards",
    );
    assert(
      embeddingsBefore >= priorEmbeddings &&
        embeddingsAfter >= embeddingsBefore &&
        embeddingsAfter <= ingress.embeddings,
      "Mock embedding windows moved backwards",
    );
    assert.equal(
      sample.mockRequests,
      after - before,
      "Sample delta disagrees with producer ordinals",
    );
    priorResponses = after;
    priorEmbeddings = embeddingsAfter;
  }

  const candidates = captures.filter((capture) =>
    capture.some(
      (event) =>
        event.type === "mark" &&
        event.phase === "run-start" &&
        client.samples.some((sample) => sample.runId === event.runId),
    ),
  );
  assert.equal(candidates.length, 1, "Require exactly one server process per synthetic run");
  const capture = candidates[0];
  const starts = capture.filter((event) => event.type === "capture-start");
  const ends = capture.filter((event) => event.type === "capture-end");
  assert(
    starts.length === 1 && ends.length === 1,
    "Collect the completed task-owned Gateway capture after shutdown",
  );
  const [start] = starts;
  const [end] = ends;
  assert.equal(start.role, "gateway", "Missing measured process role identity");
  assert(pid(start.pid), "Missing measured process PID");
  const completion = mockFinal.completion;
  assert(
    completion?.mainPid === start.pid &&
      completion.foregroundExitCode === 0 &&
      completion.listenerClosed === true,
    "Require a verified post-exit mock collection receipt",
  );
  assert(
    Array.isArray(completion.observedStoppedPids) &&
      completion.observedStoppedPids.every(pid) &&
      captures.every(
        (value) =>
          value[0]?.type === "capture-start" &&
          completion.observedStoppedPids.includes(value[0].pid),
      ),
    "A captured process was not observed stopped before final mock collection",
  );
  assert.equal(end.exitCode, 0, "Measured Gateway did not exit successfully");
  for (const name of ["droppedEvents", "unclassifiedIdentities", "writeFailures"]) {
    assert.equal(end[name], 0, `Invalid native capture: ${name}`);
  }
  assert(
    [...phases, "completion-owner", "request-correlation"].every((phase) =>
      end.anchors.includes(phase),
    ),
    "Incomplete owner coverage",
  );
  assert(
    capture.every((event) => event.pid === start.pid),
    "Mixed capture process identities",
  );
  const marks = capture.filter((event) => event.type === "mark");
  for (const mark of marks) {
    assert(uuid(mark.runId), "Missing captured run identity");
    if (mark.phase === "run-start") {
      assert(uuid(mark.relatedId), "Missing admitted agent run identity");
    } else if (mark.phase.startsWith("provider-")) {
      assert(validCallId(mark.relatedId, mark.runId), "Missing captured provider call identity");
    }
  }
  const unique = (phase, runId, callId) => {
    const matches = marks.filter(
      (event) =>
        event.phase === phase &&
        event.runId === runId &&
        (callId === undefined || event.relatedId === callId),
    );
    assert.equal(matches.length, 1, `Require exactly one server milestone: ${phase}`);
    return matches[0];
  };
  const calls = marks
    .filter((event) => event.phase === "provider-start")
    .map((event) => {
      const serialized = unique("provider-serialized", event.runId, event.relatedId);
      const headers = unique("provider-headers", event.runId, event.relatedId);
      assert(
        Number.isInteger(headers.status) && headers.status >= 200 && headers.status < 300,
        "Provider headers reported an HTTP error or missing status",
      );
      assert([event.atMs, serialized.atMs, headers.atMs].every(Number.isFinite));
      assert(
        event.atMs <= serialized.atMs && serialized.atMs <= headers.atMs,
        "Server anchors are out of order",
      );
      return { start: event, serialized, headers };
    });
  for (const mark of marks.filter((event) => event.phase.startsWith("provider-"))) {
    assert(phases.includes(mark.phase), "Unknown provider milestone");
    const matches = calls.filter(
      (call) => call.start.runId === mark.runId && call.start.relatedId === mark.relatedId,
    );
    assert.equal(matches.length, 1, "Orphan or duplicate provider owner");
    unique(mark.phase, mark.runId, mark.relatedId);
  }
  for (const phase of ["acknowledged", "run-start"]) {
    assert.equal(
      marks.filter((event) => event.phase === phase).length,
      client.samples.length,
      "Unexplained foreground run",
    );
  }
  const responses = mock.accounting.entries.filter((entry) => entry.route === "responses");
  const responseIdentities = new Set();
  for (const request of responses) {
    assert(
      pid(request.pid) && uuid(request.runId) && validCallId(request.callId, request.runId),
      "Unattributed mock response identity",
    );
    const identity = `${request.pid}:${request.runId}:${request.callId}`;
    assert(
      !responseIdentities.has(identity),
      "Retried provider call sent more than one mock request",
    );
    responseIdentities.add(identity);
  }
  assert.equal(responses.length, calls.length, "Unattributed or unexplained extra mock response");
  for (const request of responses) {
    assert.equal(request.pid, start.pid, "Unattributed mock response process");
    const matches = calls.filter(
      (call) => call.start.runId === request.runId && call.start.relatedId === request.callId,
    );
    assert.equal(matches.length, 1, "Unattributed mock response identity");
    matches[0].request = request;
  }
  const measuredIds = new Set();
  const selectedCalls = new Set();
  const samples = client.samples.map((sample) => {
    assert(!measuredIds.has(sample.runId), "Repeated measured run identity");
    measuredIds.add(sample.runId);
    const run = unique("run-start", sample.runId);
    const ack = unique("acknowledged", sample.runId);
    const providers = calls.filter((call) => call.start.runId === run.relatedId);
    assert.equal(providers.length, 1, "Require one complete single-provider-call turn");
    const [call] = providers;
    assert.equal(call.start.owner, "agent-turn", "Measured call is not owned by the admitted turn");
    const output = unique("provider-output", run.relatedId, call.start.relatedId);
    assert([ack.atMs, run.atMs, output.atMs].every(Number.isFinite));
    assert(
      ack.atMs <= run.atMs && run.atMs <= call.start.atMs && call.headers.atMs <= output.atMs,
      "Server anchors are out of order",
    );
    assert(
      call.request.ordinal > sample.mockBefore.responses &&
        call.request.ordinal <= sample.mockAfter.responses,
      "Measured request was outside its producer window",
    );
    selectedCalls.add(call);
    return {
      sample: sample.sample,
      serverPid: start.pid,
      architecture: start.architecture,
      serverClock: "same-process performance.now; instrumented diagnostic run",
      ackToRunStartMs: run.atMs - ack.atMs,
      runStartToProviderStartMs: call.start.atMs - run.atMs,
      providerStartToSerializedMs: call.serialized.atMs - call.start.atMs,
      serializedToHeadersMs: call.headers.atMs - call.serialized.atMs,
      headersToFirstSemanticOutputMs: output.atMs - call.headers.atMs,
      clientReceipt: sample,
      serverObservationWindow: { fromMs: ack.atMs, untilMs: output.atMs },
    };
  });
  const backgroundOperations = new Set();
  const backgroundRuns = calls
    .filter((call) => !selectedCalls.has(call))
    .map((call) => {
      assert(knownBackground.has(call.start.owner), "Unattributed background owner");
      assert(
        uuid(call.start.ownerOperationId) && !backgroundOperations.has(call.start.ownerOperationId),
        "Retried or unidentified background operation",
      );
      backgroundOperations.add(call.start.ownerOperationId);
      return {
        owner: call.start.owner,
        runId: call.start.runId,
        callId: call.start.relatedId,
        ownerOperationId: call.start.ownerOperationId,
        mockOrdinal: call.request.ordinal,
        fromMs: call.start.atMs,
        headersAtMs: call.headers.atMs,
        observedOverlap: samples.flatMap((sample) => {
          const overlap =
            Math.min(call.headers.atMs, sample.serverObservationWindow.untilMs) -
            Math.max(call.start.atMs, sample.serverObservationWindow.fromMs);
          return overlap > 0 ? [{ sample: sample.sample, requestToHeadersOverlapMs: overlap }] : [];
        }),
        completion: "2xx headers observed; background result/stream completion unverified",
      };
    });
  for (const sample of samples) {
    const window = sample.clientReceipt;
    const contained = responses.filter(
      (request) =>
        request.ordinal > window.mockBefore.responses &&
        request.ordinal <= window.mockAfter.responses,
    );
    assert.equal(contained.length, window.mockRequests, "Unexplained request in a sample window");
    sample.mockWindow = {
      measuredRequests: contained.filter(
        (request) => request.runId === unique("run-start", window.runId).relatedId,
      ).length,
      backgroundRequests: contained.filter((request) =>
        backgroundRuns.some((run) => run.callId === request.callId),
      ).length,
    };
    assert.equal(
      sample.mockWindow.measuredRequests + sample.mockWindow.backgroundRequests,
      contained.length,
      "Unexplained per-sample request owner",
    );
  }

  const helperCaptures = captures
    .filter((value) => value !== capture)
    .map((helper) => {
      const identity = helper.find((event) => event.type === "capture-start");
      assert(
        identity && pid(identity.pid) && helper.every((event) => event.pid === identity.pid),
        "Invalid helper identity",
      );
      assert(
        !helper.some((event) => event.type === "mark" || event.type === "owner-installed"),
        "Unexpected secondary provider/owner process",
      );
      const terminal = helper.find((event) => event.type === "capture-end");
      if (!terminal) {
        assert(
          identity.role === "helper" &&
            ["payload-module", "external-module", "inline"].includes(identity.entryKind),
          "Incomplete process cannot be excluded from completion ownership",
        );
      } else {
        assert.equal(terminal.exitCode, 0, "Helper exited unsuccessfully");
        for (const name of ["droppedEvents", "unclassifiedIdentities", "writeFailures"]) {
          assert.equal(terminal[name], 0, "Helper lost observations");
        }
      }
      return {
        pid: identity.pid,
        role: identity.role,
        entryKind: identity.entryKind,
        entrySha256: identity.entrySha256,
        disposition: terminal ? "completed-noncompletion-helper" : "unjoined-noncompletion-helper",
      };
    });
  return {
    scope:
      "Measured Gateway main-process Responses completions; not whole process-tree or embedding latency",
    requestAccounting: {
      instanceId: mock.id,
      responses: ingress.responses,
      measured: samples.length,
      background: backgroundRuns.length,
      embeddings: ingress.embeddings,
      backgroundByPurpose: Object.fromEntries(
        [...knownBackground].map((owner) => [
          owner,
          backgroundRuns.filter((run) => run.owner === owner).length,
        ]),
      ),
    },
    samples,
    backgroundRuns,
    helperCaptures,
    limitations: [
      "Background overlap is observed request-start to headers, not causal blocking or complete background duration.",
      "A background stream failure after 2xx headers is not detected; background semantic success is not claimed.",
      "Embedding requests are endpoint-counted separately, without caller/process/latency attribution.",
      "Caller-level retries that invoke a new isolated operation are counted as separate background operations, not silently merged.",
      "Excluded helpers are not completion owners in the exhaustive mock Responses ledger; their lifecycle/resource completeness is not certified.",
      "Raw network first byte, paint and unexplained work within intervals remain unavailable.",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      client: { type: "string" },
      "capture-dir": { type: "string" },
      "mock-final": { type: "string" },
    },
  });
  assert(
    values.client && values["capture-dir"] && values["mock-final"],
    "Supply retained client, capture and final mock evidence",
  );
  const client = JSON.parse(readFileSync(values.client, "utf8"));
  const captures = readdirSync(values["capture-dir"])
    .filter((name) => /^native-chat-\d+\.jsonl$/u.test(name))
    .map((name) =>
      readFileSync(path.join(values["capture-dir"], name), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  console.log(
    JSON.stringify(
      summarizeNativeChatStart(
        client,
        captures,
        JSON.parse(readFileSync(values["mock-final"], "utf8")),
      ),
      null,
      2,
    ),
  );
}
