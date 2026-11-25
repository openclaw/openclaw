import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const windowMs = 45_000;
const pairs = 5;
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => abort.abort());
}

async function command(file, args, timeout = 2_000) {
  try {
    return (
      await run(file, args, {
        timeout,
        killSignal: "SIGKILL",
        signal: abort.signal,
        maxBuffer: 512 * 1024,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
      })
    ).stdout;
  } catch {
    return null;
  }
}

async function inventory(root) {
  const totals = { files: 0, bytes: 0, directories: 0, symlinks: 0 };
  const pending = [root];
  const deadline = performance.now() + 30_000;
  while (pending.length) {
    const directory = pending.pop();
    totals.directories += 1;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      abort.signal.throwIfAborted();
      if (
        performance.now() > deadline ||
        totals.files + totals.directories + totals.symlinks > 250_000
      ) {
        throw new Error("Payload inventory exceeded its bound.");
      }
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(file);
      } else if (entry.isSymbolicLink()) {
        totals.symlinks += 1;
      } else if (entry.isFile()) {
        totals.files += 1;
        totals.bytes += (await lstat(file)).size;
      } else {
        throw new Error("Unsupported payload entry.");
      }
    }
  }
  return totals;
}

async function spotlight() {
  const output = await command("/bin/ps", ["-axo", "pid=,time=,comm="]);
  if (output === null) {
    return null;
  }
  const processes = new Map();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+([\d:.-]+)\s+(.+)$/u.exec(line);
    if (!match || !/^\/(?:System\/Library|usr\/libexec)\//u.test(match[3])) {
      continue;
    }
    const role = path.basename(match[3].trim());
    if (
      !/^(?:mds|mds_stores|mdworker|mdworker_shared|CoreSpotlightService|spotlightknowledged(?:\.updater)?)$/u.test(
        role,
      )
    ) {
      continue;
    }
    const [days, clock] = match[2].includes("-") ? match[2].split("-") : ["0", match[2]];
    const cpuMs =
      (Number(days) * 86_400 + clock.split(":").reduce((sum, n) => sum * 60 + Number(n), 0)) *
      1_000;
    processes.set(Number(match[1]), { role, cpuMs });
  }
  return { processes, at: performance.now() };
}

function spotlightDelta(start, end) {
  if (!start || !end) {
    return null;
  }
  let cpuDeltaMs = 0,
    matched = 0;
  for (const [pid, process] of end.processes) {
    const before = start.processes.get(pid);
    if (before?.role === process.role && process.cpuMs >= before.cpuMs) {
      matched += 1;
      cpuDeltaMs += process.cpuMs - before.cpuMs;
    }
  }
  return {
    cpuDeltaMs: Math.round(cpuDeltaMs),
    intervalMs: Math.round(end.at - start.at),
    matchedProcesses: matched,
    unmatchedAtStart: start.processes.size - matched,
    unmatchedAtEnd: end.processes.size - matched,
  };
}

async function indexedCount(root, query) {
  const output = await command("/usr/bin/mdfind", ["-count", "-onlyin", root, query]);
  return output !== null && /^\d+\s*$/u.test(output) ? Number(output) : null;
}

async function main() {
  const [sourceOption, input, outputOption, output, ...extra] = process.argv.slice(2);
  if (
    sourceOption !== "--source" ||
    !input ||
    outputOption !== "--output" ||
    !output ||
    extra.length
  ) {
    process.stderr.write(
      "Usage: node scripts/ios-spotlight-probe.mjs --source SNAPSHOT_DERIVED_DATA --output PATH\n",
    );
    process.exitCode = 2;
    return;
  }
  const report = {
    schemaVersion: 1,
    status: "running",
    reason: null,
    startedAt: new Date().toISOString(),
    pairs,
    windowMs,
    cpuCount: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
    payload: null,
    samples: [],
    limits: [
      "fresh-directory-index-state-with-warm-host-caches",
      "clone-preferred-copy-not-compilation",
      "matched-host-spotlight-processes-only-not-per-directory-cpu",
      "asynchronous-indexing-can-carry-over-between-samples",
      "fixed-window-may-end-before-indexing-completes",
    ],
  };
  let root,
    stage = "preflight";
  const save = () => writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  try {
    await mkdir(path.dirname(output), { recursive: true });
    if (
      process.platform !== "darwin" ||
      process.env.GITHUB_ACTIONS !== "true" ||
      process.env.RUNNER_ENVIRONMENT !== "github-hosted"
    ) {
      throw new Error("Requires disposable hosted macOS.");
    }
    stage = "payload-inventory";
    const source = await realpath(input);
    report.payload = await inventory(source);
    const free = await statfs(path.dirname(source));
    if (!report.payload.files || free.bavail * free.bsize < report.payload.bytes + 1024 ** 3) {
      throw new Error("Missing payload or insufficient copy space.");
    }
    // Temporary directories may already be excluded; use a sibling of the real build output.
    root = await mkdtemp(path.join(path.dirname(source), "openclaw-spotlight-probe-"));
    await save();
    for (let pair = 1; pair <= pairs; pair += 1) {
      for (const arm of ["normal", "noindex"]) {
        abort.signal.throwIfAborted();
        const directory = path.join(root, `${pair}-${arm}${arm === "noindex" ? ".noindex" : ""}`);
        const destination = path.join(directory, "payload");
        await mkdir(directory);
        const start = await spotlight();
        const hostStart = { load: os.loadavg(), freeMemoryBytes: os.freemem() };
        const started = performance.now();
        stage = "copy";
        await writeFile(
          path.join(directory, "spotlight-probe.txt"),
          "OpenClawSpotlightProbeSentinel\n",
        );
        if ((await command("/bin/cp", ["-cRP", source, destination], windowMs)) === null) {
          throw new Error("Copy failed or timed out.");
        }
        const copyMs = Math.round(performance.now() - started);
        await delay(Math.max(0, started + windowMs - performance.now()), undefined, {
          signal: abort.signal,
        });
        const end = await spotlight();
        const hostEnd = { load: os.loadavg(), freeMemoryBytes: os.freemem() };
        const indexedEntries = await indexedCount(destination, 'kMDItemFSName == "*"');
        const indexedSentinels = await indexedCount(
          directory,
          'kMDItemTextContent == "OpenClawSpotlightProbeSentinel"',
        );
        stage = "copy-verification";
        const copied = await inventory(destination);
        if (Object.keys(report.payload).some((key) => copied[key] !== report.payload[key])) {
          throw new Error("Copy inventory differs from the original.");
        }
        report.samples.push({
          pair,
          arm,
          copyMs,
          copied,
          indexedEntries,
          indexedSentinels,
          spotlight: spotlightDelta(start, end),
          hostStart,
          hostEnd,
        });
        await save();
        stage = "cleanup";
        await rm(directory, { recursive: true });
      }
    }
    report.summary = Object.fromEntries(
      ["normal", "noindex"].map((arm) => {
        const samples = report.samples.filter((sample) => sample.arm === arm);
        return [
          arm,
          {
            positiveControls: samples.filter(
              (sample) => sample.indexedSentinels > 0 && sample.indexedEntries > 0,
            ).length,
            indexedEntries: samples.map((sample) => sample.indexedEntries),
            spotlightCpuDeltaMs: samples.map((sample) => sample.spotlight?.cpuDeltaMs ?? null),
          },
        ];
      }),
    );
    const missing = report.samples.some(
      (sample) =>
        sample.indexedEntries === null ||
        sample.indexedSentinels === null ||
        sample.spotlight === null,
    );
    const excluded = report.samples
      .filter((sample) => sample.arm === "noindex")
      .every((sample) => sample.indexedEntries === 0 && sample.indexedSentinels === 0);
    report.reason = missing
      ? "observation-unavailable"
      : report.summary.normal.positiveControls !== pairs
        ? "normal-positive-control-missing"
        : !excluded
          ? "noindex-exclusion-not-observed"
          : null;
    report.status = report.reason ? "inconclusive" : "completed";
  } catch {
    // Never export native errors: they can include payload paths and filenames.
    report.status = "failed";
    report.reason = abort.signal.aborted ? "interrupted" : stage;
    process.exitCode = 1;
  } finally {
    if (root) {
      try {
        await rm(root, { recursive: true });
      } catch {
        report.status = "failed";
        report.reason = "cleanup";
        process.exitCode = 1;
      }
    }
    report.finishedAt = new Date().toISOString();
    try {
      await save();
    } catch {
      process.stderr.write("[ios-spotlight-probe] Unable to save diagnostic artifact.\n");
      process.exitCode = 1;
    }
  }
}

await main();
