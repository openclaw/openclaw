/**
 * Reply-authority owner probe (synthetic state; no Gateway or external provider).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/reply-tool-authority-measure.ts
 *   --iterations 3000 --mode timing|allocation|promotion --output <file.json>
 * Optional --owner <absolute module path> selects a baseline owner with the same imports.
 * A 205-property attempt matches the dispatch literal's breadth; 40 synthetic plugin
 * configs and 64 concurrent retained owners model a busy shared Gateway's input shape.
 * Each reply prepares, fingerprints, projects its caller, rechecks, and closes.
 * Compare timing without inspector; allocation includes minor- and major-collected
 * samples; promotion excludes minor-collected samples. Sampling is an estimate,
 * not V8's exact promoted-byte counter. No forced GC inside the measured workload.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createAdmittedRunOperatorAuthority } from "../../src/agents/admitted-run-context.js";
import type { ReplyToolAuthorityInput } from "../../src/auto-reply/reply/reply-tool-authority.types.js";
import { captureRuntimeConfig } from "../../src/config/runtime-source-projection.js";
import type { ReplyToolAuthorityOverlay } from "../../src/sessions/session-controller.contracts.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "3000" },
    mode: { type: "string", default: "timing" },
    owner: { type: "string" },
    output: { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["timing", "allocation", "promotion"].includes(values.mode));
assert(globalThis.gc, "Use --expose-gc");
const {
  prepareReplyToolAuthority,
}: typeof import("../../src/auto-reply/reply/reply-tool-authority.js") = await import(
  values.owner
    ? pathToFileURL(values.owner).href
    : "../../src/auto-reply/reply/reply-tool-authority.js"
);
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
// Runtime attempts include optional fields even when absent; model their property cost.
for (let index = Object.keys(input.run).length; index < 205; index++) {
  Reflect.set(input.run, `unrelatedAttemptField${index}`, undefined);
}
const overlay: ReplyToolAuthorityOverlay = {
  operatorAuthority: authority,
  originatingChannel: input.originatingChannel,
  senderId: input.run.senderId,
  senderIsOwner: true,
  messageProvider: "telegram",
  permissionMode: "full",
  disableTools: false,
  traceAuthorized: false,
  clientCaps: input.run.clientCaps,
  gatewayUiCommandTarget: input.run.gatewayUiCommandTarget,
  toolBindings: input.run.toolBindings,
};
let fingerprint: string | undefined;
async function workload(count: number) {
  for (let offset = 0; offset < count; offset += 64) {
    const owners = Array.from({ length: Math.min(64, count - offset) }, () =>
      prepareReplyToolAuthority(input),
    );
    try {
      await Promise.all(
        owners.map(async (owner) => {
          const captured = await owner.fingerprintAsync(route);
          fingerprint ??= captured;
          assert.equal(captured, fingerprint);
          assert.equal(await owner.projectAsync(overlay, route), captured);
          assert.equal(owner.fingerprint(route), captured);
        }),
      );
      await setImmediate();
    } finally {
      for (const owner of owners) {
        owner.close();
      }
    }
  }
}
await workload(256);
globalThis.gc();
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
const cpu = process.cpuUsage();
const started = performance.now();
await workload(iterations);
const elapsedMs = performance.now() - started;
const cpuUsage = process.cpuUsage(cpu);
const after = process.memoryUsage();
let sampledBytes: number | undefined;
if (values.mode !== "timing") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: typeof profile.head): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  if (values.output) {
    await writeFile(`${values.output}.heapprofile`, JSON.stringify(profile));
  }
}
inspector.disconnect();
const result = {
  iterations,
  mode: values.mode,
  attemptProperties: Object.keys(input.run).length,
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
if (values.output) {
  await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result));
