/**
 * Admission-accounting burst; no database or production data is accessed.
 * Save the base request module outside the checkout, then run five serial A/A/B
 * triplets with --module pointing to base, base, and candidate respectively:
 *   node scripts/perf/state-read-request-bytes.ts --baseline /path/base.ts
 * Use --environment full150 for the counterfactual unprojected environment.
 * Use --engine unconfigured to check reads before engine selection is installed.
 * --shape session-list measures payload-free session-list prerequisites;
 * --shape shared-facts measures a cold 5,000-row selector batch (2,000 requests).
 * These source-derived shapes are separate controls, not a production frequency mix.
 * Actual readers capture only state directory and supervisor mode from that input.
 * Every run checks exact charges before timing the same number of fresh contexts
 * (100,000 normally, 2,000 for shared facts). CPU is main-thread CPU; allocation
 * is V8 cumulative bytes.
 */
import assert from "node:assert/strict";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { DatabaseEngineSelection } from "../../src/infra/database-engine/types.js";
import type { OpenClawStateReadRequest } from "../../src/state/openclaw-state-read.types.js";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    module: { type: "string" },
    environment: { type: "string", default: "captured" },
    engine: { type: "string", default: "sqlite" },
    shape: { type: "string", default: "mixed" },
  },
});
assert(values.baseline, "--baseline must name the original request module");
assert(["captured", "full150"].includes(values.environment));
assert(["sqlite", "unconfigured"].includes(values.engine));
assert(["mixed", "session-list", "shared-facts"].includes(values.shape));
const baseline: typeof import("../../src/state/openclaw-state-read-request.js") = await import(
  pathToFileURL(values.baseline).href
);
const candidate: typeof baseline = await import(
  values.module
    ? pathToFileURL(values.module).href
    : new URL("../../src/state/openclaw-state-read-request.ts", import.meta.url).href
);
const sourceEnvironment = {
  OPENCLAW_STATE_DIR: "/synthetic/openclaw/state",
  OPENCLAW_SUPERVISOR_MODE: "external" as const,
  ...Object.fromEntries(
    Array.from({ length: 148 }, (_, index) => [
      `SYNTHETIC_ENV_${index}`,
      `/synthetic/service/${index}/` + "x".repeat(64),
    ]),
  ),
};
const environment =
  values.environment === "full150"
    ? sourceEnvironment
    : {
        OPENCLAW_STATE_DIR: sourceEnvironment.OPENCLAW_STATE_DIR,
        OPENCLAW_SUPERVISOR_MODE: sourceEnvironment.OPENCLAW_SUPERVISOR_MODE,
      };
const selection: DatabaseEngineSelection = Object.freeze({
  effectiveEngines: Object.freeze({
    state: "sqlite",
    agent: "sqlite",
    workboard: "sqlite",
    logbook: "sqlite",
    "team-reports": "sqlite",
    quarantine: "sqlite",
    "managed-update": "sqlite",
    "package-activation": "sqlite",
  }),
});
let commands: OpenClawStateReadRequest["command"][] = [
  { type: "machineState.read", input: { key: "synthetic/key/中🦞" } },
  { type: "backup.runs" },
  { type: "operatorApprovals.pendingSnapshot", input: { cursor: "synthetic/cursor" } },
  {
    type: "workers.placementProjection",
    sessionIds: ["session-1", "session-2"],
    conflictBindings: [],
  },
];
if (values.shape === "session-list") {
  commands = [
    { type: "admit" },
    { type: "subagents.sessionList" },
    { type: "sessionGroups.snapshot" },
    { type: "userProfiles.catalog" },
  ];
} else if (values.shape === "shared-facts") {
  commands = [
    {
      type: "sessionRows.sharedFacts",
      entries: Array.from({ length: 5000 }, (_, index) => ({
        acp: {
          keys: [`agent:synthetic:session-${index}`],
          entry: {
            sessionId: `session-${index}`,
            lifecycleRevision: "00000000-0000-4000-8000-000000000001",
            sessionStartedAt: 1,
          },
        },
        repositoryWorkspace: {
          agentId: "synthetic",
          sessionKey: `agent:synthetic:session-${index}`,
          workspaceId: `workspace-${index}`,
        },
      })),
    },
  ];
}
function request(index: number): OpenClawStateReadRequest {
  return {
    context: {
      databaseEngineSelection: values.engine === "sqlite" ? selection : undefined,
      environment: { ...environment },
      existingSchemaPath: "/synthetic/openclaw/state/openclaw.db",
    },
    databasePath: "/synthetic/openclaw/state/openclaw.db",
    location: "/synthetic/snapshots/read/openclaw.db",
    expectedIdentity: "file:123:456",
    snapshotRoot: "/synthetic/snapshots/read",
    checkFreshAdmission: true,
    command: commands[index % commands.length]!,
  };
}
const iterations = values.shape === "shared-facts" ? 2000 : 100_000;
for (let index = 0; index < iterations; index++) {
  const input = request(index);
  assert.equal(candidate.requestBytes(input), baseline.requestBytes(input));
}
const loadBefore = loadavg();
const allocatedBefore: unknown = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
const cpuBefore = process.threadCpuUsage();
const start = performance.now();
let bytes = 0;
for (let index = 0; index < iterations; index++) {
  bytes += candidate.requestBytes(request(index));
}
const elapsedMs = performance.now() - start;
const cpu = process.threadCpuUsage(cpuBefore);
const allocatedAfter: unknown = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
console.log(
  JSON.stringify({
    environment: values.environment,
    engine: values.engine,
    shape: values.shape,
    iterations,
    byteExactRequests: iterations,
    bytes,
    elapsedMs,
    mainCpuMs: (cpu.user + cpu.system) / 1000,
    allocatedBytes:
      typeof allocatedBefore === "number" && typeof allocatedAfter === "number"
        ? allocatedAfter - allocatedBefore
        : undefined,
    loadBefore,
    loadAfter: loadavg(),
  }),
);
