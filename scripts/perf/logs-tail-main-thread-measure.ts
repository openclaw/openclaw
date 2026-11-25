// node --import ./scripts/tsx.mjs scripts/perf/logs-tail-main-thread-measure.ts <new fixture directory>
// Four isolated readers: interleaved A/A controls and A/B worker comparison, UI-sized cursor polls.
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";

const root = path.resolve(process.argv[2]!);
const file = path.join(root, "synthetic-day.log");
const options = { limit: 500, maxBytes: 250_000 };

if (process.argv[3] === "actor") {
  process.env.OPENCLAW_STATE_DIR = path.join(root, `state-${process.pid}`);
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
  const { applyLoggingConfig, setLoggerOverride } = await import("../../src/logging/logger.js");
  const { readConfiguredLogTail } = await import("../../src/logging/log-tail.js");
  const { readConfiguredLogTailInWorker } = await import("../../src/logging/log-tail-worker.js");
  const { registerSecretValueForRedaction } =
    await import("../../src/logging/secret-redaction-registry.js");
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  applyLoggingConfig({ file, level: "silent", consoleLevel: "silent" });
  setLoggerOverride({ file, level: "silent", consoleLevel: "silent" });
  registerSecretValueForRedaction("synthetic-exact-credential-123456789");
  const read = process.argv[4] === "worker" ? readConfiguredLogTailInWorker : readConfiguredLogTail;
  let cursor: number | undefined;
  const handleCommand = async (command: string) => {
    if (command === "stop") {
      await drainGlobalSingletonLifecycleState();
      process.disconnect?.();
      return;
    }
    global.gc?.();
    let maxSegmentMs = 0;
    const entered: number[] = [];
    const hook = createHook({
      before() {
        entered.push(performance.now());
      },
      after() {
        const start = entered.pop();
        if (start !== undefined) {
          maxSegmentMs = Math.max(maxSegmentMs, performance.now() - start);
        }
      },
    });
    hook.enable();
    const main = process.threadCpuUsage();
    const cpu = process.cpuUsage();
    const allocated = getHeapStatistics().total_allocated_bytes;
    const started = performance.now();
    const result = await read({ ...options, cursor });
    const wallMs = performance.now() - started;
    const mainUsed = process.threadCpuUsage(main);
    const used = process.cpuUsage(cpu);
    hook.disable();
    cursor = result.cursor;
    process.send?.({
      pid: process.pid,
      wallMs,
      maxSegmentMs,
      mainCpuMs: (mainUsed.user + mainUsed.system) / 1000,
      processCpuMs: (used.user + used.system) / 1000,
      mainAllocatedBytes: getHeapStatistics().total_allocated_bytes - allocated,
      rssBytes: process.memoryUsage().rss,
      lines: result.lines.length,
      cursor,
      size: result.size,
      hash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    });
  };
  process.on("message", (command: string) => {
    void handleCommand(command);
  });
  process.send?.("ready");
} else {
  await fs.mkdir(root);
  const fields = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `field${index}`,
      `request https://example.test/api?token=synthetic-${index}-abcdefghijklmnop value ${index}`,
    ]),
  );
  const line =
    JSON.stringify({
      time: "2026-11-12T00:00:00Z",
      level: "info",
      message: "synthetic request completed",
      credential: "synthetic-exact-credential-123456789",
      ...fields,
    }) + "\n";
  const chunk = line.repeat(100);
  const handle = await fs.open(file, "wx");
  for (let index = 0; index < Math.ceil(320_000_000 / Buffer.byteLength(chunk)); index++) {
    await handle.write(chunk);
  }
  await handle.close();
  const actors = await Promise.all(
    ["control-a", "control-b", "baseline", "candidate"].map(async (name) => {
      const child = fork(
        fileURLToPath(import.meta.url),
        [root, "actor", name === "candidate" ? "worker" : "direct"],
        {
          execArgv: [
            ...process.execArgv.filter((argument) => argument.startsWith("--cpu-prof")),
            "--expose-gc",
            "--import",
            path.resolve("scripts/tsx.mjs"),
          ],
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        },
      );
      const exited = new Promise<void>((resolve, reject) => {
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)),
        );
      });
      const next = () =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          child.once("message", (value) => resolve(value as Record<string, unknown>));
          child.once("error", reject);
        });
      await next();
      return {
        name,
        child,
        exited,
        run: async () => {
          const result = next();
          child.send("read");
          return result;
        },
      };
    }),
  );
  console.log(
    JSON.stringify({
      node: process.version,
      load: loadavg(),
      fileBytes: (await fs.stat(file)).size,
      lineBytes: Buffer.byteLength(line),
      options,
    }),
  );
  try {
    for (let round = 0; round < 9; round++) {
      if (round > 0) {
        await fs.appendFile(
          file,
          line.repeat(Math.floor(options.maxBytes / Buffer.byteLength(line))),
        );
        await delay(2000);
      }
      const order = round % 2 === 0 ? actors : actors.toReversed();
      const results = [];
      for (const actor of order) {
        const result = await actor.run();
        results.push(result);
        console.log(
          JSON.stringify({
            phase: round === 0 ? "cold" : round <= 3 ? "warmup" : "warm",
            round,
            arm: actor.name,
            load: loadavg()[0],
            ...result,
          }),
        );
      }
      assert.equal(
        new Set(results.map((result) => result.hash)).size,
        1,
        "all arms must return identical bytes",
      );
    }
  } finally {
    for (const actor of actors) {
      actor.child.send("stop");
    }
    await Promise.all(actors.map((actor) => actor.exited));
    await fs.rm(root, { recursive: true });
  }
}
