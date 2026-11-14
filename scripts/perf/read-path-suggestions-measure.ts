/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/read-path-suggestions-measure.ts \
 *   --baseline <parent-sha> --sizes 50000 --pairs 5 --mode timing
 * Repeat with --mode allocation (timing under heap sampling is not acceptance evidence).
 * Exact read/edit/distance owner sources, unchanged current dependencies, real files,
 * createReadTool.execute and prepareFileEdit. Not model/Gateway latency.
 * Edit retries are ten calls; a ten-edit batch stops at its first failing entry.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    pairs: { type: "string", default: "5" },
    workloads: { type: "string", default: "read,edit" },
    sizes: { type: "string", default: "1000,10000,50000" },
    mode: { type: "string", default: "timing" },
    "fixture-root": { type: "string", default: ".local" },
  },
});
assert(values.baseline, "--baseline <commit> is required");
assert(globalThis.gc, "run node with --expose-gc");
assert(["timing", "allocation"].includes(values.mode));
const pairs = Number(values.pairs);
const sizes = values.sizes.split(",").map(Number);
assert(Number.isSafeInteger(pairs) && pairs > 0);
assert(sizes.every((size) => Number.isSafeInteger(size) && size >= 10));
const root = fileURLToPath(new URL("../../", import.meta.url));
const readPath = "src/agents/sessions/tools/read.ts";
const editPath = "src/agents/sessions/tools/edit-diff.ts";
const distancePath = "src/shared/levenshtein-distance.ts";
const baseline = execFileSync("git", ["rev-parse", values.baseline], {
  cwd: root,
  encoding: "utf8",
}).trim();
const owners = new Map<string, string>();
for (const arm of ["base", "candidate"]) {
  for (const filename of [readPath, distancePath, editPath]) {
    const source =
      arm === "base"
        ? execFileSync("git", ["show", `${baseline}:${filename}`], { cwd: root, encoding: "utf8" })
        : readFileSync(path.join(root, filename), "utf8");
    const url = pathToFileURL(path.join(root, filename));
    url.searchParams.set("read-bench", arm);
    owners.set(url.href, source);
  }
}
const loaded = new Set<string>();
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL?.includes("?read-bench=") &&
      specifier.endsWith("shared/levenshtein-distance.js")
    ) {
      const url = pathToFileURL(path.join(root, distancePath));
      url.search = new URL(context.parentURL).search;
      return { url: url.href, shortCircuit: true };
    }
    if (owners.has(specifier)) {
      return { url: specifier, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const source = owners.get(url);
    if (source === undefined) {
      return next(url, context);
    }
    loaded.add(url);
    return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});
type ReadModule = typeof import("../../src/agents/sessions/tools/read.js");
type EditModule = typeof import("../../src/agents/sessions/tools/edit-diff.js");
type DistanceModule = typeof import("../../src/shared/levenshtein-distance.js");
const modules = new Map<string, { read: ReadModule; distance: DistanceModule; edit: EditModule }>();
try {
  for (const arm of ["base", "candidate"]) {
    modules.set(arm, {
      edit: await import(`${pathToFileURL(path.join(root, editPath)).href}?read-bench=${arm}`),
      read: await import(`${pathToFileURL(path.join(root, readPath)).href}?read-bench=${arm}`),
      distance: await import(
        `${pathToFileURL(path.join(root, distancePath)).href}?read-bench=${arm}`
      ),
    });
  }
} finally {
  hooks.deregister();
}
assert.equal(loaded.size, owners.size, "all selected owner sources must load");

function syntheticName(index: number): string {
  const hex = createHash("sha256").update(`synthetic-session-${index}`).digest("hex");
  return [
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}.jsonl`,
    `2026-10-${String(1 + (index % 28)).padStart(2, "0")}-agent-turn-${hex.slice(0, 20)}.json`,
    `openclaw-wt-fix-session-${hex.slice(0, 12)}-read-path-${index}.ts`,
    `transcript-${index}-${hex.slice(0, 24)}.jsonl.deleted.2026-10-31`,
  ][index % 4]!;
}

// Compare the pinned old implementation directly, including its bounded empty-string contract.
const filenames = execFileSync("git", ["ls-files", "src/shared", "src/agents/sessions/tools"], {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .slice(0, 128)
  .map((filename) => path.basename(filename));
const equivalencePairs: [string, string][] = filenames.map((name, index) => [
  name,
  filenames[(index + 1) % filenames.length]!,
]);
let seed = 2141;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const randomString = () =>
  Array.from({ length: random() % 48 }, () => String.fromCharCode(random() % 65536)).join("");
for (let index = 0; index < 200; index++) {
  equivalencePairs.push([randomString(), randomString()]);
}
equivalencePairs.push(["", ""], ["", "abc"], ["abc", ""], ["same", "same"]);
let equivalenceCases = 0;
for (const [left, right] of equivalencePairs) {
  for (const bound of [undefined, 0, 1, 3, 10, 64]) {
    const results = ["base", "candidate"].map((arm) => {
      const distance = modules.get(arm)!.distance.levenshteinDistance;
      return bound === undefined ? distance(left, right) : distance(left, right, bound);
    });
    assert.equal(results[0], results[1], "baseline distance equivalence");
    equivalenceCases++;
  }
}

const records: (Awaited<ReturnType<typeof measure>> & {
  workload: string;
  control: string;
  pair: number;
  arm: string;
  load: number[];
})[] = [];
const inspector = new Session();
async function measure(operation: () => unknown) {
  globalThis.gc!();
  if (values.mode === "allocation") {
    await startCollectedHeapSampling(inspector, 4096);
  }
  const heapBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const loop = performance.eventLoopUtilization();
  const start = performance.now();
  const result = await operation();
  const elapsedMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  const activeMs = performance.eventLoopUtilization(loop).active;
  const heapAfter = process.memoryUsage();
  let sampledHeapBytes: number | undefined;
  if (values.mode === "allocation") {
    sampledHeapBytes = sumSampledHeapBytes(
      (await inspector.post("HeapProfiler.stopSampling")).profile.head,
    );
    inspector.disconnect();
  }
  return {
    result,
    elapsedMs,
    mainThreadCpuMs: (used.user + used.system) / 1000,
    activeMs,
    heapGrowthBytes: heapAfter.heapUsed - heapBefore.heapUsed,
    externalGrowthBytes: heapAfter.external - heapBefore.external,
    sampledHeapBytes,
  };
}
async function compare(workload: string, operation: (arm: string) => unknown) {
  // Warm both arms through the same profiler/GC path before A/A can warm only the base.
  for (let warmup = 0; warmup < 10; warmup++) {
    for (const arm of ["base", "candidate"]) {
      await measure(() => operation(arm));
    }
  }
  for (const control of [true, false]) {
    for (let pair = 0; pair < pairs; pair++) {
      const order = pair % 2 ? ["candidate", "base"] : ["base", "candidate"];
      let expected: unknown;
      for (const label of order) {
        const arm = control ? "base" : label;
        const sample = await measure(() => operation(arm));
        if (expected === undefined) {
          expected = sample.result;
        } else {
          assert.deepEqual(sample.result, expected, `${workload}: result drift`);
        }
        records.push({
          workload,
          control: control ? "AA" : "AB",
          pair,
          arm: label,
          load: loadavg(),
          ...sample,
        });
      }
    }
  }
}

await mkdir(values["fixture-root"], { recursive: true });
const fixture = await mkdtemp(path.join(path.resolve(values["fixture-root"]), "read-suggestion-"));
try {
  for (const size of values.workloads.includes("read") ? sizes : []) {
    const dir = path.join(fixture, String(size));
    await mkdir(dir);
    const names = [
      "README.md",
      "READMI.md",
      "READMX.md",
      syntheticName(700001),
      ...Array.from({ length: size - 4 }, (_, i) => syntheticName(i)),
    ];
    for (let offset = 0; offset < names.length; offset += 64) {
      await Promise.all(
        names
          .slice(offset, offset + 64)
          .map((name) => writeFile(path.join(dir, name), "synthetic\n")),
      );
    }
    const tools = new Map(
      [...modules].map(([arm, module]) => [arm, module.read.createReadTool(dir)]),
    );
    for (const requested of ["READMZ.md", syntheticName(700001).replace(".json", ".jsox")]) {
      await compare(`read-${size}-${requested.length < 10 ? "short" : "long"}`, async (arm) => {
        try {
          await tools.get(arm)!.execute("benchmark-read", { path: requested });
          return assert.fail("fixture read must miss");
        } catch (error) {
          assert(error instanceof Error && error.message.includes("File not found:"));
          assert(error.message.includes("Did you mean:"), "missing helpful suggestions");
          return error.message;
        }
      });
    }
  }
  function editOutcome(arm: string, content: string, oldTexts: string[]) {
    try {
      return modules.get(arm)!.edit.prepareFileEdit(
        content,
        oldTexts.map((oldText) => ({ oldText, newText: "replacement" })),
        "synthetic.ts",
      );
    } catch (error) {
      assert(error instanceof Error);
      return error.message;
    }
  }
  if (values.workloads.includes("edit")) {
    // Whole owner outputs include candidate order, scores, hints and Unicode handling.
    const alphabet = "abCD 01._\t🙂é";
    const text = (length: number) =>
      Array.from({ length }, () => alphabet[random() % alphabet.length]).join("");
    for (let i = 0; i < 400; i++) {
      const expected = text(1 + (random() % 140));
      const content = Array.from({ length: 4 + (random() % 30) }, (_, line) =>
        line % 3 ? text(random() % 145) : expected.slice(0, random() % expected.length) + "x",
      ).join("\n");
      assert.deepEqual(
        editOutcome("candidate", content, [expected]),
        editOutcome("base", content, [expected]),
      );
      equivalenceCases++;
    }
    for (let length = 1; length <= 120; length++) {
      const expected = "a".repeat(length);
      const distance = Math.floor(length * 0.55);
      const content = [-1, 0, 1]
        .map((offset) => {
          const changed = Math.max(0, Math.min(length, distance + offset));
          return "a".repeat(length - changed) + "b".repeat(changed);
        })
        .join("\n");
      assert.deepEqual(
        editOutcome("candidate", content, [expected]),
        editOutcome("base", content, [expected]),
      );
      equivalenceCases++;
    }
    for (const shape of ["unrelated", "near"]) {
      const expected = "a".repeat(120);
      const content = Array.from({ length: 1000 }, (_, i) =>
        shape === "unrelated"
          ? "z".repeat(120)
          : expected.slice(0, 119 - (i % 60)) + "b".repeat(1 + (i % 60)),
      ).join("\n");
      await compare(`edit-${shape}-10x1000x120`, (arm) => {
        const results = Array.from({ length: 10 }, () => editOutcome(arm, content, [expected]));
        assert(
          results.every(
            (result) => typeof result === "string" && result.startsWith("Could not find"),
          ),
        );
        return results;
      });
      await compare(`edit-${shape}-batch10x1000x120`, (arm) =>
        editOutcome(arm, content, Array(10).fill(expected)),
      );
    }
  }
  const corpus = [
    "kitten",
    "sitting",
    "gateway",
    "gatway",
    "sessions_spawn",
    "sessions-spawn",
    "README.md",
    "READMZ.md",
    syntheticName(1),
    syntheticName(2),
    "anthropic/model-fast",
    "anthropic/model-small",
  ];
  for (const bounded of [false, true]) {
    await compare(`distance-${bounded ? "bounded" : "full"}-12000`, (arm) => {
      const distance = modules.get(arm)!.distance.levenshteinDistance;
      let checksum = 0;
      for (let i = 0; i < 12000; i++) {
        const left = corpus[i % corpus.length]!;
        const right = corpus[(i + 1) % corpus.length]!;
        checksum += (bounded ? distance(left, right, 3) : distance(left, right)) ?? -1;
      }
      return checksum;
    });
  }
  const summary = [
    ...new Set(records.map((record) => `${record.workload}/${record.control}/${record.arm}`)),
  ].map((key) => {
    const selected = records.filter(
      (record) => `${record.workload}/${record.control}/${record.arm}` === key,
    );
    const metrics = Object.fromEntries(
      (
        ["elapsedMs", "mainThreadCpuMs", "activeMs", "heapGrowthBytes", "sampledHeapBytes"] as const
      ).map((metric) => {
        const numbers = selected
          .map((record) => record[metric])
          .filter((value): value is number => typeof value === "number")
          .toSorted((a, b) => a - b);
        return [
          metric,
          numbers.length
            ? {
                median: numbers[Math.floor(numbers.length / 2)],
                p95: numbers[Math.ceil(numbers.length * 0.95) - 1],
                min: numbers[0],
                max: numbers.at(-1),
              }
            : undefined,
        ];
      }),
    );
    return Object.assign({ key, samples: selected.length }, metrics);
  });
  console.log(
    JSON.stringify(
      {
        baseline,
        equivalenceCases,
        mode: values.mode,
        node: process.version,
        platform: process.platform,
        sourceHashes: Object.fromEntries(
          [...owners].map(([url, source]) => [
            url,
            createHash("sha256").update(source).digest("hex"),
          ]),
        ),
        allocationNote:
          "Sampled V8 heap includes collected objects; ArrayBuffer backing stores are excluded. Heap growth is not total allocation.",
        summary,
        records,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
