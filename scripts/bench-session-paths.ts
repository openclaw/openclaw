// Run: pnpm test:sessions:paths:bench
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { normalizeAgentId } from "../src/routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../src/state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqliteDir } from "../src/state/openclaw-state-db.paths.js";

type Options = Parameters<typeof resolveOpenClawAgentSqlitePath>[0];

// Pre-cache implementation, kept here to compare identical work in one process.
function baseline(options: Options): string {
  const agentId = normalizeAgentId(options.agentId);
  return path.resolve(
    options.path ??
      path.join(
        path.dirname(resolveOpenClawStateSqliteDir(options.env ?? process.env)),
        "agents",
        agentId,
        "agent",
        "openclaw-agent.sqlite",
      ),
  );
}

const env = { OPENCLAW_STATE_DIR: path.join(os.tmpdir(), "openclaw-path-bench") };
const scans = 50;
let checksum = 0;

function measure(resolve: (options: Options) => string, rows: Options[]): number {
  const start = performance.now();
  for (let scan = 0; scan < scans; scan++) {
    for (const row of rows) {
      checksum += resolve(row).length;
    }
  }
  return ((performance.now() - start) * 1e6) / (scans * rows.length);
}

console.log(JSON.stringify({ node: process.version, platform: process.platform, scans }));
for (const agents of [1, 8, 512]) {
  const rows = Array.from({ length: 4428 }, (_, i) => ({ agentId: `bench-${i % agents}`, env }));
  for (const row of rows) {
    assert.equal(resolveOpenClawAgentSqlitePath(row), baseline(row));
  }
  measure(baseline, rows);
  measure(resolveOpenClawAgentSqlitePath, rows);
  const before: number[] = [];
  const after: number[] = [];
  for (let sample = 0; sample < 7; sample++) {
    // Alternate order so thermal/load drift does not always favor one side.
    if (sample % 2 === 0) {
      before.push(measure(baseline, rows));
      after.push(measure(resolveOpenClawAgentSqlitePath, rows));
    } else {
      after.push(measure(resolveOpenClawAgentSqlitePath, rows));
      before.push(measure(baseline, rows));
    }
  }
  const beforeNs = before.toSorted((a, b) => a - b)[3];
  const afterNs = after.toSorted((a, b) => a - b)[3];
  assert.ok(beforeNs !== undefined && afterNs !== undefined);
  console.log(
    JSON.stringify({
      rows: rows.length,
      agents,
      beforeNs: Math.round(beforeNs),
      afterNs: Math.round(afterNs),
      reductionPercent: Math.round((1 - afterNs / beforeNs) * 100),
    }),
  );
}
console.log(JSON.stringify({ checksum }));
