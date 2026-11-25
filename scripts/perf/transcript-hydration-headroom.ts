// Uses the same long-history fixture as transcript-broadcast-measure.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    revision: { type: "string" },
    rounds: { type: "string", default: "4" },
    "max-mib": { type: "string", default: "64" },
    "start-at": { type: "string" },
    "baseline-owners": { type: "boolean", default: false },
  },
});
assert(
  values["state-dir"] && values.output && values.revision,
  "--state-dir, --output and --revision are required",
);
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const root = path.resolve(values["state-dir"]);
const output = path.resolve(values.output);
mkdirSync(output, { recursive: true });
const seed: {
  sessionCount: number;
  historyTurns: number;
  historyLastTurns?: number;
  historyPayloadBytes?: number;
} = JSON.parse(readFileSync(path.join(root, "reopen-history.json"), "utf8"));
const env = {
  ...createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
  OPENCLAW_BENCH_WORKER_MEMORY_DIR: output,
  ...(values["baseline-owners"] ? { OPENCLAW_BENCH_TRANSCRIPT_BASELINE_OWNERS: "1" } : {}),
};
process.env = { ...env };
await import("./transcript-worker-memory-preload.ts");
const [
  { prepareSessionTranscriptHydration },
  { resolveOpenClawAgentSqlitePath },
  agentDb,
  stateDb,
  lifecycle,
] = await Promise.all([
  import("../../src/config/sessions/session-transcript-hydration.js"),
  import("../../src/state/openclaw-agent-db.paths.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/shared/global-singleton.js"),
]);
const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
const limits = { maxBytes: integer(values["max-mib"], "--max-mib") * 1024 ** 2, maxEvents: 10_000 };
const rounds = integer(values.rounds, "--rounds");
if (values["start-at"]) {
  const deadline = integer(values["start-at"], "--start-at");
  assert(deadline > Date.now(), "Missed synchronized start");
  await delay(deadline - Date.now());
}
const samples: Array<{
  round: number;
  session: number;
  elapsedMs: number;
  digest: string;
  serializedBytes: number;
}> = [];
try {
  for (let round = 0; round < rounds; round++) {
    for (let index = 0; index < seed.sessionCount; index++) {
      const started = performance.now();
      const result = await prepareSessionTranscriptHydration(
        {
          agentId: "main",
          sessionId: `reopen-history-${index}`,
          sessionKey: `agent:main:transcript-broadcast-measure-child-${index}`,
          storePath,
          env,
        },
        limits,
      ).read();
      const elapsedMs = performance.now() - started;
      assert.equal(result.kind, "bounded");
      const serialized = JSON.stringify(result, (_key, value) =>
        value instanceof Map ? [...value] : value,
      );
      const sample = {
        round,
        session: index,
        elapsedMs,
        digest: createHash("sha256").update(serialized).digest("hex"),
        serializedBytes: Buffer.byteLength(serialized),
      };
      const previous = samples.find((entry) => entry.session === index);
      if (previous) {
        assert.equal(sample.digest, previous.digest, "Repeated hydration changed its result");
      }
      samples.push(sample);
      console.log(JSON.stringify(sample));
    }
  }
  // Observe natural/idle collection separately; no forced collection contaminates the tasks.
  await delay(3000);
  writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify(
      { revision: values.revision, node: process.version, seed, limits, samples },
      null,
      2,
    ),
  );
} finally {
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
  await lifecycle.drainGlobalSingletonLifecycleState();
}
