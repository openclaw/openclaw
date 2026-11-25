/**
 * Sandbox housekeeping owner proof with an isolated real registry and a synthetic
 * Podman command boundary. Run baseline/candidate in counterbalanced fresh processes:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sandbox-retention-measure.ts \
 *   --owner src/agents/sandbox/prune.ts --rows 688 --active 10 --iterations 5
 * Add --allocations for equally instrumented allocation samples.
 * Native mode uses ONLY an explicitly named task container and CLI wrapper:
 *   --native-container <name> --native-command <absolute-wrapper> --workspace <guest-path>
 * It proves pre-TTL retention, post-TTL stop, and repeated-sweep quiescence. Native
 * resume/readback belongs to the caller. Neither mode reads an agent transcript DB
 * or scans workspaces: those sizes do not contribute to this owner's work.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    rows: { type: "string", default: "688" },
    active: { type: "string", default: "10" },
    iterations: { type: "string", default: "5" },
    allocations: { type: "boolean", default: false },
    "native-container": { type: "string" },
    "native-command": { type: "string" },
    workspace: { type: "string" },
  },
});
assert(values.owner && global.gc, "Select --owner and run Node with --expose-gc");
const native = values["native-container"];
assert(
  !native || (values["native-command"] && values.workspace),
  "Native proof needs its command and workspace",
);
const count = (name: "rows" | "active" | "iterations", min: number) =>
  parseStrictIntegerOption({
    raw: values[name],
    label: `--${name}`,
    min,
    fallback: 0,
  });
const rows = native ? 1 : count("rows", 1);
const active = native ? 0 : count("active", 0);
const iterations = count("iterations", 1);
assert(active <= rows);
await fs.mkdir(".local", { recursive: true });
const root = await fs.mkdtemp(path.resolve(".local/sandbox-retention-measure-"));
const bin = path.join(root, "bin");
const callsFile = path.join(root, "calls");
await fs.mkdir(bin);
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_HOME: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
  PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  SANDBOX_RETENTION_CALLS: callsFile,
  SANDBOX_RETENTION_REAL_PODMAN: values["native-command"] ?? "",
});
for (const name of ["CONTAINER_HOST", "CONTAINER_CONNECTION", "CONTAINER_SSHKEY"]) {
  delete process.env[name];
}
await fs.writeFile(
  path.join(bin, "podman"),
  `#!/bin/sh
if [ -n "$SANDBOX_RETENTION_REAL_PODMAN" ]; then
  operation="$1"
  if [ "$operation" = --remote=false ]; then operation="$2"; fi
  printf '%s\\n' "$operation" >> "$SANDBOX_RETENTION_CALLS"
  exec "$SANDBOX_RETENTION_REAL_PODMAN" "$@"
fi
if [ "$1" = --remote=false ]; then shift; fi
printf '%s\\n' "$1" >> "$SANDBOX_RETENTION_CALLS"
case "$1" in
  info) printf 'true\\tfalse\\t\\t5.0.0\\n' ;;
  inspect) printf '${"c".repeat(64)}\\ntrue\\ntrue\\nsynthetic-hash\\nfalse\\n' ;;
  stop) ;;
  *) printf 'Unsupported fixture operation\\n' >&2; exit 2 ;;
esac
`,
  { mode: 0o700 },
);

const directory = path.dirname(path.resolve(values.owner));
const { maybePruneSandboxes } = (await import(
  pathToFileURL(path.resolve(values.owner)).href
)) as typeof import("../../src/agents/sandbox/prune.js");
const { updateRegistry, readRegistry } = (await import(
  pathToFileURL(path.join(directory, "registry.ts")).href
)) as typeof import("../../src/agents/sandbox/registry.js");
const { acquireSandboxRuntimeUse } = (await import(
  pathToFileURL(path.join(directory, "registry-lifecycle.ts")).href
)) as typeof import("../../src/agents/sandbox/registry-lifecycle.js");
const { resolvePodmanSandboxRuntimeInfo } = (await import(
  pathToFileURL(path.join(directory, "podman-runtime.ts")).href
)) as typeof import("../../src/agents/sandbox/podman-runtime.js");
const config = { agents: { defaults: { sandbox: { prune: { idleHours: 0, maxAgeDays: 0 } } } } };
const originalNow = Date.now;
let now = Date.now();
Date.now = () => now;
const holds = new DisposableStack();
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
}
const measure = async (run: () => Promise<void>) => {
  await fs.writeFile(callsFile, "");
  global.gc!();
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage();
  const start = performance.now();
  await run();
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const threadUsed = process.threadCpuUsage(thread);
  let sampledBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = 0;
    const nodes = [profile.head];
    for (const node of nodes) {
      sampledBytes += node.selfSize;
      nodes.push(...node.children);
    }
  }
  const calls = (await fs.readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean);
  return {
    wallMs,
    cpuMs: (used.user + used.system) / 1000,
    threadCpuMs: (threadUsed.user + threadUsed.system) / 1000,
    sampledBytes,
    engineCalls: calls.length,
    stopCalls: calls.filter((value) => value === "stop").length,
  };
};
try {
  const { target } = await resolvePodmanSandboxRuntimeInfo();
  for (let index = 0; index < rows; index++) {
    const scopeKey = `agent:synthetic:session:${index}`;
    await updateRegistry({
      containerName: native ?? `synthetic-${index}`,
      backendId: "podman",
      backendTarget: target,
      sessionKey: scopeKey,
      createdAtMs: now - 3600_000,
      lastUsedAtMs: now - (native ? 14 : 20) * 60_000,
      image: "synthetic",
      workspaceDir: values.workspace ?? `/synthetic/workspace-${index}`,
      runtimeState: "ready",
    });
    if (index < active) {
      holds.use(await acquireSandboxRuntimeUse({ scopeKey }));
    }
  }
  const loadBefore = loadavg();
  const beforeTtl = native ? await measure(() => maybePruneSandboxes(config)) : undefined;
  if (native) {
    now += 6 * 60_000;
  }
  const retirement = await measure(() => maybePruneSandboxes(config));
  const countStoppedRows = async () =>
    (await readRegistry()).entries.filter(
      (entry) =>
        entry.idleStoppedAtLastUsedMs === entry.lastUsedAtMs ||
        // Prior PR revisions recorded stops as provisioning state.
        (entry.runtimeState as string | undefined) === "stopped",
    ).length;
  let stoppedRows = await countStoppedRows();
  const draining = [];
  while (stoppedRows < rows - active) {
    now += 5 * 60_000;
    draining.push(await measure(() => maybePruneSandboxes(config)));
    const next = await countStoppedRows();
    assert(next > stoppedRows, "Retirement made no progress; cannot measure steady state");
    stoppedRows = next;
  }
  const steady = [];
  for (let index = 0; index < iterations; index++) {
    now += 6 * 60_000;
    const sample = await measure(() => maybePruneSandboxes(config));
    assert.equal(sample.engineCalls, 0, "Steady-state sample still performed engine work");
    steady.push(sample);
  }
  console.log(
    JSON.stringify({
      owner: path.resolve(values.owner),
      rows,
      active,
      native: Boolean(native),
      allocations: values.allocations,
      beforeTtl,
      retirement,
      draining,
      stoppedRows,
      steady,
      loadBefore,
      loadAfter: loadavg(),
    }),
  );
} finally {
  holds.dispose();
  Date.now = originalNow;
  inspector.disconnect();
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  await drainGlobalSingletonLifecycleState();
  await fs.rm(root, { recursive: true, force: true });
}
