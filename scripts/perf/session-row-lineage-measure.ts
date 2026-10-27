// Run: node --import ./scripts/tsx.mjs scripts/perf/session-row-lineage-measure.ts
// Save the base record module before editing, then pass --base-file <saved.ts>.
// Run timing and --allocation separately, alternating base/candidate order.
// Each arm acquires 10,000 warm rows for --passes 5 (50,000 acquisitions), after
// two warmup passes. Per-sender and global-alias scopes are reported separately.
// Acceptance: identical retained rows, lower CPU/allocation, no adverse control.
// This measures the acquisition owner only, not Gateway RPCs or production share.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { Row } from "../../src/gateway/session-row-projection-record.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "base-file": { type: "string" },
    allocation: { type: "boolean" },
    passes: { type: "string", default: "5" },
  },
});
const passes = parseStrictIntegerOption({
  raw: values.passes,
  label: "--passes",
  min: 1,
  fallback: 5,
});
const ownerUrl = new URL("../../src/gateway/session-row-projection-record.ts", import.meta.url);
const source = readFileSync(values["base-file"] ?? ownerUrl, "utf8");
registerHooks({
  load(url, context, nextLoad) {
    // Both arms use the same loader and canonical URL for the shared dependency graph.
    return url === ownerUrl.href
      ? { format: "module-typescript", source, shortCircuit: true }
      : nextLoad(url, context);
  },
});
const records = await import("../../src/gateway/session-row-projection-record.js");
const { buildSessionListRowMetadataContext } =
  await import("../../src/gateway/session-utils-projection.js");
const { buildSubagentSessionListReadIndex } =
  await import("../../src/agents/subagents/registry/subagent-registry-read.js");
const context = buildSessionListRowMetadataContext({
  now: 1,
  subagentRuns: buildSubagentSessionListReadIndex(1, undefined, new Map()),
});
const sessions = 10_000;
const inspector = new Session();
const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);

try {
  if (values.allocation) {
    inspector.connect();
  }
  for (const scope of ["per-sender", "global"] as const) {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } }, session: { scope } };
    const rows = new Map<string, Row>();
    const inventory: Row[] = [];
    let publications = 0;
    const owner = {
      rows,
      cfg,
      context,
      remove: (id: string) => rows.delete(id),
      put(row: Row) {
        rows.set(records.identity(row), row);
        publications++;
      },
      markRelated() {},
      archive: { demote: (row: Row) => row, forget() {} },
    };
    for (let index = 0; index < sessions; index++) {
      const entry: InternalSessionEntry = {
        sessionId: `synthetic-${index}`,
        updatedAt: 1_750_000_000_000 + index,
        lifecycleRevision: "synthetic-generation",
        label: `Synthetic completed task ${index}`,
        status: "done",
        parentSessionKey: "agent:main:main",
        spawnedBy: "agent:main:main",
        owner: { actor: { type: "agent", id: "main" }, assignedAt: 1 },
        participants: [{ identity: { type: "agent", id: "synthetic-helper" } }],
        pluginExtensions: {
          synthetic: { task: { title: `Synthetic task ${index}`, tags: ["done", "fixture"] } },
        },
        ...(index % 5 === 0 ? { archivedAt: 1 } : {}),
      };
      const row = records.create(
        {
          key: `agent:main:${index % 5 === 0 ? "dashboard" : "subagent"}:synthetic-${index}`,
          agentId: "main",
          storeTarget: { agentId: "main", storePath: "/synthetic/lineage.sqlite" },
        },
        entry,
      );
      const acquired = records.acquireSessionRowEntry({ ...owner, row, storedEntry: entry })!;
      const parentKey = scope === "global" ? "global" : "agent:main:main";
      assert.equal(acquired.entry?.parentSessionKey, parentKey);
      assert.equal(acquired.entry?.spawnedBy, parentKey);
      inventory.push(acquired);
    }
    const acquire = () => {
      for (const row of inventory) {
        const next = records.acquireSessionRowEntry({
          ...owner,
          row,
          storedEntry: row.storedEntry,
        });
        if (next !== row) {
          throw new Error("Unchanged acquisition replaced a retained row");
        }
      }
    };
    acquire();
    acquire();
    publications = 0;
    if (values.allocation) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpuStart = process.threadCpuUsage();
    const started = performance.now();
    for (let pass = 0; pass < passes; pass++) {
      acquire();
    }
    const wallMs = performance.now() - started;
    const cpu = process.threadCpuUsage(cpuStart);
    let allocatedBytes: number | undefined;
    if (values.allocation) {
      allocatedBytes = bytes((await inspector.post("HeapProfiler.stopSampling")).profile.head);
    }
    assert.equal(publications, 0);
    const operations = sessions * passes;
    console.log(
      JSON.stringify({
        arm: values["base-file"] ? "base" : "candidate",
        sourceHash: createHash("sha256").update(source).digest("hex"),
        node: process.version,
        scope,
        mode: values.allocation ? "allocation" : "timing",
        sessions,
        passes,
        operations,
        wallMs,
        cpuUsPerOperation: (cpu.user + cpu.system) / operations,
        sampledBytesPerOperation:
          allocatedBytes === undefined ? undefined : allocatedBytes / operations,
        load: loadavg(),
        memory: process.memoryUsage(),
      }),
    );
  }
} finally {
  inspector.disconnect();
}
