import { fork } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// Task proof only. Run from an installation of @openclaw/fs-safe@0.24.1,
// or supply --root-module and --watch-module with their file URLs.
const errorInfo = (error) => ({
  name: error?.name ?? "Error",
  ...(error?.code ? { code: String(error.code) } : {}),
});
const round = (value) => Math.round(value * 1000) / 1000;
const self = fileURLToPath(import.meta.url);

if (process.argv[2] === "--writer") {
  const directory = process.argv[3];
  const send = (value) => process.send?.(value);
  let working = false;
  process.on("message", async (message) => {
    if (working) {
      return;
    }
    working = true;
    try {
      let writes = 0;
      if (message.action === "append") {
        const began = performance.now();
        const file = path.join(
          directory,
          "sessions",
          "2026",
          "10",
          "06",
          "rollout-synthetic.jsonl",
        );
        while (performance.now() - began < message.durationMs) {
          await fs.appendFile(file, JSON.stringify({ sequence: writes, synthetic: true }) + "\n");
          writes++;
          await delay(Math.max(1, began + writes * 50 - performance.now()));
        }
      } else if (message.action === "burst") {
        const files = Array.from({ length: 1000 }, (_, index) => index);
        // Bounded concurrency keeps this a burst without exhausting Windows handles.
        for (let start = 0; start < files.length; start += 16) {
          await Promise.all(
            files
              .slice(start, start + 16)
              .map((index) =>
                fs.writeFile(
                  path.join(directory, "sessions", "2026", "10", "06", `burst-${index}.jsonl`),
                  '{"synthetic":true}\n',
                ),
              ),
          );
          writes += Math.min(16, files.length - start);
        }
      } else if (message.action === "selected") {
        await fs.writeFile(
          path.join(directory, "config.toml"),
          `model = "synthetic-${message.sequence}"\n`,
        );
        writes = 1;
      } else {
        throw new Error("unknown writer command");
      }
      send({ id: message.id, ok: true, writes });
    } catch (error) {
      send({ id: message.id, ok: false, error: errorInfo(error) });
    } finally {
      working = false;
    }
  });
  process.on("disconnect", () => process.exit(0));
  send({ ready: true });
} else {
  const args = process.argv.slice(2);
  const argument = (name) => {
    const index = args.indexOf(name);
    if (index < 0) {
      return undefined;
    }
    if (!args[index + 1]) {
      throw new Error("missing argument value");
    }
    return args[index + 1];
  };
  const moduleUrl = (value) =>
    value.startsWith("file:") ? value : pathToFileURL(path.resolve(value)).href;
  const report = {
    probe: "fs-safe-codex-unrelated-churn",
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    expectedFsSafeVersion: "0.24.1",
    phases: [],
    errors: [],
    scopes: [
      { path: "config.toml", kind: "entry" },
      { path: "models_cache.json", kind: "entry" },
      { path: "skills", kind: "tree", depth: 8 },
    ],
    options: { mode: "events", persistent: false, intervalMs: 30_000, maxPendingPaths: 256 },
    workload: { quietMs: 30_000, unrelatedMs: 60_000, writesPerSecond: 20, burstFiles: 1000 },
  };
  let directory,
    owner,
    writer,
    sampleTimer,
    phase,
    stage = "resolve-modules";
  let nextId = 0,
    sequence = 0,
    timedOut = false;
  const waiting = new Map();
  const timeout = setTimeout(() => {
    timedOut = true;
    writer?.kill();
  }, 140_000);
  const requireCwd = createRequire(path.join(process.cwd(), "package.json"));
  const summaries = () => ({
    invalidations: 0,
    reasons: { event: 0, reconcile: 0, overflow: 0 },
    undetailed: 0,
    changeCount: 0,
    details: {},
    samples: [],
    healthTransitions: {},
    healthFailures: [],
    peakRssBytes: process.memoryUsage().rss,
  });
  const inactive = summaries();
  let counters = inactive;
  const recordHealth = (value) => {
    counters.healthTransitions[value.state] = (counters.healthTransitions[value.state] ?? 0) + 1;
    counters.lastHealth = { state: value.state, mode: value.mode, directories: value.directories };
    if (value.failure && counters.healthFailures.length < 10) {
      counters.healthFailures.push({
        operation: value.failure.operation,
        code: value.failure.code,
        error: errorInfo(value.failure.error),
      });
    }
  };
  const command = (action) =>
    new Promise((resolve, reject) => {
      if (!writer?.connected || timedOut) {
        reject(new Error("writer unavailable"));
        return;
      }
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      writer.send({ id, ...action }, (error) => {
        if (!error) {
          return;
        }
        waiting.delete(id);
        reject(error instanceof Error ? error : new Error("writer send failed", { cause: error }));
      });
    });
  const runPhase = async (name, run) => {
    stage = name;
    counters = summaries();
    phase = counters;
    const began = performance.now(),
      cpu = process.cpuUsage(),
      elu = performance.eventLoopUtilization();
    sampleTimer = setInterval(() => {
      phase.peakRssBytes = Math.max(phase.peakRssBytes, process.memoryUsage().rss);
    }, 100);
    try {
      Object.assign(counters, await run());
    } finally {
      clearInterval(sampleTimer);
      sampleTimer = undefined;
      const elapsedMs = performance.now() - began,
        used = process.cpuUsage(cpu);
      const utilization = performance.eventLoopUtilization(elu);
      counters.peakRssBytes = Math.max(counters.peakRssBytes, process.memoryUsage().rss);
      report.phases.push({
        name,
        elapsedMs: round(elapsedMs),
        cpuUserMs: round(used.user / 1000),
        cpuSystemMs: round(used.system / 1000),
        averageCpuCores: round((used.user + used.system) / (elapsedMs * 1000)),
        eventLoopUtilization: round(utilization.utilization),
        eventLoopActiveMs: round(utilization.active),
        eventLoopIdleMs: round(utilization.idle),
        rssEndBytes: process.memoryUsage().rss,
        ...counters,
      });
      counters = inactive;
      phase = undefined;
    }
  };
  try {
    const explicitRoot = argument("--root-module"),
      explicitWatch = argument("--watch-module");
    if (Boolean(explicitRoot) !== Boolean(explicitWatch)) {
      throw new Error("both module URLs are required");
    }
    const rootUrl = explicitRoot
      ? moduleUrl(explicitRoot)
      : pathToFileURL(requireCwd.resolve("@openclaw/fs-safe/root")).href;
    const watchUrl = explicitWatch
      ? moduleUrl(explicitWatch)
      : pathToFileURL(requireCwd.resolve("@openclaw/fs-safe/watch")).href;
    report.moduleResolution = explicitRoot ? "explicit-modules" : "cwd";
    const packageRequire = createRequire(rootUrl);
    report.fsSafeVersion = packageRequire("@openclaw/fs-safe/package.json").version;
    if (report.fsSafeVersion !== report.expectedFsSafeVersion) {
      throw new Error("unexpected package version");
    }
    const [{ root }, { watch }] = await Promise.all([import(rootUrl), import(watchUrl)]);
    stage = "fixture";
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-churn-")));
    await fs.mkdir(path.join(directory, "sessions", "2026", "10", "06"), { recursive: true });
    await fs.writeFile(path.join(directory, "config.toml"), 'model = "synthetic-initial"\n');
    await fs.writeFile(path.join(directory, "models_cache.json"), '{"models":[]}\n');
    await fs.writeFile(
      path.join(directory, "sessions", "2026", "10", "06", "rollout-synthetic.jsonl"),
      "",
    );
    stage = "writer-start";
    writer = fork(self, ["--writer", directory], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const writerReady = new Promise((resolve, reject) => {
      writer.on("message", (message) => {
        if (message.ready) {
          resolve();
          return;
        }
        const request = waiting.get(message.id);
        if (!request) {
          return;
        }
        waiting.delete(message.id);
        if (message.ok) {
          request.resolve({ writes: message.writes });
        } else {
          request.reject(Object.assign(new Error("writer operation failed"), message.error));
        }
      });
      writer.on("error", reject);
      writer.on("exit", () => {
        const failure = new Error(timedOut ? "probe deadline" : "writer exited");
        reject(failure);
        for (const request of waiting.values()) {
          request.reject(failure);
        }
        waiting.clear();
      });
    });
    await writerReady;
    stage = "watch-start";
    owner = watch(await root(directory), {
      ...report.options,
      scopes: report.scopes,
      onHealth: recordHealth,
      onInvalidate(value) {
        counters.invalidations++;
        counters.reasons[value.reason]++;
        if (!value.changes) {
          counters.undetailed++;
        }
        const changes = value.changes?.map((change) => ({
          path: change.path.split(path.sep).join("/"),
          type: change.type,
        }));
        for (const change of changes ?? []) {
          counters.changeCount++;
          const key = `${change.type}:${change.path}`;
          if (Object.hasOwn(counters.details, key) || Object.keys(counters.details).length < 64) {
            counters.details[key] = (counters.details[key] ?? 0) + 1;
          }
        }
        if (counters.samples.length < 10) {
          counters.samples.push({
            reason: value.reason,
            ...(changes ? { changes: changes.slice(0, 16) } : {}),
          });
        }
      },
    });
    await owner.ready;
    if (owner.health().mode !== "events") {
      throw new Error("native event transport required");
    }
    stage = "warmup";
    await command({ action: "selected", sequence: ++sequence });
    await delay(3000);
    await owner.reconcile();
    await delay(1000);
    report.warmup = inactive;
    await runPhase("quiet", async () => {
      await delay(report.workload.quietMs);
      return { writes: 0 };
    });
    await runPhase("unrelated-append", async () => {
      const result = await command({ action: "append", durationMs: report.workload.unrelatedMs });
      await delay(2000);
      return result;
    });
    await runPhase("unrelated-burst", async () => {
      const result = await command({ action: "burst" });
      await delay(5000);
      return result;
    });
    await runPhase("selected-control", async () => {
      const began = performance.now();
      const result = await command({ action: "selected", sequence: ++sequence });
      const detected = () =>
        Object.keys(counters.details).some((key) => key.endsWith(":config.toml"));
      while (!detected() && performance.now() - began < 8000) {
        await delay(25);
      }
      const detectedAfterMs = detected() ? round(performance.now() - began) : null;
      await delay(1000);
      return { ...result, selectedDetected: detectedAfterMs !== null, detectedAfterMs };
    });
    report.finalHealth = {
      state: owner.health().state,
      mode: owner.health().mode,
      directories: owner.health().directories,
    };
    report.success =
      !timedOut &&
      report.finalHealth.state === "ready" &&
      report.phases.at(-1).selectedDetected &&
      report.phases.every((value) => value.healthFailures.length === 0);
    report.unrelatedInvalidations = report.phases
      .filter((value) => value.name.startsWith("unrelated-"))
      .reduce((sum, value) => sum + value.invalidations, 0);
  } catch (error) {
    report.errors.push({ stage, ...errorInfo(error) });
    report.success = false;
  } finally {
    clearTimeout(timeout);
    clearInterval(sampleTimer);
    if (owner) {
      try {
        await owner.close();
        report.watchClosed = true;
      } catch (error) {
        report.errors.push({ stage: "watch-close", ...errorInfo(error) });
        report.success = false;
      }
    }
    if (writer && writer.exitCode === null && writer.signalCode === null) {
      const exited = new Promise((resolve) => {
        writer.once("exit", resolve);
      });
      if (writer.connected) {
        writer.disconnect();
      }
      const killTimer = setTimeout(() => writer.kill(), 1000);
      await exited;
      clearTimeout(killTimer);
    }
    if (directory) {
      try {
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        report.fixtureRemoved = true;
      } catch (error) {
        report.errors.push({ stage: "fixture-cleanup", ...errorInfo(error) });
        report.success = false;
      }
    }
    report.timedOut = timedOut;
    console.log(JSON.stringify(report));
    if (!report.success) {
      process.exitCode = 1;
    }
  }
}
