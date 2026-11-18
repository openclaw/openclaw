/**
 * Synthetic Readability A/A/B owner benchmark (Node 26).
 * node --import ./scripts/tsx.mjs extensions/web-readability/test/web-content-extractor.bench.ts <output.json>
 * A1/A2 run the unchanged extraction algorithm inline; B invokes the production plugin worker.
 * Five interleaved warmed repetitions, both modes, exact serialized output equality.
 * Longest callback includes promise callbacks; CPU and allocation are measured per thread.
 */
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { startHeapProfile } from "node:v8";
import { Worker } from "node:worker_threads";
import { createReadabilityWebContentExtractor } from "../web-content-extractor.js";
import { extractReadabilityContent } from "../web-content-extractor.runtime.js";

const shapes = ["news", "documentation", "forum", "catalog", "blog"];
const sizes = [50_000, 250_000, 900_000, 2_000_000];
const paragraph =
  "The coastal research team published its quarterly observations today. Scientists compared water temperatures, currents, and seasonal changes across several regions. The report describes the methods, explains the uncertainty, and provides practical examples for readers planning their next study. ";
const corpus = shapes.flatMap((shape, shapeIndex) =>
  sizes.map((size) => {
    const block = [
      `<section><h2>Regional observations</h2><p>${paragraph}</p><p>${paragraph}<a href="../sources">Sources</a></p></section>`,
      `<section><h2>Installation guide</h2><p>${paragraph}</p><pre><code>sample --region north</code></pre><ul><li>Prepare inputs</li><li>Review results</li></ul></section>`,
      `<div class="post"><h2>Discussion</h2><p>${paragraph}</p><blockquote>${paragraph}</blockquote></div>`,
      `<section><h2>Field equipment</h2><p>${paragraph}</p><table><tr><th>Item</th><th>Weight</th></tr><tr><td>Recorder</td><td>2 kg</td></tr></table></section>`,
      `<section><h2>Field notes</h2><p>${paragraph}</p><figure><img src="../photo.jpg" alt="Coast"><figcaption>Morning survey</figcaption></figure></section>`,
    ][shapeIndex];
    const prefix = `<!doctype html><html><head><title>${shape} report</title><base href="/reports/"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"${shape} observations"}</script></head><body><nav><a href="/">Home</a> <a href="/about">About</a></nav><aside hidden>Hidden menu</aside><main><article><h1>${shape} report</h1>`;
    const suffix = "</article></main><footer>Copyright Synthetic Research</footer></body></html>";
    const count = Math.floor((size - prefix.length - suffix.length) / block.length);
    const html =
      prefix +
      block.repeat(count) +
      " ".repeat(size - prefix.length - suffix.length - count * block.length) +
      suffix;
    return {
      id: `${shape}-${size}`,
      html,
      url: "https://example.test/reports/today",
      bytes: Buffer.byteLength(html),
    };
  }),
);

const outputPath = process.argv[2];
assert(outputPath, "Pass an output JSON path");
const workers = new Set<Worker>();
// Preserve the original receiver through apply below; binding here would lose each worker.
// eslint-disable-next-line @typescript-eslint/unbound-method
const postMessage = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (...args: Parameters<Worker["postMessage"]>) {
  workers.add(this);
  return postMessage.apply(this, args);
};
const functions = {
  A1: extractReadabilityContent,
  A2: extractReadabilityContent,
  B: createReadabilityWebContentExtractor().extract,
};
const modes = ["text", "markdown"] as const;
const phases = ["A1", "A2", "B"] as const;
const expected = new Map<string, string>();
let measuring = false;
let longestCallbackMs = 0;
const starts = new Map<number, number>();
const hook = createHook({
  before(id) {
    if (measuring) {
      starts.set(id, performance.now());
    }
  },
  after(id) {
    const start = starts.get(id);
    if (start !== undefined) {
      longestCallbackMs = Math.max(longestCallbackMs, performance.now() - start);
      starts.delete(id);
    }
  },
});
hook.enable();
const loadStart = loadavg();
const cold = [];
const samples = [];
async function measure(
  phase: (typeof phases)[number],
  page: (typeof corpus)[number],
  extractMode: (typeof modes)[number],
) {
  await nextTurn();
  longestCallbackMs = 0;
  measuring = true;
  const cpu = process.threadCpuUsage();
  const total = process.cpuUsage();
  const start = performance.now();
  // Start in an observable promise callback, including synchronous work before the first await.
  await Promise.resolve();
  const result = await functions[phase]({ html: page.html, url: page.url, extractMode });
  const wallMs = performance.now() - start;
  await nextTurn();
  const used = process.threadCpuUsage(cpu);
  const all = process.cpuUsage(total);
  measuring = false;
  const bytes = JSON.stringify(result);
  const key = `${page.id}-${extractMode}`;
  if (expected.has(key)) {
    assert.equal(bytes, expected.get(key), `Output differs for ${phase}/${key}`);
  } else {
    expected.set(key, bytes);
  }
  return {
    phase,
    id: page.id,
    extractMode,
    bytes: page.bytes,
    returned: result !== null,
    wallMs,
    longestCallbackMs,
    mainCpuMs: (used.user + used.system) / 1000,
    totalCpuMs: (all.user + all.system) / 1000,
    outputBytes: Buffer.byteLength(bytes),
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}
try {
  for (const phase of phases) {
    cold.push(await measure(phase, corpus[0]!, "text"));
  }
  for (const phase of phases) {
    for (const page of corpus) {
      for (const mode of modes) {
        await measure(phase, page, mode);
      }
    }
  }
  for (let round = 0; round < 5; round++) {
    for (const phase of phases) {
      for (const page of corpus) {
        for (const mode of modes) {
          samples.push({ round, ...(await measure(phase, page, mode)) });
        }
      }
      console.error(`Completed ${round + 1}/5 ${phase}`);
    }
  }
  hook.disable();
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        runtime: process.version,
        cpuCount: cpus().length,
        loadStart,
        loadEnd: loadavg(),
        cold,
        samples,
      },
      null,
      2,
    ),
  );
  const allocations = [];
  const keepAlive = setInterval(() => {}, 60_000);
  const options = {
    sampleInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  };
  type HeapNode = { selfSize: number; children: HeapNode[] };
  function allocated(node: HeapNode): number {
    return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
  }
  for (const phase of phases) {
    const main = startHeapProfile(options);
    const profiles = await Promise.all(
      [...workers].map((worker) => worker.startHeapProfile(options)),
    );
    for (const page of corpus) {
      for (const extractMode of modes) {
        await functions[phase]({ html: page.html, url: page.url, extractMode });
      }
    }
    const mainProfile = JSON.parse(main.stop());
    const workerProfiles = await Promise.all(
      profiles.map(async (profile) => JSON.parse(await profile.stop())),
    );
    allocations.push({
      phase,
      mainBytes: allocated(mainProfile.head),
      workerBytes: workerProfiles.reduce((sum, profile) => sum + allocated(profile.head), 0),
      rssBytes: process.memoryUsage().rss,
    });
  }
  clearInterval(keepAlive);
  const summary = Object.fromEntries(
    phases.map((phase) => {
      const rows = samples.filter((row) => row.phase === phase);
      return [
        phase,
        Object.fromEntries(
          (["wallMs", "longestCallbackMs", "mainCpuMs", "totalCpuMs"] as const).map((key) => {
            const values = rows.map((row) => row[key]).toSorted((a, b) => a - b);
            return [
              key,
              {
                median: values[Math.ceil(values.length * 0.5) - 1],
                p95: values[Math.ceil(values.length * 0.95) - 1],
                max: values.at(-1),
              },
            ];
          }),
        ),
      ];
    }),
  );
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        runtime: process.version,
        cpuCount: cpus().length,
        loadStart,
        loadEnd: loadavg(),
        cold,
        samples,
        allocations,
        summary,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ cold, allocations, summary }, null, 2));
} finally {
  measuring = false;
  hook.disable();
  Worker.prototype.postMessage = postMessage;
}
