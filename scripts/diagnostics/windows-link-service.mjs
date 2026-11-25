// CI-only synthetic diagnostic. No product modules, arbitrary paths, or retries.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { on } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const filename = fileURLToPath(import.meta.url);
const SOURCE_COUNT = 64;
const WORKERS = 4;
const SAMPLE_COUNT = 10;
const ADMISSION_MS = 30_000;
const LIFETIME_MS = 60_000;
const now = () => process.hrtime.bigint();
const ms = (ns) => Number(ns) / 1e6;
const codeOf = (error) => {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,48}$/.test(code) ? code : "DIAGNOSTIC_FAILURE";
};
const identity = (stat) => String(stat.dev) + ":" + String(stat.ino);

async function workerMain() {
  const closed = new Int32Array(workerData.closed);
  // Keep message handling in the awaited worker entry point so async failures
  // become Worker errors and reject the parent's pending work before exit.
  const messages = on(parentPort, "message");
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no Window target origin.
  parentPort.postMessage({ type: "ready" });
  for await (const [message] of messages) {
    if (message.type === "stop") {
      parentPort.close();
      return;
    }
    const durations = [];
    try {
      const deadline = BigInt(message.deadline);
      for (const file of workerData.files) {
        // Shared failure closure works even when a sibling is in synchronous I/O.
        if (Atomics.load(closed, 0) || now() >= deadline) {
          throw Object.assign(new Error(), { code: "ADMISSION_CLOSED" });
        }
        const destination = file.destinations[message.sample];
        const start = now();
        if (message.arm === "async") {
          await fs.link(file.source, destination);
        } else {
          fsSync.linkSync(file.source, destination);
        }
        durations.push(ms(now() - start));
      }
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no Window target origin.
      parentPort.postMessage({ type: "sample", durations });
    } catch (error) {
      Atomics.store(closed, 0, 1);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no Window target origin.
      parentPort.postMessage({ type: "failure", code: codeOf(error) });
    }
  }
}

function startWorker(files, closed) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { files, closed } });
  let pending;
  let exited = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const exit = new Promise((resolve) => {
    worker.once("exit", (code) => {
      exited = true;
      Atomics.store(new Int32Array(closed), 0, 1);
      const error = Object.assign(new Error(), { code: "WORKER_EXIT" });
      readyReject(error);
      pending?.reject(error);
      pending = undefined;
      resolve(code);
    });
  });
  worker.on("error", () => {
    Atomics.store(new Int32Array(closed), 0, 1);
    const error = Object.assign(new Error(), { code: "WORKER_ERROR" });
    readyReject(error);
    pending?.reject(error);
    pending = undefined;
  });
  worker.on("message", (message) => {
    if (message.type === "ready") {
      readyResolve();
    } else if (pending) {
      const current = pending;
      pending = undefined;
      if (message.type === "sample") {
        current.resolve(message.durations);
      } else {
        current.reject(Object.assign(new Error(), { code: message.code }));
      }
    }
  });
  return {
    ready,
    exit,
    run(message) {
      assert(!exited && !pending);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node Worker has no Window target origin.
        worker.postMessage(message);
      });
    },
    stop() {
      if (!exited) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node Worker has no Window target origin.
        worker.postMessage({ type: "stop" });
      }
    },
  };
}

function send(record) {
  return new Promise((resolve, reject) => {
    process.send(record, (error) => (error ? reject(error) : resolve()));
  });
}

async function childMain() {
  const closed = new SharedArrayBuffer(4);
  const workers = [];
  let root;
  let failure;
  let samples = 0;
  let validated = 0;
  let cleaned = false;
  try {
    assert.equal(process.platform, "win32");
    assert.equal(process.version, "v24.22.1");
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-link-service-"));
    const sourceDir = path.join(root, "sources");
    await fs.mkdir(sourceDir);
    const destinationDirs = [];
    for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
      const directory = path.join(root, "destination-" + sample);
      await fs.mkdir(directory);
      destinationDirs.push(directory);
    }
    const directories = [root, sourceDir, ...destinationDirs];
    const directoryStats = await Promise.all(
      directories.map((directory) => fs.lstat(directory, { bigint: true })),
    );
    for (const stat of directoryStats) {
      assert(stat.isDirectory() && stat.ino !== 0n);
      assert.equal(stat.dev, directoryStats[0].dev);
    }
    const files = [];
    const initial = [];
    for (let index = 0; index < SOURCE_COUNT; index++) {
      const source = path.join(sourceDir, "synthetic-" + index + ".js");
      await fs.writeFile(source, Buffer.alloc(16 * 1024, 97 + (index % 26)), { flag: "wx" });
      const stat = await fs.lstat(source, { bigint: true });
      assert(stat.isFile() && stat.ino !== 0n && stat.nlink === 1n);
      assert.equal(stat.dev, directoryStats[0].dev);
      initial.push(stat);
      files.push({
        source,
        destinations: destinationDirs.map((directory) =>
          path.join(directory, "synthetic-" + index + ".js"),
        ),
      });
    }
    assert.equal(new Set(initial.map(identity)).size, SOURCE_COUNT);
    for (let index = 0; index < WORKERS; index++) {
      workers.push(startWorker(files.slice(index * 16, (index + 1) * 16), closed));
    }
    await Promise.all(workers.map((worker) => worker.ready));
    const deadline = now() + BigInt(ADMISSION_MS) * 1_000_000n;
    const pool = process.env.UV_THREADPOOL_SIZE;
    const sourceLengths = files.map((file) => file.source.length);
    const destinationLengths = files.flatMap((file) =>
      file.destinations.map((name) => name.length),
    );
    await send({
      type: "header",
      node: process.version,
      uv: process.versions.uv,
      architecture: process.arch,
      osRelease: os.release(),
      availableParallelism: os.availableParallelism(),
      nodeOptionsPresent: process.env.NODE_OPTIONS !== undefined,
      execArgvPresent: process.execArgv.length > 0,
      threadpoolSizePresent: pool !== undefined,
      threadpoolSize:
        /^[1-9][0-9]{0,3}$/.test(pool ?? "") && Number(pool) <= 1024 ? Number(pool) : null,
      sourcePathLengthMin: Math.min(...sourceLengths),
      sourcePathLengthMax: Math.max(...sourceLengths),
      destinationPathLengthMin: Math.min(...destinationLengths),
      destinationPathLengthMax: Math.max(...destinationLengths),
      sameVolume: true,
      sources: SOURCE_COUNT,
      workers: WORKERS,
      sampleLimit: SAMPLE_COUNT,
      effectLimit: 640,
      admissionMs: ADMISSION_MS,
      lifetimeMs: LIFETIME_MS,
      harnessSha256: createHash("sha256")
        .update(await fs.readFile(filename))
        .digest("hex"),
      scope: "synthetic-only; not release proof; inherited options are potential confounders",
    });
    for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
      assert(!Atomics.load(new Int32Array(closed), 0) && now() < deadline);
      // Revalidate admitted parents/sources outside each measured window.
      for (let index = 0; index < directories.length; index++) {
        const stat = await fs.lstat(directories[index], { bigint: true });
        assert(stat.isDirectory());
        assert.equal(identity(stat), identity(directoryStats[index]));
      }
      for (let index = 0; index < files.length; index++) {
        const stat = await fs.lstat(files[index].source, { bigint: true });
        assert(stat.isFile());
        assert.equal(identity(stat), identity(initial[index]));
        assert.equal(stat.size, initial[index].size);
        assert.equal(stat.nlink, BigInt(sample + 1));
      }
      const pair = Math.floor(sample / 2);
      const arm = sample % 2 === pair % 2 ? "async" : "sync";
      const cpu = process.cpuUsage();
      const start = now();
      const results = await Promise.allSettled(
        workers.map((worker) =>
          worker.run({
            type: "run",
            arm,
            sample,
            deadline: String(deadline),
          }),
        ),
      );
      const elapsedMs = ms(now() - start);
      const cpuDelta = process.cpuUsage(cpu);
      const failed = results.find((result) => result.status === "rejected");
      if (failed) {
        throw failed.reason;
      }
      const workerIntervals = results.map((result) => result.value);
      const durations = workerIntervals.flat().toSorted((a, b) => a - b);
      assert.equal(durations.length, SOURCE_COUNT);
      for (let index = 0; index < files.length; index++) {
        const source = await fs.lstat(files[index].source, { bigint: true });
        const destination = await fs.lstat(files[index].destinations[sample], { bigint: true });
        for (const stat of [source, destination]) {
          assert(stat.isFile());
          assert.equal(identity(stat), identity(initial[index]));
          assert.equal(stat.size, initial[index].size);
          assert.equal(stat.nlink, BigInt(sample + 2));
        }
      }
      const total = durations.reduce((sum, value) => sum + value, 0);
      samples++;
      validated += SOURCE_COUNT;
      await send({
        type: "sample",
        pair: pair + 1,
        position: (sample % 2) + 1,
        arm,
        initialTransitionalPair: pair === 0,
        completed: durations.length,
        elapsedMs,
        intervalTotalMs: total,
        intervalMeanMs: total / SOURCE_COUNT,
        intervalMedianMs: (durations[31] + durations[32]) / 2,
        intervalP95Ms: durations[60],
        intervalMaxMs: durations[63],
        workerIntervalTotalsMs: workerIntervals.map((values) =>
          values.reduce((sum, value) => sum + value, 0),
        ),
        cpuUserMicros: cpuDelta.user,
        cpuSystemMicros: cpuDelta.system,
        identitiesValid: true,
      });
    }
  } catch (error) {
    failure = codeOf(error);
  } finally {
    Atomics.store(new Int32Array(closed), 0, 1);
    // Sample allSettled above drains accepted work before these stop messages.
    for (const worker of workers) {
      worker.stop();
    }
    const exits = await Promise.all(workers.map((worker) => worker.exit));
    const joined = workers.length === WORKERS && exits.every((code) => code === 0);
    if (!joined) {
      failure ??= "WORKER_SETTLEMENT_FAILED";
    }
    try {
      if (root) {
        await fs.rm(root, { recursive: true, force: false, maxRetries: 0 });
      }
      cleaned = true;
    } catch (error) {
      failure ??= codeOf(error);
    }
    await send({
      type: "result",
      success: !failure && samples === SAMPLE_COUNT && validated === 640 && joined && cleaned,
      failure: failure ?? null,
      samples,
      validated,
      workersJoined: joined,
      cleaned,
    });
    process.exitCode = failure ? 1 : 0;
    process.disconnect();
  }
}

async function supervise() {
  let count = 0;
  let result;
  let timedOut = false;
  let spawnFailure = false;
  let header = false;
  const emit = (record) => {
    if (count < 12) {
      process.stdout.write(JSON.stringify(record) + "\n");
      count++;
    }
  };
  // The child only creates Worker threads, never subprocesses. Terminating this
  // one process terminates its workers; close (not kill's return) is settlement.
  const start = now();
  const child = spawn(process.execPath, [filename, "--child"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  let killGrace;
  const uncertainty = () => {
    emit({
      type: "result",
      success: false,
      failure: "TERMINATION_UNVERIFIED",
      timedOut,
      processSettled: false,
      cleanupVerified: false,
      retainOwnedFixture: true,
    });
    process.exit(1);
  };
  const watchdog = setTimeout(
    () => {
      timedOut = true;
      // A fixed settlement-observation allowance does not admit more child work.
      killGrace = setTimeout(uncertainty, 5_000);
      child.kill("SIGKILL");
    },
    Math.max(0, LIFETIME_MS - ms(now() - start)),
  );
  child.on("error", () => {
    spawnFailure = true;
  });
  child.on("message", (message) => {
    if (message.type === "result") {
      result = message;
    } else if (message.type === "header" && !header && count === 0) {
      header = true;
      // spawn inherits NODE_OPTIONS, not the supervisor's command-line flags.
      emit({ ...message, supervisorExecArgvPresent: process.execArgv.length > 0 });
    } else if (message.type === "sample" && header && count <= SAMPLE_COUNT) {
      emit(message);
    }
  });
  const exit = await new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(watchdog);
  clearTimeout(killGrace);
  const success =
    !timedOut && !spawnFailure && exit.code === 0 && result?.success === true && count === 11;
  emit({
    type: "result",
    success,
    failure: timedOut
      ? "LIFETIME_DEADLINE"
      : spawnFailure
        ? "SPAWN_FAILED"
        : (result?.failure ?? (success ? null : "INCOMPLETE")),
    samples: result?.samples ?? 0,
    validated: result?.validated ?? 0,
    workersJoined: result?.workersJoined ?? false,
    cleanupVerified: result?.cleaned ?? false,
    processSettled: true,
    timedOut,
    elapsedMs: ms(now() - start),
    retainOwnedFixture: result?.cleaned !== true,
  });
  process.exitCode = success ? 0 : 1;
}

if (!isMainThread) {
  await workerMain();
} else if (process.argv[2] === "--child" && process.send) {
  await childMain();
} else {
  await supervise();
}
