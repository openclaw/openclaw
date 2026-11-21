/**
 * Alternate real append batches between two prepared processes, never concurrently.
 * --owners-dir <baseline> --output <prefix> --scratch <dir> --seed-database <db>
 * --workspace <dir>; add --control for A/A, --first B for counterbalanced A/B.
 * Run five pairs of each; retain the uncoupled results and require stable A/A controls.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { on } from "node:events";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "owners-dir": { type: "string" },
    output: { type: "string" },
    scratch: { type: "string" },
    "seed-database": { type: "string" },
    workspace: { type: "string" },
    control: { type: "boolean", default: false },
    first: { type: "string", default: "A" },
    history: { type: "string", default: "2400" },
    operations: { type: "string", default: "6000" },
    "batch-size": { type: "string", default: "100" },
  },
});
assert(values["owners-dir"] && values.output && values.scratch);
assert(values.first === "A" || values.first === "B");
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const batchSize = integer(values["batch-size"], "batch-size");
const warmup = integer(values.history, "history");
const operations = integer(values.operations, "operations");
const prefix = path.resolve(values.output);
mkdirSync(path.dirname(prefix), { recursive: true });
const children: ReturnType<typeof start>[] = [];
function start(side: "A" | "B") {
  const suffix = values.control ? (side === "A" ? "left" : "right") : side;
  const output = `${prefix}-${suffix}.json`;
  const args = [
    "--expose-gc",
    "--import",
    fileURLToPath(new URL("../tsx.mjs", import.meta.url)),
    fileURLToPath(new URL("./transcript-append-normalization-measure.ts", import.meta.url)),
    "--fixture",
    "tools",
    "--mode",
    "timing",
    "--output",
    output,
  ];
  for (const key of [
    "scratch",
    "seed-database",
    "workspace",
    "history",
    "operations",
    "batch-size",
  ] as const) {
    if (values[key]) {
      args.push(`--${key}`, values[key]);
    }
  }
  if (side === "A" || values.control) {
    args.push("--owners-dir", values["owners-dir"]!);
  }
  const log = openSync(`${output}.log`, "wx");
  const child = (() => {
    try {
      return spawn(process.execPath, args, { stdio: ["ignore", log, log, "ipc"] });
    } finally {
      closeSync(log);
    }
  })();
  const messages = on(child, "message");
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const ready = async (phase: string, completed: number) => {
    const message: unknown = await Promise.race([
      messages.next().then((event) => event.value?.[0]),
      exited.then((code) => {
        throw new Error(`${side} exited early: ${code}; inspect ${output}.log`);
      }),
    ]);
    assert.deepEqual(message, { phase, completed });
  };
  const arm = { child, messages, exited, ready, output };
  return arm;
}
try {
  const a = start("A");
  children.push(a);
  await a.ready("warmup", 0);
  const b = start("B");
  children.push(b);
  await b.ready("warmup", 0);
  const order = values.first === "A" ? [a, b] : [b, a];
  for (const [phase, count] of [
    ["warmup", warmup],
    ["measure", operations],
  ] as const) {
    if (phase === "measure") {
      for (const arm of order) {
        arm.child.send("continue");
        await arm.ready(phase, 0);
      }
    }
    for (let completed = 0; completed < count; completed += batchSize) {
      for (const arm of order) {
        arm.child.send("continue");
        await arm.ready(phase, Math.min(completed + batchSize, count));
      }
    }
  }
  for (const arm of order) {
    arm.child.send("continue");
    assert.equal(await arm.exited, 0, `Append process failed: ${arm.output}`);
  }
  type Result = { persistedMessageSha256: string };
  const results: [Result, Result] = [
    JSON.parse(readFileSync(a.output, "utf8")),
    JSON.parse(readFileSync(b.output, "utf8")),
  ];
  assert.equal(results[0].persistedMessageSha256, results[1].persistedMessageSha256);
  console.log(JSON.stringify({ control: values.control, first: values.first, batchSize, results }));
} finally {
  for (const arm of children) {
    if (arm.child.exitCode === null && arm.child.signalCode === null) {
      arm.child.kill();
    }
    await arm.messages.return?.();
  }
  await Promise.allSettled(children.map((arm) => arm.exited));
}
