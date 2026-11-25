// Compare the real hydration codec with a pinned prior owner; no database or live data needed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";

const { values } = parseArgs({
  options: {
    "baseline-source": { type: "string" },
    "owner-file": { type: "string" },
    child: { type: "boolean" },
    output: { type: "string" },
  },
});
if (!values.child) {
  assert(values["baseline-source"] && values.output, "Require --baseline-source and --output");
  const samples: unknown[] = [];
  const hashes = new Map<string, string>();
  for (const experiment of ["AA", "AB"]) {
    for (let pair = 0; pair < 5; pair++) {
      for (const arm of pair % 2 ? ["second", "first"] : ["first", "second"]) {
        const baseline = experiment === "AA" || arm === "first";
        const result = JSON.parse(
          execFileSync(
            process.execPath,
            [
              "--expose-gc",
              "--import",
              "./scripts/tsx.mjs",
              fileURLToPath(import.meta.url),
              "--child",
              ...(baseline ? ["--owner-file", values["baseline-source"]] : []),
            ],
            { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
          ),
        );
        for (const row of result.rows) {
          const key = `${row.count}/${row.version}`;
          if (hashes.has(key)) {
            assert.equal(row.digest, hashes.get(key), `Partition mismatch ${key}`);
          }
          hashes.set(key, row.digest);
        }
        samples.push({ experiment, pair, arm, ...result });
        writeFileSync(values.output, `${JSON.stringify(samples, null, 2)}\n`);
        process.stderr.write(`${experiment} ${pair} ${arm} complete\n`);
      }
    }
  }
} else {
  const replaced = registerPerfOwnerReplacement(
    new URL("../../src/config/sessions/session-entry-codec.ts", import.meta.url).href,
    values["owner-file"],
  );
  const { prepareSessionManagerEntries } =
    await import("../../src/agents/sessions/session-manager-codec.js");
  assert(!values["owner-file"] || replaced());
  const inspector = new Session();
  inspector.connect();
  function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
    return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
  }
  const rows = [];
  for (const count of [1000, 5000, 20000]) {
    for (const version of [4, 2]) {
      const text = "synthetic tool output ".repeat(64);
      const entries: unknown[] = [{ type: "session", id: "synthetic", version }];
      for (let index = 0; index < count; index++) {
        const base = { id: `e${index}`, parentId: index ? `e${index - 1}` : null };
        const variants = [
          {
            type: "message",
            message: {
              role: "assistant",
              content: Array.from({ length: 12 }, (_, n) => ({
                type: "toolCall",
                id: `t${n}`,
                name: "read",
                arguments: { path: "synthetic.txt" },
              })),
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "t0",
              toolName: "read",
              isError: false,
              content: Array.from({ length: 16 }, () => ({ type: "text", text })),
              details: { rows: [{ text }] },
            },
          },
          { type: "message", message: { role: "user", content: [{ type: "text", text }] } },
          { type: "compaction", summary: text, firstKeptEntryId: "e0", tokensBefore: 120000 },
          { type: "custom", customType: "plugin-state", data: { text } },
          { type: "future-plugin", data: { text } },
          { type: "message", message: { role: "custom", content: text } },
          { type: "message", message: { role: "user", content: [{ text }] } },
          { type: "model_change", provider: "openai" },
          { type: "reset", reason: ["reset"] },
        ];
        // Mostly tool exchanges, with occasional compaction/plugin/opaque/corrupt rows.
        const variant = index % 100 < 7 ? (index % 100) + 3 : index % 3;
        entries.push({ ...base, ...variants[variant] });
      }
      const bytes = entries.reduce<number>(
        (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 1,
        1,
      );
      const result = prepareSessionManagerEntries(entries);
      const hasher = createHash("sha256");
      for (const collection of [
        result.fileEntries,
        result.opaqueEntries,
        result.fileEntriesByOriginalIndex,
      ]) {
        hasher.update("[");
        for (const entry of collection) {
          hasher.update(JSON.stringify(entry) ?? "null").update(",");
        }
        hasher.update("]");
      }
      const digest = hasher.digest("hex");
      const iterations = Math.max(5, Math.floor(100000 / count));
      for (let n = 0; n < 5; n++) {
        prepareSessionManagerEntries(entries);
      }
      global.gc?.();
      const wall = performance.now();
      const cpu = process.threadCpuUsage();
      const durations = [];
      for (let n = 0; n < iterations; n++) {
        const start = performance.now();
        prepareSessionManagerEntries(entries);
        durations.push(performance.now() - start);
      }
      const used = process.threadCpuUsage(cpu);
      const wallMs = (performance.now() - wall) / iterations;
      global.gc?.();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 16384,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      for (let n = 0; n < iterations; n++) {
        prepareSessionManagerEntries(entries);
      }
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      durations.sort((a, b) => a - b);
      rows.push({
        count,
        version,
        bytes,
        iterations,
        digest,
        recognized: result.fileEntries.length,
        opaque: result.opaqueEntries.length,
        cpuMs: (used.user + used.system) / 1000 / iterations,
        wallMs,
        p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
        allocationBytes: allocated(profile.head) / iterations,
      });
    }
  }
  inspector.disconnect();
  process.stdout.write(JSON.stringify({ node: process.version, load: loadavg(), rows }));
}
