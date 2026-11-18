/**
 * Pending-user custody in actor append requests, using source-pinned admission/copy owners.
 * node --expose-gc scripts/perf/session-message-custody-payload-measure.mjs \
 *   --base-source <base-session-manager-message-admission.ts> [--iterations 3000]
 * Five counterbalanced AB/BA pairs, with untraced timing and separate sampled allocation.
 * Fixtures: a 32 KiB user body, either alone or collected from two 16 KiB source bodies;
 * assistant/tool-result messages have 1 KiB bodies. All identities and content are synthetic.
 * Measures exact captureSessionMessageAdmission, captureSessionPendingInputWorkerCustody,
 * and copySessionPendingInputWorkerFacts bodies plus V8 serialization of an actor append.
 * The capture's owner lookup is a fixed synthetic owner; authority callbacks are not invoked.
 * A serializer-only workload separates wire cost from admission/custody construction.
 * Excludes SQL, worker delivery, live authority, persistence, and Gateway traffic. This is
 * owner transport evidence, not production request frequency or a whole-Gateway census.
 * Acceptance: keyed-user payload stays equal, assistant/tool payload loses only unused
 * pendingInput, and bytes/CPU/allocation fall. Source hashes bind every extracted function.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { serialize } from "node:v8";
import { compileFunction } from "node:vm";

const { values } = parseArgs({
  options: {
    "base-source": { type: "string" },
    iterations: { type: "string", default: "3000" },
  },
});
assert(values["base-source"], "--base-source is required");
assert(global.gc, "Run with --expose-gc");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const pairs = 5;
const sources = {
  base: readFileSync(values["base-source"], "utf8"),
  candidate: readFileSync(
    new URL("../../src/agents/sessions/session-manager-message-admission.ts", import.meta.url),
    "utf8",
  ),
  custody: readFileSync(
    new URL("../../src/config/sessions/session-accessor.sqlite-pending-inputs.ts", import.meta.url),
    "utf8",
  ),
  copy: readFileSync(
    new URL("../../src/config/sessions/session-pending-input-live-owner.ts", import.meta.url),
    "utf8",
  ),
};

function extractedFunction(source, name, bindings = {}) {
  const js = stripTypeScriptTypes(source);
  const start = js.indexOf(`export function ${name}(`);
  const end = js.indexOf("\n}", start) + 2;
  assert(start >= 0 && end > start, `${name} moved; update workload extraction`);
  return compileFunction(
    `${js.slice(start, end).replace("export ", "")}\nreturn ${name};`,
    Object.keys(bindings),
  )(...Object.values(bindings));
}

const copy = extractedFunction(sources.copy, "copySessionPendingInputWorkerFacts");
const unusedAuthority = () => {
  throw new Error("This workload does not execute authority or publication callbacks");
};
function admissionFor(arm, owner) {
  const captureCustody = extractedFunction(
    sources.custody,
    "captureSessionPendingInputWorkerCustody",
    {
      owners: {
        current: { getStore: () => owner },
        relocation: { getStore: () => undefined },
      },
      copySessionPendingInputWorkerFacts: copy,
      assertPendingInputOwnerCurrent: unusedAuthority,
      publishSessionPendingInputWorkerReceipt: unusedAuthority,
    },
  );
  return extractedFunction(sources[arm], "captureSessionMessageAdmission", {
    captureSessionPendingInputWorkerCustody: captureCustody,
    isRecord: unusedAuthority,
  });
}

function pendingOwner(id, bodyBytes) {
  return {
    agentId: "synthetic",
    databaseAgentId: "synthetic",
    inputId: id,
    transcriptInputId: id,
    sessionId: "synthetic-session",
    sessionKey: "agent:synthetic:main",
    workerDatabasePath: "/synthetic/agent.sqlite",
    idempotencyKey: `key-${id}`,
    lifecycleGeneration: "synthetic-generation",
    messageJson: JSON.stringify({
      role: "user",
      content: "x".repeat(bodyBytes),
      idempotencyKey: `key-${id}`,
    }),
    authority: {},
  };
}
const scope = {
  agentId: "synthetic",
  sessionId: "synthetic-session",
  sessionKey: "agent:synthetic:main",
  storePath: "/synthetic/agent.sqlite",
  expectedWriterRunId: "synthetic-run",
  expectedLifecycleRevision: "synthetic-revision",
};
const target = {
  database: {
    kind: "file",
    nativeLocation: scope.storePath,
    physicalIdentity: "synthetic-identity",
    birthtime: 1,
  },
  sessionKey: scope.sessionKey,
};
const fixtures = [];
for (const collected of [false, true]) {
  const owner = pendingOwner("synthetic-input", 32 * 1024);
  if (collected) {
    owner.sources = [pendingOwner("source-a", 16 * 1024), pendingOwner("source-b", 16 * 1024)];
  }
  for (const role of ["assistant", "toolResult", "user"]) {
    const message =
      role === "user"
        ? JSON.parse(owner.messageJson)
        : {
            role,
            content: [{ type: "text", text: "y".repeat(1024) }],
            ...(role === "toolResult"
              ? { toolCallId: "synthetic-call", toolName: "synthetic-tool", isError: false }
              : {}),
          };
    const wireMessage = {
      messageJson: JSON.stringify(message),
      cwd: "/synthetic/workspace",
      validateTurn: true,
    };
    const captures = Object.fromEntries(
      ["base", "candidate"].map((arm) => [arm, admissionFor(arm, owner)]),
    );
    const command = (arm) => ({
      type: `session.actor.${role === "toolResult" ? "appendToolResult" : "appendTranscriptEvent"}`,
      input: {
        commandId: "synthetic-command",
        phaseId: "session-manager.append",
        target,
        entryReference: "synthetic-write-token",
        append: {
          kind: "metadata",
          input: {
            scope,
            event: {
              type: "message",
              id: "synthetic-event",
              parentId: "synthetic-parent",
              timestamp: "2026-01-01T00:00:00.000Z",
            },
            message: {
              ...wireMessage,
              ...captures[arm](
                unusedAuthority,
                { beforeFreshMessageCommit: unusedAuthority },
                message,
              ).control,
            },
            options: { appendIntent: "active-branch", expectedMutationAt: 1 },
            view: { limits: { maxEvents: 1000, maxBytes: 4 * 1024 * 1024 } },
          },
        },
      },
    });
    const prepared = { base: command("base"), candidate: command("candidate") };
    const baseMessage = prepared.base.input.append.input.message;
    const candidateMessage = prepared.candidate.input.append.input.message;
    assert(baseMessage.pendingInput, "Baseline must exhibit the redundant custody payload");
    if (role === "user") {
      assert.deepEqual(prepared.base, prepared.candidate);
    } else {
      assert.equal(candidateMessage.pendingInput, undefined);
      const { pendingInput: _unused, ...retained } = baseMessage;
      assert.deepEqual(candidateMessage, retained);
    }
    fixtures.push({ name: `${collected ? "collected" : "single"}-${role}`, command, prepared });
  }
}

console.log(
  JSON.stringify({
    kind: "fixture",
    node: process.version,
    iterations,
    pairs,
    hashes: Object.fromEntries(
      Object.entries(sources).map(([name, source]) => [
        name,
        createHash("sha256").update(source).digest("hex"),
      ]),
    ),
    payloads: fixtures.map(({ name, prepared }) => ({
      name,
      requestClass: prepared.base.type,
      baseBytes: serialize(prepared.base).byteLength,
      candidateBytes: serialize(prepared.candidate).byteLength,
    })),
  }),
);

let sink;
function run(fixture, arm, workload) {
  for (let index = 0; index < iterations; index++) {
    sink = serialize(workload === "serialize-only" ? fixture.prepared[arm] : fixture.command(arm));
  }
}
const inspector = new Session();
inspector.connect();
try {
  for (const fixture of fixtures) {
    for (const arm of ["base", "candidate"]) {
      run(fixture, arm, "capture-and-serialize");
    }
  }
  for (const phase of ["timing", "allocation"]) {
    for (const workload of ["capture-and-serialize", "serialize-only"]) {
      for (const fixture of fixtures) {
        for (let pair = 0; pair < pairs; pair++) {
          for (const arm of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
            sink = undefined;
            global.gc();
            if (phase === "allocation") {
              await inspector.post("HeapProfiler.startSampling", {
                samplingInterval: 4096,
                includeObjectsCollectedByMajorGC: true,
                includeObjectsCollectedByMinorGC: true,
              });
            }
            const hostLoad = loadavg();
            const cpu = process.threadCpuUsage();
            const at = performance.now();
            run(fixture, arm, workload);
            const elapsedMs = performance.now() - at;
            const used = process.threadCpuUsage(cpu);
            let allocatedBytesPerOperation;
            if (phase === "allocation") {
              const { profile } = await inspector.post("HeapProfiler.stopSampling");
              allocatedBytesPerOperation =
                profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations;
            }
            console.log(
              JSON.stringify({
                kind: "arm",
                fixture: fixture.name,
                phase,
                workload,
                pair,
                arm,
                iterations,
                serializedBytes: sink.byteLength,
                cpuUsPerOperation: (used.user + used.system) / iterations,
                elapsedMs,
                allocatedBytesPerOperation,
                hostLoad,
                memory: process.memoryUsage(),
              }),
            );
          }
        }
      }
    }
  }
} finally {
  inspector.disconnect();
}
