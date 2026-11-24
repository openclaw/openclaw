// Run: node --import ./scripts/tsx.mjs scripts/perf/session-row-lineage-measure.ts
// Save the base record module before editing, then pass --base-file <saved.ts>.
// Run timing and --allocation separately, alternating base/candidate order.
// Default: 10,000 rows for --passes 5, --reads 1 per publication, after
// two warmup passes. Per-sender and global-alias scopes are reported separately.
// Acceptance: identical retained rows, lower CPU/allocation, no adverse control.
// --materialize --sessions 700 --reads 20 --passes 30 adds materialization and
// transcript-fact publication once per 20 reads. --snapshots acquires freshly decoded
// equivalents. --base-dir overlays saved src/gateway owners without swapping files.
// --corpus records identical rows and change decisions for reparent/archive/compaction.
// This measures in-memory owners only, not Gateway RPCs, database size, or production share.
// --refresh resolves live inputs in 64-row slices and publishes changing transcript previews.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { Row } from "../../src/gateway/session-row-projection-record.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "base-file": { type: "string" },
    "base-dir": { type: "string" },
    materialize: { type: "boolean" },
    snapshots: { type: "boolean" },
    refresh: { type: "boolean" },
    sessions: { type: "string", default: "10000" },
    reads: { type: "string", default: "1" },
    corpus: { type: "string" },
    "cpu-profile": { type: "string" },
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
const owners = [
  "session-row-projection-record",
  "session-utils-row",
  "session-row-identity",
  "session-row-presentation",
  "session-runtime-resolution",
  "session-row-materialization",
];
const sources = new Map(
  owners.map((name) => {
    const url = new URL(`../../src/gateway/${name}.ts`, import.meta.url);
    const file = values["base-dir"]
      ? path.join(values["base-dir"], "src/gateway", `${name}.ts`)
      : name === owners[0] && values["base-file"]
        ? values["base-file"]
        : url;
    return [url.href, readFileSync(file, "utf8")];
  }),
);
registerHooks({
  load(url, context, nextLoad) {
    const source = sources.get(url);
    return source === undefined
      ? nextLoad(url, context)
      : { format: "module-typescript", source, shortCircuit: true };
  },
});
const { materializeSessionRow, readSessionRowInputs, replaceSessionRowFacts } =
  await import("../../src/gateway/session-utils-row.js");
const { materializeSessionRowIfChanged } =
  await import("../../src/gateway/session-row-materialization.js");
const records = await import("../../src/gateway/session-row-projection-record.js");
const { createSessionRuntimeResolution } =
  await import("../../src/gateway/session-runtime-resolution.js");
const { buildSessionListRowMetadataContext } =
  await import("../../src/gateway/session-utils-projection.js");
const { buildSubagentSessionListReadIndex } =
  await import("../../src/agents/subagents/registry/subagent-registry-read.js");
const context = buildSessionListRowMetadataContext({
  now: 1,
  subagentRuns: buildSubagentSessionListReadIndex(1, undefined, new Map()),
});
const sessions = parseStrictIntegerOption({
  raw: values.sessions,
  label: "--sessions",
  min: 300,
  fallback: 10000,
});
const reads = parseStrictIntegerOption({
  raw: values.reads,
  label: "--reads",
  min: 1,
  fallback: 1,
});
const corpus: unknown[] = [];
const inspector = new Session();
const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);

try {
  if (values.allocation || values["cpu-profile"]) {
    inspector.connect();
  }
  for (const scope of ["per-sender", "global"] as const) {
    const models = Array.from({ length: 32 }, (_, index) => ({
      id: `model-${index}`,
      name: `Synthetic model ${index}`,
      contextTokens: 32768 + index * 1024,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 8192,
    }));
    const modelCatalog = models.map((model) => ({ ...model, provider: "fixture" }));
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      session: { scope },
      models: { providers: { fixture: { baseUrl: "https://fixture.invalid", models } } },
    };
    const rows = new Map<string, Row>();
    const inventory: Row[] = [];
    const inputs: ReturnType<typeof readSessionRowInputs>["inputs"][] = [];
    const readInputs = (row: Row, runtimeResolution = createSessionRuntimeResolution(cfg)) =>
      readSessionRowInputs({
        cfg,
        key: row.key,
        agentId: row.agentId,
        entry: row.entry,
        store: {},
        storePath: row.storeTarget.storePath,
        rowContext: context,
        active: false,
        activeModel: null,
        terminalModel: null,
        preparedAcpMeta: null,
        preparedRuntimeOwnership: null,
        preparedModelMetadata: null,
        preparedRepositoryWorkspace: null,
        lightweightListRow: true,
        skipTranscriptUsageFallback: true,
        now: 1,
        runtimeResolution,
        modelCatalog,
      }).inputs;
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
    const coldStart = performance.now();
    const coldCpu = process.threadCpuUsage();
    for (let index = 0; index < sessions; index++) {
      const entry: InternalSessionEntry = {
        sessionId: `synthetic-${index}`,
        updatedAt: 1_750_000_000_000 + index,
        lifecycleRevision: "synthetic-generation",
        label: `Synthetic completed task ${index}`,
        status: "done",
        providerOverride: "fixture",
        modelOverride: models[index % models.length]!.id,
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
      if (values.materialize) {
        const input = readInputs(acquired);
        inputs.push(input);
        acquired.materialized = materializeSessionRow(input);
      }
    }
    const coldWallMs = performance.now() - coldStart;
    const coldUsed = process.threadCpuUsage(coldCpu);
    let sequence = 0;
    const acquire = () => {
      sequence++;
      let runtimeResolution = createSessionRuntimeResolution(cfg);
      for (const [index, row] of inventory.entries()) {
        if (index % 64 === 0) {
          runtimeResolution = createSessionRuntimeResolution(cfg);
        }
        for (let read = 0; read < reads; read++) {
          const next = records.acquireSessionRowEntry({
            ...owner,
            row,
            storedEntry: values.snapshots ? structuredClone(row.storedEntry) : row.storedEntry,
          });
          if (values.materialize && read === 0) {
            const input = values.refresh ? readInputs(row, runtimeResolution) : inputs[index]!;
            row.materialized = materializeSessionRow(input, row.materialized);
            if (values.refresh && records.ready(row)) {
              records.publishTranscriptFields(
                row,
                {
                  lastMessagePreview: `Synthetic preview ${sequence}`,
                  lastAssistantMessage: {
                    text: `Synthetic assistant ${sequence}`,
                    timestamp: sequence,
                  },
                },
                cfg,
                context,
              );
            } else {
              row.materialized = replaceSessionRowFacts(row.materialized, {
                lastMessagePreview: "Synthetic preview",
              });
            }
          }
          if (next !== row) {
            throw new Error("Unchanged acquisition replaced a retained row");
          }
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
    if (values["cpu-profile"]) {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    const cpuStart = process.threadCpuUsage();
    const started = performance.now();
    const samples: number[] = [];
    for (let pass = 0; pass < passes; pass++) {
      const at = performance.now();
      acquire();
      samples.push(performance.now() - at);
    }
    samples.sort((a, b) => a - b);
    const wallMs = performance.now() - started;
    const cpu = process.threadCpuUsage(cpuStart);
    let allocatedBytes: number | undefined;
    if (values.allocation) {
      allocatedBytes = bytes((await inspector.post("HeapProfiler.stopSampling")).profile.head);
    }
    if (values["cpu-profile"]) {
      writeFileSync(
        `${values["cpu-profile"]}-${scope}.json`,
        JSON.stringify((await inspector.post("Profiler.stop")).profile),
      );
    }
    assert.equal(publications, 0);
    if (values.corpus) {
      const decisions = [];
      for (const [index, originalRow] of inventory.entries()) {
        let row = originalRow;
        for (const patch of [
          {},
          { label: "Renamed" },
          { parentSessionKey: "agent:main:replacement" },
          { spawnedBy: "agent:main:replacement" },
          { archivedAt: 2 },
          {},
          { archivedAt: 3, label: "Deferred archive" },
          { archivedAt: undefined },
          {
            sessionId: `${row.entry!.sessionId}-successor`,
            previousSessionId: row.entry!.sessionId,
          },
          { owner: { actor: { type: "agent" as const, id: "helper" }, assignedAt: 2 } },
        ]) {
          const storedEntry = { ...structuredClone(row.storedEntry!), ...patch };
          if (patch.label === "Deferred archive") {
            row = Object.assign({}, row, { storedEntry, sharingEntry: storedEntry });
            row.entryAcquisitionPending = true;
          }
          const previous = row;
          const publishedBefore = publications;
          const related: boolean[] = [];
          row = records.acquireSessionRowEntry({
            ...owner,
            row,
            storedEntry,
            markRelated: (_, children) => related.push(children),
          })!;
          const input = values.materialize ? { ...inputs[index]!, entry: row.entry } : undefined;
          const priorMaterialized = row.materialized;
          const materialized =
            input &&
            materializeSessionRowIfChanged(row, input, row.membership, {
              profileRevision: 0,
              subagentRevision: 0,
            });
          row.materialized = materialized;
          const unchanged =
            input &&
            materializeSessionRowIfChanged(row, input, row.membership, {
              profileRevision: 0,
              subagentRevision: 0,
            });
          assert.equal(unchanged, materialized);
          if (materialized) {
            assert(Object.isFrozen(materialized.row));
          }
          decisions.push({
            related,
            materializedChanged: materialized !== priorMaterialized,
            changed: row !== previous,
            published: publications !== publishedBefore,
            generationChanged: row.generation !== previous.generation,
            entry: row.entry,
            parents: [...row.parents],
            selection: row.selection,
            row: materialized?.row,
          });
          if (records.ready(row)) {
            for (const fields of [
              {
                lastMessagePreview: "First",
                lastAssistantMessage: { text: "Answer", timestamp: 1 },
              },
              {
                lastMessagePreview: "First",
                lastAssistantMessage: { text: "Answer", timestamp: 1 },
              },
              {
                lastMessagePreview: "Next",
                lastAssistantMessage: { text: "Next answer", timestamp: 2 },
              },
              {},
              {},
            ]) {
              const changed = records.publishTranscriptFields(row, fields, cfg, context);
              decisions.push({ transcriptChanged: changed, row: row.materialized.row });
              assert(Object.isFrozen(row.materialized.row));
              if (row.materialized.row.lastAssistantMessage) {
                assert(Object.isFrozen(row.materialized.row.lastAssistantMessage));
              }
            }
          }
        }
      }
      corpus.push(decisions);
    }
    const operations = sessions * passes;
    console.log(
      JSON.stringify({
        arm: values["base-file"] || values["base-dir"] ? "base" : "candidate",
        sourceHash: createHash("sha256")
          .update([...sources.values()].join("\n"))
          .digest("hex"),
        node: process.version,
        scope,
        mode: values.allocation ? "allocation" : values["cpu-profile"] ? "cpu-profile" : "timing",
        materialize: Boolean(values.materialize),
        snapshots: Boolean(values.snapshots),
        refresh: Boolean(values.refresh),
        sessions,
        passes,
        reads,
        coldWallMs,
        coldCpuUs: coldUsed.user + coldUsed.system,
        medianPassMs: samples[Math.floor(samples.length / 2)],
        p95PassMs: samples[Math.ceil(samples.length * 0.95) - 1],
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
  if (values.corpus) {
    writeFileSync(values.corpus, JSON.stringify(corpus));
  }
}
