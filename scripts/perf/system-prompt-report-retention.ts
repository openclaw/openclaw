// Synthetic report-owner proof; run with --expose-gc --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    mode: { type: "string", default: "retention" },
    operations: { type: "string", default: "200" },
    snapshot: { type: "string" },
    "expect-detached": { type: "boolean" },
    "ready-file": { type: "string" },
    "start-file": { type: "string" },
  },
});
assert(global.gc, "Use --expose-gc");
assert(["retention", "timing", "allocation"].includes(values.mode));
assert(/^\d+$/.test(values.operations));
const operations = Number(values.operations);
assert(Number.isSafeInteger(operations) && operations > 0);
assert(Boolean(values["ready-file"]) === Boolean(values["start-file"]));
const { buildSystemPromptReport }: typeof import("../../src/agents/system-prompt-report.js") =
  await import(
    values.owner ? pathToFileURL(values.owner).href : "../../src/agents/system-prompt-report.ts"
  );
const tools = Array.from({ length: 40 }, (_, index) => ({
  name: `synthetic_tool_${index}`,
  description: `Synthetic tool ${index}`,
  parameters: { type: "object", properties: { query: { type: "string" } } },
}));
const catalogMarker = "<available_skills>\n<!-- synthetic-report-catalog:";
function fixture(index: number) {
  const skillsPrompt = Buffer.from(
    `${catalogMarker}${index} -->\n${Array.from(
      { length: 80 },
      (_, skill) =>
        `<skill><name>synthetic-long-skill-${skill}</name><description>${"Synthetic guidance. ".repeat(40)}</description><location>/skills/${skill}/SKILL.md</location></skill>`,
    ).join("\n")}\n</available_skills>`,
  ).toString();
  return {
    source: "run" as const,
    generatedAt: index,
    sessionId: `synthetic-${index}`,
    bootstrapMaxChars: 20_000,
    systemPrompt: `## Skills\n${skillsPrompt}`,
    skillsPrompt,
    injectedWorkspaceFiles: [],
    tools,
  };
}
async function collect() {
  for (let pass = 0; pass < 3; pass++) {
    await nextTurn();
    global.gc!();
  }
}
const warm = fixture(-1);
for (let index = 0; index < 1_000; index++) {
  buildSystemPromptReport(warm);
}
await collect();
if (values["ready-file"] && values["start-file"]) {
  await writeFile(values["ready-file"], "ready\n");
  let start = 0;
  while (!start) {
    start = Number(await readFile(values["start-file"], "utf8").catch(() => "0"));
    if (!start) {
      await delay(20);
    }
  }
  await delay(Math.max(0, start - Date.now()));
}
const digest = createHash("sha256");
if (values.mode === "retention") {
  const before = process.memoryUsage().heapUsed;
  const reports = Array.from({ length: operations }, (_, index) =>
    buildSystemPromptReport(fixture(index)),
  );
  // Clear RegExp's implicit last-input reference, which is unrelated to report ownership.
  /./.test(" ");
  await collect();
  const retainedHeap = process.memoryUsage().heapUsed - before;
  for (const report of reports) {
    assert.equal(report.skills.entries.length, 80);
    assert.equal(report.skills.entries[79]?.name, "synthetic-long-skill-79");
    digest.update(JSON.stringify(report));
  }
  if (values.snapshot) {
    writeHeapSnapshot(values.snapshot);
  }
  reports.length = 0;
  await collect();
  console.log(
    JSON.stringify({
      mode: values.mode,
      node: process.version,
      operations,
      skillsPerReport: 80,
      catalogChars: warm.skillsPrompt.length,
      retainedHeap,
      releasedHeap: process.memoryUsage().heapUsed - before,
      digest: digest.digest("hex"),
    }),
  );
  if (values["expect-detached"]) {
    assert(
      retainedHeap < (operations * warm.skillsPrompt.length) / 2,
      "Compact reports retained their discarded input catalogs",
    );
  }
} else {
  const collections: Array<{ kind: number; duration: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const detail = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
      collections.push({ kind: detail.kind, duration: entry.duration });
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const inspector = new Session();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const before = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < operations; index++) {
    const report = buildSystemPromptReport(warm);
    assert.equal(report.skills.entries.length, 80);
    if (index % 100 === 0) {
      await nextTurn();
    }
  }
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(before);
  let sampledBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    inspector.disconnect();
  }
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  console.log(
    JSON.stringify({
      mode: values.mode,
      node: process.version,
      operations,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      sampledBytes,
      gc: [...new Set(collections.map(({ kind }) => kind))].map((kind) => {
        const durations = collections.filter((entry) => entry.kind === kind).map((e) => e.duration);
        return {
          kind,
          count: durations.length,
          totalMs: durations.reduce((sum, value) => sum + value, 0),
          maxMs: Math.max(0, ...durations),
        };
      }),
    }),
  );
}
