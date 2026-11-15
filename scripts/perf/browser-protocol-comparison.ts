/**
 * Interleaved real-Gateway A1/B/A2 control, five triples each for timing/allocation.
 * node --import ./scripts/tsx.mjs scripts/perf/browser-protocol-comparison.ts \
 *   --baseline-entry /baseline/src/entry.ts --candidate-entry src/entry.ts \
 *   --executable /path/to/chromium --output .local/browser-comparison
 * Three isolated Gateways stay alive; each warms 20 steps before its first heap.
 * A1 and A2 are independent baseline instances with the same cumulative workload as B.
 * Each measured batch repeats 20 identical mixed steps. CPU and allocation come
 * from the Gateway main isolate, not the driver. Full heaps bracket all batches;
 * each batch separately records pre-GC and post-GC memory, outside its timing.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";

const { values } = parseArgs({
  options: {
    "baseline-entry": { type: "string" },
    "candidate-entry": { type: "string" },
    executable: { type: "string" },
    output: { type: "string" },
  },
});
assert(values["baseline-entry"] && values["candidate-entry"] && values.executable && values.output);
const output = path.resolve(values.output);
mkdirSync(output, { mode: 0o700 });
const children: ChildProcess[] = [];
function response(child: ChildProcess) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onMessage = (message: unknown) => {
      finish();
      if (isRecord(message)) {
        resolve(message);
      } else {
        reject(new Error("Invalid browser measurement response"));
      }
    };
    const onExit = () => {
      finish();
      reject(new Error("Browser measurement exited before responding; see driver.log"));
    };
    const onError = (error: Error) => {
      finish();
      reject(error);
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error("Browser measurement timed out; see driver.log"));
    }, 300_000);
    child.once("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
async function start(name: string, entry: string, rounds: number, port: number) {
  const log = createWriteStream(path.join(output, `${name}.log`));
  const child = spawn(
    process.execPath,
    [
      "--expose-gc",
      "--import",
      path.resolve("scripts/tsx.mjs"),
      path.resolve("scripts/perf/browser-protocol-retention.ts"),
      "--gateway-entry",
      path.resolve(entry),
      "--controlled",
      "--warmup",
      "20",
      "--steps",
      "20",
      "--rounds",
      String(rounds),
      "--port",
      String(port),
      "--executable",
      values.executable!,
      "--output",
      path.join(output, name),
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], detached: true },
  );
  children.push(child);
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.once("close", () => log.end());
  const ready = await response(child);
  assert(ready.ready === true);
  return child;
}
const results: Array<Record<string, unknown>> = [];
try {
  const baseline = await start("A1", values["baseline-entry"], 10, 43921);
  // Separate the full derived browser/control/extension-relay port ranges.
  const candidate = await start("B", values["candidate-entry"], 10, 44021);
  const control = await start("A2", values["baseline-entry"], 10, 44121);
  for (const measure of ["timing", "allocation"]) {
    for (let pair = 1; pair <= 5; pair++) {
      for (const [name, child] of [
        ["A1", baseline],
        ["B", candidate],
        ["A2", control],
      ] as const) {
        const pending = response(child);
        child.send({ measure });
        const result = await pending;
        assert(isRecord(result.measured));
        const row = { measure, pair, name, ...result.measured };
        results.push(row);
        console.log(JSON.stringify(row));
        writeFileSync(path.join(output, "comparison.json"), JSON.stringify(results, null, 2));
      }
    }
  }
  // Heap capture starts only after every timed batch has finished.
  for (const child of children) {
    child.send({ finish: true });
  }
  // Drivers write their measured/closed heaps and result.json before exiting.
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          const onExit = (code: number | null) =>
            code === 0 ? resolve() : reject(new Error(`Driver exit ${code}`));
          if (child.exitCode !== null) {
            onExit(child.exitCode);
          } else {
            child.once("exit", onExit);
          }
        }),
    ),
  );
} finally {
  await Promise.all(children.map((child) => stopChild(child, { teardownGraceMs: 30_000 })));
}
