/** node --expose-gc --import ./scripts/tsx.mjs scripts/perf/read-tool-decode-measure.ts --baseline <sha> --mode timing|allocation */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { decodeWindowsTextFileBuffer } from "../../src/infra/windows-encoding.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    mode: { type: "string", default: "timing" },
    sizes: { type: "string", default: "10240,262144,2097152,52428800" },
    pages: { type: "string", default: "limited" },
    samples: { type: "string", default: "5" },
    iterations: { type: "string", default: "10" },
  },
});
assert(values.baseline && globalThis.gc);
assert(["timing", "allocation"].includes(values.mode));
const root = fileURLToPath(new URL("../../", import.meta.url));
const baseline = execFileSync("git", ["rev-parse", values.baseline], { encoding: "utf8" }).trim();
const owners = new Map<string, string>();
const filenames = ["read.ts", "read-file.ts", "read-file-page.ts", "read-text-capture.ts"].map(
  (name) => `src/agents/sessions/tools/${name}`,
);
for (const arm of ["A1", "A2", "B"]) {
  for (const filename of filenames) {
    owners.set(
      `${pathToFileURL(path.join(root, filename)).href}?decode-bench=${arm}`,
      arm === "B"
        ? readFileSync(filename, "utf8")
        : execFileSync("git", ["show", `${baseline}:${filename}`], { encoding: "utf8" }),
    );
  }
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (owners.has(specifier)) {
      return { url: specifier, shortCircuit: true };
    }
    if (context.parentURL?.includes("?decode-bench=") && specifier.startsWith(".")) {
      const url = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      url.search = new URL(context.parentURL).search;
      if (owners.has(url.href)) {
        return { url: url.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const source = owners.get(url);
    return source === undefined
      ? next(url, context)
      : { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});
const captures = new Map<
  string,
  typeof import("../../src/agents/sessions/tools/read-text-capture.js")
>();
for (const arm of ["A1", "A2", "B"]) {
  captures.set(
    arm,
    await import(`${pathToFileURL(path.join(root, filenames[3]!)).href}?decode-bench=${arm}`),
  );
}
const modules = new Map<string, typeof import("../../src/agents/sessions/tools/read.js")>();
for (const arm of ["A1", "A2", "B"]) {
  modules.set(
    arm,
    await import(`${pathToFileURL(path.join(root, filenames[0]!)).href}?decode-bench=${arm}`),
  );
}
hooks.deregister();
const fixture = await mkdtemp(path.join(root, ".local/read-decode-"));
const records = [];
try {
  const equalityFile = path.join(fixture, "equality.txt");
  let equalityCases = 0;
  const texts = [
    "",
    "\uFEFF",
    "\uFEFF\uFEFFa\r\nb\r",
    "\r\n\n\r",
    "café 🦞\nlast\n",
    "a\r\rb\n",
    "x".repeat(60000) + "🦞\nend",
  ];
  const fixtures = texts.flatMap((text) =>
    ["utf8", "utf16le", "utf16be"].map((encoding) => {
      const bytes = Buffer.from(
        encoding === "utf8" ? text : "\uFEFF" + text,
        encoding === "utf8" ? "utf8" : "utf16le",
      );
      return encoding === "utf16be" ? bytes.swap16() : bytes;
    }),
  );
  fixtures.push(Buffer.from([0xe2, 0x82, 10, 0xac, 13, 10, 0xff]), Buffer.from([0xef, 0xbb]));
  for (const bytes of fixtures) {
    await writeFile(equalityFile, bytes);
    for (const page of [
      {},
      { offset: 2, limit: 1 },
      { offset: 1, limit: 1, cursor: 4 },
      { offset: 100, limit: 1 },
    ]) {
      const outcomes = [];
      for (const module of modules.values()) {
        try {
          outcomes.push(
            await module.createReadTool(fixture).execute("equal", { path: equalityFile, ...page }),
          );
        } catch (error) {
          assert(error instanceof Error);
          outcomes.push(error.message);
        }
      }
      assert.deepEqual(outcomes[1], outcomes[0]);
      assert.deepEqual(outcomes[2], outcomes[0]);
      equalityCases++;
    }
  }
  for (const ending of ["lf", "crlf"]) {
    for (const size of values.sizes.split(",").map(Number)) {
      const filename = path.join(fixture, `${size}.txt`);
      const line = Buffer.from(
        "synthetic log: café 🦞 state=ready request=1234567890 payload=abcdefghijklmnopqrstuvwxyz" +
          (ending === "lf" ? "\n" : "\r\n"),
      );
      const bytes = Buffer.alloc(size);
      for (let offset = 0; offset < size; offset += line.length) {
        line.copy(bytes, offset);
      }
      await writeFile(filename, bytes);
      for (const backend of ["local", "buffered", "owner"]) {
        const tools = new Map(
          [...modules].map(([arm, module]) => [
            arm,
            backend === "owner"
              ? {
                  execute: async (_id: string, input: { offset: number; limit?: number }) => {
                    const capture = captures.get(arm)!;
                    const selected = capture.createReadTextCapture({
                      ...input,
                      cursor: 0,
                      maxChars: 51202,
                    });
                    const text =
                      arm === "B"
                        ? capture.decodeReadTextBuffer({ buffer: bytes })
                        : decodeWindowsTextFileBuffer({ buffer: bytes });
                    selected.write(
                      typeof text === "string" && text.startsWith("\uFEFF") ? text.slice(1) : text,
                    );
                    return selected.finish();
                  },
                }
              : module.createReadTool(
                  fixture,
                  backend === "local"
                    ? undefined
                    : {
                        operations: { access: async () => {}, readFile: () => readFile(filename) },
                      },
                ),
          ]),
        );
        for (const page of values.pages === "default"
          ? [{ offset: 1 }]
          : [
              { offset: 1, limit: 50 },
              { offset: 75, limit: 200 },
            ]) {
          const input = { path: filename, ...page };
          const expected = await tools.get("A1")!.execute("equivalence", input);
          for (const tool of tools.values()) {
            assert.deepEqual(await tool.execute("equivalence", input), expected);
          }
          for (let warmup = 0; warmup < 3; warmup++) {
            for (const tool of tools.values()) {
              await tool.execute("warmup", input);
            }
          }
          const count = Number(values.iterations);
          for (let sample = 0; sample < Number(values.samples); sample++) {
            const order = sample % 2 ? ["B", "A2", "A1"] : ["A1", "A2", "B"];
            for (const arm of order) {
              globalThis.gc!();
              const inspector = new Session();
              if (values.mode === "allocation") {
                await startCollectedHeapSampling(inspector, 4096);
              }
              const cpu = process.cpuUsage();
              const threadCpu = process.threadCpuUsage();
              const start = performance.now();
              for (let iteration = 0; iteration < count; iteration++) {
                await tools.get(arm)!.execute("measure", input);
              }
              const wallMs = (performance.now() - start) / count;
              const used = process.cpuUsage(cpu);
              const cpuMs = (used.user + used.system) / 1000 / count;
              const threadUsed = process.threadCpuUsage(threadCpu);
              const threadCpuMs = (threadUsed.user + threadUsed.system) / 1000 / count;
              let allocationMB;
              if (values.mode === "allocation") {
                allocationMB =
                  sumSampledHeapBytes(
                    (await inspector.post("HeapProfiler.stopSampling")).profile.head,
                  ) /
                  count /
                  1e6;
                inspector.disconnect();
              }
              records.push({
                ending,
                size,
                backend,
                page,
                arm,
                sample,
                wallMs,
                cpuMs,
                threadCpuMs,
                allocationMB,
                load: loadavg(),
              });
            }
          }
        }
      }
    }
  }
  console.log(JSON.stringify({ baseline, equalityCases, mode: values.mode, records }));
} finally {
  await rm(fixture, { recursive: true, force: true });
}
