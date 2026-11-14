// Real followup queue admission/drain/settlement with synthetic run contexts and payloads.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/queued-input-retention.ts \
//   --state-dir "$PWD/.local/queued-input-retention" --turns 1000 --mode timing
// Repeat with --mode allocation in a separate process; alternate base/candidate processes.
// Add --expect-bounded to the command above for the retained-context regression assertion.
// Each process measures N then 2N completed turns across four sessions while the five-minute
// dedupe window remains open. Each mailbox's idle-expiry timer still inherits an AsyncWorkScope
// retaining its latest turn; --expect-bounded allows that four-turn residual, not historical turns.
// Clearing the mailbox timers and dedupe registry must release every tracked object.
// Forced GC and optional --snapshot captures are outside the timing/allocation windows.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import type { AdmittedRunContext } from "../../src/agents/admitted-run-context.js";
import type { FollowupRun, QueueSettings } from "../../src/auto-reply/reply/queue/types.js";
import type {
  SessionControllerInput,
  SessionControllerMailbox,
} from "../../src/sessions/session-controller.contracts.js";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    turns: { type: "string", default: "1000" },
    "payload-bytes": { type: "string", default: "8192" },
    mode: { type: "string", default: "timing" },
    snapshot: { type: "boolean", default: false },
    "expect-bounded": { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "Provide an isolated synthetic --state-dir");
assert(global.gc, "Run with --expose-gc");
const turns = Number(values.turns);
const payloadBytes = Number(values["payload-bytes"]);
assert(Number.isSafeInteger(turns) && turns > 0 && turns <= 10000);
assert(Number.isSafeInteger(payloadBytes) && payloadBytes >= 4096);
assert(values.mode === "timing" || values.mode === "allocation");
const stateDir = path.resolve(values["state-dir"]);
await mkdir(stateDir, { recursive: true });
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;
const { prepareSystemAgentRunAdmission } = await import("../../src/agents/admitted-run-context.js");
const { getGatewayContextBindingSlot } =
  await import("../../src/plugins/runtime/gateway-context-binding-owner.js");
const { enqueueFollowupRun } = await import("../../src/auto-reply/reply/queue/enqueue.js");
const { admitFollowupRunLifecycle } = await import("../../src/auto-reply/reply/queue/lifecycle.js");
const { clearSessionControllerMailbox } =
  await import("../../src/sessions/session-controller.mailbox-cleanup.js");
const { completeFollowupRunLifecycle } =
  await import("../../src/auto-reply/reply/queue/lifecycle.js");
const { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } =
  await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot({
  logging: { level: "silent", consoleLevel: "silent", file: path.join(stateDir, "run.log") },
});

const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 20, dropPolicy: "old" };
const mailboxes = new Set<SessionControllerMailbox>();
const inputRefs: WeakRef<SessionControllerInput>[] = [];
const contextRefs: WeakRef<AdmittedRunContext>[] = [];
const bindingRefs: WeakRef<object>[] = [];
let completed = 0;
const execute = async (run: FollowupRun) => {
  await admitFollowupRunLifecycle(run);
  completed++;
};

function createRun(index: number, track: boolean) {
  const session = index % 4;
  const sessionKey = `agent:main:queued-retention-${session}`;
  const runId = `queued-retention-${index}`;
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "queued-retention-bench");
  const run: FollowupRun = {
    prompt: Buffer.alloc(payloadBytes, 65 + (index % 26)).toString(),
    messageId: runId,
    enqueuedAt: Date.now(),
    originatingChannel: "synthetic",
    originatingTo: `session:${session}`,
    turnAdoptionLifecycle: {
      async onAdopted() {
        const context = await admission.admit("embedded");
        if (track) {
          contextRefs.push(new WeakRef(context));
          const binding = getGatewayContextBindingSlot(context);
          assert(binding, "Admitted context must own a gateway binding slot");
          bindingRefs.push(new WeakRef(binding));
        }
      },
      onSettled: () => admission.close(),
    },
    run: {
      agentId: "main",
      agentDir: stateDir,
      sessionId: `queued-retention-session-${session}`,
      sessionKey,
      sessionFile: path.join(stateDir, `session-${session}.json`),
      workspaceDir: stateDir,
      config: { session: { store: path.join(stateDir, "sessions.json") } },
      provider: "openai",
      model: "mock",
      timeoutMs: 10000,
      blockReplyBreak: "text_end",
    },
  };
  return { run, admission, sessionKey };
}

async function completedTurn(index: number, track: boolean): Promise<void> {
  const { run, admission, sessionKey } = createRun(index, track);
  try {
    assert(enqueueFollowupRun(sessionKey, run, settings, "message-id", execute));
    const input = run.controllerInput;
    assert(input, "Enqueue must reserve its canonical controller input");
    mailboxes.add(input.mailbox);
    if (track) {
      inputRefs.push(new WeakRef(input));
    }
    await input.settlement.promise;
    assert.equal(input.phase, "consumed");
  } finally {
    admission.close();
  }
}

function assertRedeliveryRejected(count: number): void {
  for (let index = 0; index < Math.min(count, 4); index++) {
    const { run, admission, sessionKey } = createRun(index, false);
    try {
      assert.equal(
        enqueueFollowupRun(sessionKey, run, settings, "message-id", execute),
        false,
        "Collected source payloads must still deduplicate settled redelivery",
      );
    } finally {
      admission.close();
    }
  }
}

async function collect(): Promise<void> {
  for (let pass = 0; pass < 4; pass++) {
    await nextTurn();
    global.gc!();
  }
}
function liveCount(refs: readonly WeakRef<object>[]): number {
  return refs.filter((reference) => reference.deref() !== undefined).length;
}
function cleanupMailboxes(): void {
  for (const mailbox of mailboxes) {
    mailbox.recentSources.clear();
    clearSessionControllerMailbox(mailbox, completeFollowupRunLifecycle);
    mailbox.wake();
  }
  mailboxes.clear();
}

const inspector = new Session();
try {
  for (let index = 0; index < 20; index++) {
    await completedTurn(-index - 1, false);
  }
  cleanupMailboxes();
  completed = 0;
  await collect();
  const beforeHeap = process.memoryUsage().heapUsed;
  const checkpoints: Array<{
    retainedInputs: number;
    retainedContexts: number;
    retainedBindings: number;
  }> = [];
  if (values.mode === "allocation") {
    inspector.connect();
  }
  for (let stage = 0; stage < 2; stage++) {
    if (values.mode === "allocation") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const loadBefore = loadavg();
    const cpuBefore = process.cpuUsage();
    const start = performance.now();
    for (let offset = 0; offset < turns; offset++) {
      await completedTurn(stage * turns + offset, true);
    }
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuBefore);
    let sampledBytes: number | undefined;
    if (values.mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      sampledBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
    }
    await collect();
    const memory = process.memoryUsage();
    const retainedInputs = liveCount(inputRefs);
    const retainedContexts = liveCount(contextRefs);
    const retainedBindings = liveCount(bindingRefs);
    const dedupeEntries = [...mailboxes].reduce(
      (sum, mailbox) => sum + mailbox.recentSources.size,
      0,
    );
    assert.equal(completed, (stage + 1) * turns);
    assert.equal(contextRefs.length, completed);
    assert.equal(retainedBindings, retainedContexts);
    assert.equal(dedupeEntries, completed, "Measurement must finish before dedupe expiration");
    assertRedeliveryRejected(completed);
    checkpoints.push({ retainedInputs, retainedContexts, retainedBindings });
    console.log(
      JSON.stringify({
        mode: values.mode,
        node: process.version,
        iterations: turns,
        completed,
        sessions: 4,
        payloadBytes,
        wallMs,
        cpuMs: (cpu.user + cpu.system) / 1000,
        sampledBytes,
        sampledBytesPerTurn: sampledBytes === undefined ? undefined : sampledBytes / turns,
        retainedInputs,
        retainedContexts,
        retainedBindings,
        dedupeEntries,
        retainedBytes: memory.heapUsed - beforeHeap,
        heapUsed: memory.heapUsed,
        rss: memory.rss,
        loadBefore,
        loadAfter: loadavg(),
      }),
    );
    if (values.snapshot) {
      writeHeapSnapshot(path.join(stateDir, `completed-${completed}.heapsnapshot`));
    }
  }
  cleanupMailboxes();
  await collect();
  const afterCleanup = {
    inputs: liveCount(inputRefs),
    contexts: liveCount(contextRefs),
    bindings: liveCount(bindingRefs),
  };
  console.log(JSON.stringify({ afterCleanup }));
  assert.equal(afterCleanup.inputs, 0, "Cleanup must release benchmark inputs");
  assert.equal(afterCleanup.contexts, 0, "Cleanup must release admitted contexts");
  assert.equal(afterCleanup.bindings, 0, "Cleanup must release context binding slots");
  if (values["expect-bounded"]) {
    for (const checkpoint of checkpoints) {
      assert(
        checkpoint.retainedInputs <= 4,
        "Dedupe retained inputs beyond four latest idle turns",
      );
      assert(
        checkpoint.retainedContexts <= 4,
        "Dedupe retained admitted contexts beyond four latest idle turns",
      );
      assert(
        checkpoint.retainedBindings <= 4,
        "Dedupe retained binding slots beyond four latest idle turns",
      );
    }
  }
} finally {
  inspector.disconnect();
  cleanupMailboxes();
  clearRuntimeConfigSnapshot();
}
