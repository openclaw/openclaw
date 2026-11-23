// Sidebar fact-sharing owner benchmark (synthetic rows; no Gateway or persisted state).
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-row-sharing.ts \
//   --rows 2000 --churn 1 --iterations 400 --mode timing
// Optional --baseline <module> compares an entrypoint from the baseline revision in
// the same process, alternating arm order; otherwise run on each revision. Baseline
// snapshots must import the SAME row identity/serializer dependencies as the candidate;
// rewrite only the sharing owner module import when materializing historical sources.
// Run five AB/BA passes on baseline/candidate. Use --churn many for 25% changed rows,
// --mode allocation for a separate collected-allocation pass, or --mode parity for
// deterministic response bytes across row modes, reorder/remove/add and conditional reads.
// A warm row's identity is retained; changed rows are replaced each operation, as at
// publication. Timing includes row-vector replacement and packing/serialization. Allocation
// uses Node 26 V8 total_allocated_bytes, including collected objects. CPU uses the main
// thread; host load is reported. Byte parity is mandatory; judge paired CPU/allocation
// deltas against matched A/A controls before attributing an adverse result.
// --warmup 1000 --iterations 5000 extends short, noisy small-page passes.
// --churn <0..rows> selects an exact replacement count. --request full (default),
// delta, unchanged or mixed selects the response. Mixed cycles two unknown-base full
// reads, one delta and one unchanged read: a sensitivity case, not an observed day mix.
// Conditional reads include full packing for publication accounting before the reply.
// Discard the entire paired pass if either arm reports measurementValid: false.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { SESSION_ROWS_DELTA_PREFIX } from "../../packages/gateway-protocol/src/session-row-fields.js";
import { captureSessionRowGeneration } from "../../src/gateway/session-row-identity.js";
import { shareSidebarSessionRows } from "../../src/gateway/session-row-presentation.js";
import { serializeSessionRow } from "../../src/gateway/session-row-serialization.js";
import { applyGatewaySessionRowMode } from "../../src/gateway/session-utils-display.js";
import type { GatewaySessionRow } from "../../src/gateway/session-utils.types.js";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    warmup: { type: "string", default: "100" },
    passes: { type: "string", default: "5" },
    rows: { type: "string", default: "500" },
    churn: { type: "string", default: "1" },
    request: { type: "string", default: "full" },
    iterations: { type: "string", default: "400" },
    mode: { type: "string", default: "timing" },
  },
});
const warmup = Number(values.warmup);
assert(Number.isSafeInteger(warmup) && warmup >= 0);
const passes = Number(values.passes);
assert(Number.isSafeInteger(passes) && passes > 0);
const arms = [{ name: "candidate", share: shareSidebarSessionRows }];
if (values.baseline) {
  const baseline: unknown = await import(pathToFileURL(resolve(values.baseline)).href);
  function isSharingModule(
    value: unknown,
  ): value is { shareSidebarSessionRows: typeof shareSidebarSessionRows } {
    return (
      typeof value === "object" &&
      value !== null &&
      "shareSidebarSessionRows" in value &&
      typeof value.shareSidebarSessionRows === "function"
    );
  }
  assert(isSharingModule(baseline));
  arms.unshift({ name: "baseline", share: baseline.shareSidebarSessionRows });
}
const count = Number(values.rows);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(count) && count > 1);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["timing", "allocation", "parity"].includes(values.mode));
assert(["full", "delta", "unchanged", "mixed"].includes(values.request));
const changed = values.churn === "many" ? Math.max(1, Math.floor(count / 4)) : Number(values.churn);
assert(Number.isSafeInteger(changed) && changed >= 0 && changed <= count);
const mixedRequests = ["unknown-base", "unknown-base", "delta", "unchanged"];

function fixture(index: number, rowMode: GatewaySessionRow["rowMode"]): GatewaySessionRow {
  const row: GatewaySessionRow = {
    key: `agent:synthetic:subagent:${index}`,
    kind: "direct",
    updatedAt: 1_800_000_000_000 + index,
    sessionId: `synthetic-session-${index}`,
    rowMode,
    label: `Synthetic task ${index}`,
    category: index % 5 ? "subagent" : "chat",
    agentId: "synthetic",
    status: "done",
    visibility: "draft",
    sharingRole: "owner",
    hasActiveRun: false,
    hasActiveSubagentRun: false,
    childOwnerSessionKeys: ["agent:synthetic:main"],
    runtimeMs: index % 10,
    startedAt: 1_800_000_000_000,
    backgroundProcessCount: 0,
    archived: index % 4 === 0,
    lastMessagePreview: index % 8 === 0 ? "Completed synthetic task" : undefined,
  };
  applyGatewaySessionRowMode(row, rowMode);
  return Object.freeze(row);
}
let rows = Array.from({ length: count }, (_, index) => fixture(index, "sidebar"));
let sequence = 0;
function churn(shape = false, replacements = changed) {
  if (replacements === 0) {
    return;
  }
  rows = rows.slice();
  for (let offset = 0; offset < replacements; offset++) {
    const index = (sequence + offset) % rows.length;
    const previous = rows[index]!;
    const next = {
      ...previous,
      updatedAt: previous.updatedAt! + 1,
      runtimeMs: (previous.runtimeMs ?? 0) + 1,
    };
    if (shape) {
      applyGatewaySessionRowMode(next, previous.rowMode);
    }
    rows[index] = Object.freeze(next);
  }
  sequence++;
}
function request(
  share: typeof shareSidebarSessionRows,
  kind: string,
  index: number,
  replacements = changed,
  shape = false,
) {
  const responseKind = kind === "mixed" ? mixedRequests[index % mixedRequests.length]! : kind;
  const before = responseKind === "delta" ? captureSessionRowGeneration(rows) : undefined;
  if (responseKind !== "unchanged") {
    churn(shape, replacements);
  }
  // list() prepares the full response before cache admission, even for a delta reply.
  const full = share(rows);
  if (before) {
    return share(rows, `${SESSION_ROWS_DELTA_PREFIX}${before.revision}`, [before]);
  }
  if (responseKind === "unchanged") {
    return share(rows, full.rowsRevision);
  }
  return responseKind === "unknown-base" ? share(rows, "unknown-base") : full;
}
function run(size: number, share: typeof shareSidebarSessionRows) {
  for (let index = 0; index < size; index++) {
    const response = request(share, values.request, index);
    assert.equal(
      response.sessions.length,
      response.rowsUnchanged ? 0 : response.rowsDelta ? changed : count,
    );
  }
}

let baselineDigest: string | undefined;
for (let pass = 0; pass < (values.mode === "parity" ? 1 : passes); pass++) {
  for (const arm of pass % 2 ? arms.toReversed() : arms) {
    rows = Array.from({ length: count }, (_, index) => fixture(index, "sidebar"));
    sequence = 0;
    const share = arm.share;
    if (values.mode === "parity") {
      const hash = createHash("sha256");
      let responses = 0;
      let bytes = 0;
      const record = (response: ReturnType<typeof shareSidebarSessionRows>) => {
        // Revision tokens are intentionally random; their equality/delta behavior is checked below.
        const encoded = JSON.stringify({
          ...response,
          rowsRevision: "revision",
          rowsDelta: response.rowsDelta && { ...response.rowsDelta, baseRevision: "base" },
        });
        hash.update(encoded);
        bytes += Buffer.byteLength(encoded);
        for (const row of response.sessions) {
          assert.equal(serializeSessionRow(row), JSON.stringify(row));
        }
        responses++;
      };
      for (const mode of [undefined, "compact", "sidebar", "dashboard"] as const) {
        rows = Array.from({ length: count }, (_, index) => fixture(index, mode));
        for (let index = 0; index < 40; index++) {
          const before = captureSessionRowGeneration(rows);
          const full = share(rows);
          record(full);
          const unchanged = share(rows, full.rowsRevision);
          assert.equal(unchanged.rowsUnchanged, true);
          assert.equal(unchanged.sessions.length, 0);
          record(unchanged);
          churn(true);
          rows = rows.slice();
          const changedIndex = (index * 17) % rows.length;
          const changedRow = rows[changedIndex]!;
          const next = {
            ...changedRow,
            label: index % 3 === 0 ? undefined : `Shared task ${index % 5}`,
            category: index % 2 ? "subagent" : "chat",
            lastMessagePreview: index % 4 === 0 ? "Changed preview" : undefined,
            childOwnerSessionKeys: index % 3 ? [] : ["agent:synthetic:main"],
          };
          applyGatewaySessionRowMode(next, mode);
          rows[changedIndex] = Object.freeze(next);
          if (index % 3 === 0) {
            rows.reverse();
          }
          if (index % 7 === 0) {
            rows.splice(index % rows.length, 1);
            rows.push(fixture(count + index, mode));
          }
          record(share(rows, `${SESSION_ROWS_DELTA_PREFIX}${before.revision}`, [before]));
          record(share(rows, "unknown-base"));
          if (index % 5 === 0) {
            const duplicated = [rows[0]!, ...rows, rows[0]!];
            record(share(duplicated));
            // Repacking an alias must not change a previously retained wire response.
            record(full);
          }
        }
      }
      const originalResponses = responses;
      // Keep the original differential intact, then vary replacement rates and response
      // kinds independently: telemetry does not expose the production joint distribution.
      for (const mode of [undefined, "compact", "sidebar", "dashboard"] as const) {
        rows = Array.from({ length: count }, (_, index) => fixture(index, mode));
        for (const replacements of [0, 1, Math.max(1, Math.floor(count / 4)), count]) {
          for (let index = 0; index < 4; index++) {
            record(request(share, "mixed", index, replacements, true));
          }
        }
      }
      const digest = hash.digest("hex");
      if (baselineDigest !== undefined) {
        assert.equal(digest, baselineDigest);
      }
      baselineDigest = digest;
      console.log(
        JSON.stringify({
          arm: arm.name,
          pass,
          mode: values.mode,
          count,
          changed,
          originalResponses,
          responses,
          bytes,
          sha256: digest,
        }),
      );
    } else {
      run(warmup, share);
      globalThis.gc?.();
      const allocationStart =
        values.mode === "allocation" ? getHeapStatistics().total_allocated_bytes : undefined;
      if (allocationStart !== undefined) {
        assert(Number.isFinite(allocationStart));
      }
      const hostLoad = loadavg();
      const startCpu = process.threadCpuUsage();
      const start = performance.now();
      run(iterations, share);
      const wallMs = performance.now() - start;
      const cpu = process.threadCpuUsage(startCpu);
      const hostLoadEnd = loadavg();
      const allocation =
        allocationStart === undefined
          ? undefined
          : (getHeapStatistics().total_allocated_bytes - allocationStart) / iterations;
      console.log(
        JSON.stringify({
          arm: arm.name,
          pass,
          mode: values.mode,
          count,
          changed,
          request: values.request,
          iterations,
          warmup,
          wallMs,
          cpuUsPerList: (cpu.user + cpu.system) / iterations,
          allocatedBytesPerList: allocation,
          hostLoad,
          hostLoadEnd,
          measurementValid: hostLoad[0]! <= 40 && hostLoadEnd[0]! <= 40,
          memory: process.memoryUsage(),
          node: process.version,
        }),
      );
    }
  }
}
