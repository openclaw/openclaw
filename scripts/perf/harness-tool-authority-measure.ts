/**
 * Harness/CLI authority-copy owner probe (synthetic state; no external provider).
 * OPENCLAW_STATE_DIR="$PWD/.local/authority-measure/state" \
 * OPENCLAW_HOME="$PWD/.local/authority-measure/home" \
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/harness-tool-authority-measure.ts \
 *   --iterations 3000 --mode timing|allocation|promotion --output <file.json>
 * Optional --owner <absolute module path> selects the owner to measure.
 * --baseline <module path> --pairs 5 runs counterbalanced pairs in one process;
 * output files receive pair/arm suffixes. Both owners warm up before every pass.
 * --boundary harness|cli selects the real wrapper. Baseline modules must retain
 * their relative imports (for example a temporary adjacent copy from the base).
 * 205-property attempt/internal inputs match the dispatch literal's breadth; 40 synthetic plugin
 * configs and 64 concurrent retained owners model a busy shared Gateway's input shape.
 * Each wrapper prepares and binds authority, retains it across an async turn,
 * then closes. The harness uses an empty policy-session scope to exclude storage
 * reads while retaining a routed requester. Run five counterbalanced pairs.
 * Compare timing without heap sampling; allocation includes minor- and major-collected
 * samples; promotion excludes minor-collected samples. Sampling is an estimate,
 * not V8's exact promoted-byte counter. No forced GC inside the measured workload.
 * For exact promotion/scavenge totals, add --trace-gc-nvp in a separate timing pass;
 * sum promoted= and gc=s events between each measurement's start/end markers.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../src/agents/admitted-run-context.js";
import type { RunCliAgentParams } from "../../src/agents/cli-runner/types.js";
import type { ReplyToolAuthorityInput } from "../../src/auto-reply/reply/reply-tool-authority.types.js";
import { captureRuntimeConfig } from "../../src/config/runtime-source-projection.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "3000" },
    mode: { type: "string", default: "timing" },
    owner: { type: "string" },
    baseline: { type: "string" },
    pairs: { type: "string", default: "1" },
    output: { type: "string" },
    boundary: { type: "string", default: "harness" },
  },
});
const iterations = Number(values.iterations);
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(pairs) && pairs > 0);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["timing", "allocation", "promotion"].includes(values.mode));
assert(["harness", "cli"].includes(values.boundary));
assert(globalThis.gc, "Use --expose-gc");
const collectGarbage = globalThis.gc;
assert(
  process.env.OPENCLAW_STATE_DIR && process.env.OPENCLAW_HOME,
  "Set isolated state/home paths",
);
const {
  withPreparedEmbeddedRunToolAuthority,
}: typeof import("../../src/agents/harness/tool-authority.runtime.js") = await import(
  values.owner && values.boundary === "harness"
    ? pathToFileURL(values.owner).href
    : "../../src/agents/harness/tool-authority.runtime.js"
);
const {
  captureCliRunToolAuthority,
}: typeof import("../../src/agents/cli-runner/tool-authority.js") = await import(
  values.owner && values.boundary === "cli"
    ? pathToFileURL(values.owner).href
    : "../../src/agents/cli-runner/tool-authority.js"
);
const baselineHarness: typeof withPreparedEmbeddedRunToolAuthority =
  values.baseline && values.boundary === "harness"
    ? (await import(pathToFileURL(values.baseline).href)).withPreparedEmbeddedRunToolAuthority
    : withPreparedEmbeddedRunToolAuthority;
const baselineCli: typeof captureCliRunToolAuthority =
  values.baseline && values.boundary === "cli"
    ? (await import(pathToFileURL(values.baseline).href)).captureCliRunToolAuthority
    : captureCliRunToolAuthority;
const route = { provider: "synthetic", model: "synthetic-model" };
let authorityChecks = 0;
const authority = createAdmittedRunOperatorAuthority({
  profileId: "synthetic-operator",
  scopes: ["operator.read", "operator.write", "operator.admin"],
  assertCurrent() {
    authorityChecks++;
  },
});
const config = captureRuntimeConfig({
  plugins: {
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `synthetic-plugin-${index}`,
        { enabled: true, config: { allow: ["synthetic"] } },
      ]),
    ),
  },
  tools: { profile: "full", deny: ["synthetic-denied-tool"] },
});
const input: ReplyToolAuthorityInput = {
  operatorAuthority: authority,
  originatingChannel: "telegram",
  run: {
    ...route,
    config,
    sessionId: "synthetic-session",
    sessionFile: "/synthetic/session.jsonl",
    workspaceDir: "/synthetic/workspace",
    senderId: "synthetic-user",
    senderIsOwner: true,
    messageProvider: "telegram",
    permissionMode: "full",
    clientCaps: ["ui-commands"],
    gatewayUiCommandTarget: { connId: "synthetic-client", profileId: authority.profileId },
    toolBindings: { browser: { kind: "tab", targetId: "synthetic-tab" } },
  },
};
let fingerprint: string | undefined;
const attempt = {
  ...input.run,
  modelId: route.model,
  runId: "synthetic-run",
  agentId: "main",
  sessionKey: "agent:main:synthetic",
  sandboxSessionKey: "",
  runtimePolicySessionKey: "",
  prompt: "synthetic prompt",
  timeoutMs: 1000,
};
const admission = prepareAgentRunAdmission({
  cfg: config,
  operationalRunInstance: createOperationalRunInstanceRef(attempt.runId),
  operatorAuthority: authority,
  facts: {
    agentId: "main",
    runId: attempt.runId,
    ingress: { kind: "system", state: "present", boundary: "authority-benchmark" },
  },
});
const admittedRunContext = await admission.admit("embedded", "authority-benchmark");
const internal = { admittedRunContext, sessionPersistence: "detached" as const };
const cliAttempt: RunCliAgentParams = {
  ...route,
  config,
  sessionId: attempt.sessionId,
  sessionFile: attempt.sessionFile,
  sessionKey: attempt.sessionKey,
  runtimePolicySessionKey: "",
  workspaceDir: attempt.workspaceDir,
  senderId: attempt.senderId,
  senderIsOwner: attempt.senderIsOwner,
  messageProvider: attempt.messageProvider,
  clientCaps: attempt.clientCaps,
  gatewayUiCommandTarget: attempt.gatewayUiCommandTarget,
  runId: attempt.runId,
  prompt: attempt.prompt,
  timeoutMs: attempt.timeoutMs,
  admittedRunContext,
};
// Runtime attempts include optional fields even when absent; model their property cost.
for (const params of [attempt, internal, cliAttempt]) {
  for (let index = Object.keys(params).length; index < 205; index++) {
    Reflect.set(params, `unrelatedAttemptField${index}`, undefined);
  }
}
async function workload(
  count: number,
  harness = withPreparedEmbeddedRunToolAuthority,
  cli = captureCliRunToolAuthority,
) {
  for (let offset = 0; offset < count; offset += 64) {
    if (values.boundary === "harness") {
      await Promise.all(
        Array.from({ length: Math.min(64, count - offset) }, () =>
          harness(internal, attempt, undefined, async (prepared) => {
            fingerprint ??= prepared.toolAuthorityFingerprint;
            assert.equal(prepared.toolAuthorityFingerprint, fingerprint);
            await setImmediate();
          }),
        ),
      );
      continue;
    }
    await Promise.all(
      Array.from({ length: Math.min(64, count - offset) }, async () => {
        using owner = cli(cliAttempt, {
          agentId: "main",
          workspaceDir: input.run.workspaceDir,
          cwd: input.run.workspaceDir,
        });
        const bound = await owner.bindQuestions(route, () => authority);
        fingerprint ??= bound.fingerprint;
        assert.equal(bound.fingerprint, fingerprint);
        const question = bound.bindQuestionAnswerAuthority(() => {});
        question.assertActive();
        await setImmediate();
        question.assertActive();
      }),
    );
  }
}
async function measure(
  label: string,
  harness: typeof withPreparedEmbeddedRunToolAuthority,
  cli: typeof captureCliRunToolAuthority,
) {
  const output =
    values.output && (values.baseline ? `${values.output}.${label}.json` : values.output);
  await workload(256, harness, cli);
  collectGarbage();
  authorityChecks = 0;
  const inspector = new Session();
  inspector.connect();
  if (values.mode !== "timing") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: values.mode === "allocation",
    });
  }
  const before = process.memoryUsage();
  const hostLoad = os.loadavg();
  console.log(JSON.stringify({ measurement: label, phase: "start" }));
  const cpu = process.cpuUsage();
  const started = performance.now();
  await workload(iterations, harness, cli);
  const elapsedMs = performance.now() - started;
  const cpuUsage = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  console.log(JSON.stringify({ measurement: label, phase: "end" }));
  let sampledBytes: number | undefined;
  if (values.mode !== "timing") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: typeof profile.head): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledBytes = sum(profile.head);
    if (output) {
      await writeFile(`${output}.heapprofile`, JSON.stringify(profile));
    }
  }
  inspector.disconnect();
  const result = {
    label,
    iterations,
    mode: values.mode,
    boundary: values.boundary,
    attemptProperties: Object.keys(attempt).length,
    internalProperties: Object.keys(internal).length,
    fingerprint,
    authorityChecks,
    hostLoad,
    elapsedMs,
    cpuMs: (cpuUsage.user + cpuUsage.system) / 1000,
    sampledBytes,
    sampledBytesPerReply: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    before,
    after,
  };
  if (output) {
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify(result));
}
try {
  for (let pair = 1; pair <= pairs; pair++) {
    const arms = values.baseline
      ? [
          { label: "base", harness: baselineHarness, cli: baselineCli },
          {
            label: "candidate",
            harness: withPreparedEmbeddedRunToolAuthority,
            cli: captureCliRunToolAuthority,
          },
        ]
      : [
          {
            label: "owner",
            harness: withPreparedEmbeddedRunToolAuthority,
            cli: captureCliRunToolAuthority,
          },
        ];
    if (pair % 2 === 0) {
      arms.reverse();
    }
    for (const arm of arms) {
      await measure(`${pair}-${arm.label}`, arm.harness, arm.cli);
    }
  }
} finally {
  admission.close();
}
