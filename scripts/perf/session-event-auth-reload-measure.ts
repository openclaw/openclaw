/**
 * Measure the scheduled-event config-policy owner over 5,000 retained synthetic
 * session consumers. Populate with team-shape-fixture.ts, then expand with
 * session-resource-loader-fixture.mjs --complete-gib 35 --workspace <path>.
 *
 * node --import ./scripts/tsx.mjs scripts/perf/session-event-auth-reload-measure.ts
 *   --state-dir <synthetic-state> --workspace <synthetic-workspace>
 *   --source-dir <saved-owner-root> --output <new-result.json> [--allocations]
 *
 * The SQLite roster is read once before timing. The real policy checks run without
 * mocks; no database or workspace scan belongs to this in-memory owner. This is
 * owner CPU/allocation evidence, not whole-Gateway latency or model execution.
 * Compare interleaved revisions and identical-source A/A controls. Acceptance:
 * unrelated auth, logging and provider changes retain all consumers; selected
 * auth changes refuse them. Report CPU/allocation changes and spread.
 * --phase bind includes complete policy capture and its first check, accounting
 * for preparation moved out of repeated live-policy checks.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { CronStoredJob } from "../../src/cron/types.js";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    workspace: { type: "string" },
    "source-dir": { type: "string" },
    rounds: { type: "string", default: "5" },
    scenario: { type: "string", default: "unrelated" },
    phase: { type: "string", default: "check" },
    "minimum-gib": { type: "string", default: "35" },
    allocations: { type: "boolean", default: false },
    output: { type: "string" },
  },
});
assert(values["state-dir"] && values.workspace && values.output);
const stateDir = path.resolve(values["state-dir"]);
const workspace = path.resolve(values.workspace);
const rounds = Number(values.rounds);
assert(Number.isSafeInteger(rounds) && rounds > 0);
assert(["unrelated", "unchanged", "logging", "unrelated-provider"].includes(values.scenario));
assert(values.phase === "check" || values.phase === "bind");
assert(!existsSync(values.output), "Refusing to overwrite a measurement");
const fixture = JSON.parse(readFileSync(path.join(stateDir, "team-shape-summary.json"), "utf8"));
assert.equal(fixture.format, "openclaw-team-shape-v1");
const databasePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
const databaseBytes = statSync(databasePath).size;
assert(databaseBytes >= Number(values["minimum-gib"]) * 1024 ** 3);
const database = new DatabaseSync(databasePath, { readOnly: true });
let sessionKeys: string[];
try {
  sessionKeys = database
    .prepare("SELECT session_key FROM session_nodes ORDER BY session_key")
    .all()
    .map(({ session_key: key }) => {
      assert(typeof key === "string" && key.startsWith("agent:main:team-shape-session-"));
      return key;
    });
} finally {
  database.close();
}
assert.equal(sessionKeys.length, 5000);
const directories = readdirSync(workspace);
assert.equal(directories.length, 620);
let workspaceFiles = 0;
let workspaceBytes = 0;
for (const directory of directories) {
  for (const name of readdirSync(path.join(workspace, directory))) {
    workspaceFiles++;
    workspaceBytes += statSync(path.join(workspace, directory, name)).size;
  }
}
assert.equal(workspaceFiles, 62000);
assert.equal(workspaceBytes, 1_116_000_000);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
const ownerFile = "src/auto-reply/reply/session-event-policy.ts";
const sourceRoot = path.resolve(
  values["source-dir"] ?? fileURLToPath(new URL("../../", import.meta.url)),
);
const ownerUrl = new URL(`../../${ownerFile}`, import.meta.url).href;
const sourceUrl = pathToFileURL(path.join(sourceRoot, ownerFile));
const sourceHash = hash("sha256", readFileSync(sourceUrl), "hex");
let sourceLoads = 0;
registerHooks({
  load(url, context, nextLoad) {
    if (url !== ownerUrl) {
      return nextLoad(url, context);
    }
    sourceLoads++;
    const loaded = nextLoad(sourceUrl.href, context);
    return { format: loaded.format, source: loaded.source, shortCircuit: true };
  },
});
const { captureScheduledSessionEventConfigPolicy } =
  await import("../../src/auto-reply/reply/session-event-policy.js");
const original: OpenClawConfig = {
  ...JSON.parse(readFileSync(path.join(stateDir, "openclaw.json"), "utf8")),
  auth: { profiles: { "openai:manual": { provider: "openai", mode: "api_key" } } },
  ...(values.scenario === "unrelated-provider"
    ? { models: { providers: { other: { baseUrl: "https://before.example/v1", models: [] } } } }
    : {}),
};
const unrelated: OpenClawConfig = {
  ...original,
  auth: {
    profiles: {
      ...original.auth?.profiles,
      "unrelated-provider:manual": { provider: "unrelated-provider", mode: "api_key" },
    },
  },
};
const relevant: OpenClawConfig = {
  ...original,
  auth: { profiles: { "openai:manual": { provider: "openai", mode: "oauth" } } },
};
const selected = { provider: "openai", model: "synthetic-model" };
const prepareConsumer = (sessionKey: string, index: number) => {
  const job: CronStoredJob = {
    id: `synthetic-job-${index}`,
    name: "Synthetic config reload consumer",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: `session:${sessionKey}`,
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Synthetic scheduled work" },
    state: {},
  };
  return captureScheduledSessionEventConfigPolicy(original, "main", job, selected);
};
const consumers = sessionKeys.map(prepareConsumer);
const check = (config: OpenClawConfig, policies = consumers) => {
  let retained = 0;
  for (const consumer of policies) {
    if (consumer(config, [])) {
      retained++;
    }
  }
  return retained;
};
assert.equal(check(original), 5000, "Unchanged config must retain admitted policy");
assert.equal(check(relevant), 0, "Selected-provider credential policy must fail closed");
const measuredConfig: OpenClawConfig =
  values.scenario === "unchanged"
    ? original
    : values.scenario === "logging"
      ? { ...original, logging: { ...original.logging, level: "debug" } }
      : values.scenario === "unrelated-provider"
        ? {
            ...original,
            models: {
              providers: { other: { baseUrl: "https://after.example/v1", models: [] } },
            },
          }
        : unrelated;
const measure = () =>
  check(measuredConfig, values.phase === "bind" ? sessionKeys.map(prepareConsumer) : consumers);
for (let warmup = 0; warmup < 3; warmup++) {
  measure();
}
const inspector = new Session();
inspector.connect();
try {
  await inspector.post("HeapProfiler.collectGarbage");
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const cpuStarted = process.threadCpuUsage();
  const started = performance.now();
  let retained = 0;
  for (let round = 0; round < rounds; round++) {
    retained += measure();
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuStarted);
  let allocationBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: typeof profile.head): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocationBytes = sum(profile.head);
  }
  assert(sourceLoads > 0);
  assert.equal(hash("sha256", readFileSync(sourceUrl), "hex"), sourceHash);
  const checks = consumers.length * rounds;
  const result = {
    scope:
      "Real scheduled-event config-policy owner over retained synthetic session consumers; no Gateway transport/model execution claim",
    sourceHash,
    sourceLoads,
    node: process.version,
    mode: values.allocations ? "sampled-allocation" : "timing",
    scenario: values.scenario,
    phase: values.phase,
    fixture: { sessions: sessionKeys.length, databaseBytes, workspaceFiles, workspaceBytes },
    rounds,
    checks,
    retained,
    invalidated: checks - retained,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    usPerCheck: (elapsedMs * 1000) / checks,
    cpuUsPerCheck: (cpu.user + cpu.system) / checks,
    allocationBytes,
    allocationBytesPerCheck: allocationBytes === undefined ? undefined : allocationBytes / checks,
    hostLoad,
    memory: process.memoryUsage(),
  };
  writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(result));
} finally {
  inspector.disconnect();
}
