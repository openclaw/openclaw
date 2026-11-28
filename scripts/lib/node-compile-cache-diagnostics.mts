import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  sha256,
  withTerminalManifest,
  writeJsonAtomic,
} from "./vitest-pair-benchmark-contract.mts";
import {
  readNodeCacheSeed,
  restoreNodeCacheSeed,
  runOwnedCommand,
} from "./vitest-pair-benchmark.mts";

// Pinned Node v24.22.1: src/compile_cache.cc:108-226,318-338 and
// src/module_wrap.cc:517-555. A read alone does not establish V8 acceptance.
export function parseNodeCacheDiagnostic(log: string, sourceUrl: string, cacheRoot: string) {
  if (log && !log.endsWith("\n")) {
    throw new Error("Incomplete or interleaved native cache diagnostic for the required source");
  }
  const header = String.raw`\[\d+ \d+ \d+ \d+ \d+\]\.\.\.`;
  const mismatch = String.raw`(?:code size|code hash|cache size|cache hash|magic number) mismatch: expected \d+, actual \d+`;
  const readPattern = new RegExp(
    String.raw`^\[compile cache\] reading cache from (.+) for (\S+) (.+)\.\.\.( no such file or directory|${header}(?: success, size=[1-9]\d*|${mismatch}))$`,
    "u",
  );
  const statePattern =
    /^\[compile cache\] V8 code cache for (\S+) (.+) was (accepted|not initialized|rejected), (keeping|initializing|refreshing) the in-memory entry$/u;
  const reads: Array<{ line: number; file: string; result: string }> = [];
  const states: Array<{ line: number; state: string; action: string }> = [];
  for (const [index, line] of log.split("\n").entries()) {
    if (
      !line.includes("[compile cache] reading cache from") &&
      !line.includes("[compile cache] V8 code cache for")
    ) {
      continue;
    }
    const read = readPattern.exec(line);
    const state = statePattern.exec(line);
    // Check record framing before source selection. A split/truncated source URL
    // must not disappear behind the filter and leave an earlier acceptance valid.
    if (!read && !state) {
      throw new Error("Incomplete or interleaved native cache diagnostic for the required source");
    }
    const type = read?.[2] ?? state?.[1];
    const recordSource = read?.[3] ?? state?.[2];
    if (recordSource !== sourceUrl) {
      continue;
    }
    if (type !== "ESM") {
      throw new Error("Incomplete or interleaved native cache diagnostic for the required source");
    }
    if (read) {
      reads.push({ line: index, file: read[1]!, result: read[4]!.trim() });
    } else if (state) {
      states.push({ line: index, state: state[3]!, action: state[4]! });
    }
  }
  if (reads.length === 0 && states.length === 0) {
    return null;
  }
  if (reads.length !== 1 || states.length !== 1 || reads[0]!.line >= states[0]!.line) {
    throw new Error("Expected one ordered native cache read and V8 result for the required source");
  }
  const read = reads[0]!;
  const state = states[0]!;
  const relative = path.relative(cacheRoot, read.file);
  if (
    !path.isAbsolute(read.file) ||
    path.normalize(read.file) !== read.file ||
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Native cache read escapes the selected cache directory");
  }
  const hit = read.result.includes(" success, size=");
  const missing = read.result === "no such file or directory";
  if (
    (state.state === "accepted" && (!hit || state.action !== "keeping")) ||
    (state.state === "not initialized" && (hit || state.action !== "initializing")) ||
    (state.state === "rejected" && (!hit || state.action !== "refreshing"))
  ) {
    throw new Error("Native cache read and V8 result disagree");
  }
  return {
    sourceUrl,
    cacheFile: relative.split(path.sep).join("/"),
    read: hit ? "hit" : missing ? "missing" : "invalid",
    state: state.state,
  };
}

export async function qualifyNodeCacheDiagnostics(outputDir: string) {
  if (process.platform !== "linux" || process.version !== "v24.22.1" || process.versions.bun) {
    throw new Error("Native cache qualification requires Linux Node v24.22.1");
  }
  const output = path.resolve(outputDir);
  if (realpathSync(path.dirname(output)) !== path.dirname(output)) {
    throw new Error("Qualification output must have a physical parent");
  }
  mkdirSync(output, { mode: 0o700 });
  return withTerminalManifest(output, async () => {
    const scratch = path.join(output, "scratch");
    const active = path.join(scratch, "active");
    const seed = path.join(scratch, "seed");
    const entry = path.join(scratch, "entry.mjs");
    mkdirSync(scratch);
    const source = 'console.log("native-cache-fixture-passed");\n';
    writeFileSync(entry, source);
    const sourceUrl = pathToFileURL(entry).href;
    let settled = true;
    const controls = [];
    let seedFiles: ReturnType<typeof readNodeCacheSeed> = [];
    try {
      for (const kind of ["disabled", "empty", "seeded", "invalidated"] as const) {
        if (kind === "seeded" || kind === "invalidated") {
          restoreNodeCacheSeed(seed, active);
        } else {
          mkdirSync(active);
        }
        if (kind === "invalidated") {
          writeFileSync(entry, source + "// changed source must invalidate the seed\n");
        }
        const logPath = path.join(output, `${kind}.log`);
        settled = false;
        const result = await runOwnedCommand({
          bin: process.execPath,
          args: [entry],
          cwd: scratch,
          env: {
            PATH: process.env.PATH,
            HOME: scratch,
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            NODE_DEBUG_NATIVE: "COMPILE_CACHE",
            NODE_COMPILE_CACHE: active,
            ...(kind === "disabled" ? { NODE_DISABLE_COMPILE_CACHE: "1" } : {}),
          },
          logPath,
          timeoutMs: 10_000,
        });
        settled = true;
        const log = readFileSync(logPath, "utf8");
        if (result.exitCode !== 0 || !log.split("\n").includes("native-cache-fixture-passed")) {
          throw new Error(`${kind} fixture did not complete successfully`);
        }
        const observation = parseNodeCacheDiagnostic(log, sourceUrl, active);
        const files = readNodeCacheSeed(active);
        if (kind === "disabled") {
          const events = log.split("\n").filter((line) => line.includes("[compile cache]"));
          if (
            observation ||
            files.length ||
            events.length !== 1 ||
            events[0] !== "[compile cache] Disabled by NODE_DISABLE_COMPILE_CACHE."
          ) {
            throw new Error("Disabled control produced native cache activity");
          }
        } else {
          const expected = kind === "seeded" ? "accepted" : "not initialized";
          const expectedRead = kind === "seeded" ? "hit" : kind === "empty" ? "missing" : "invalid";
          if (
            observation?.state !== expected ||
            observation.read !== expectedRead ||
            !files.some((file) => file.path === observation.cacheFile && file.bytes > 0)
          ) {
            throw new Error(`${kind} control did not establish the expected native cache behavior`);
          }
        }
        if (kind === "empty") {
          restoreNodeCacheSeed(active, seed);
          seedFiles = readNodeCacheSeed(seed);
        }
        if (
          seedFiles.length &&
          JSON.stringify(readNodeCacheSeed(seed)) !== JSON.stringify(seedFiles)
        ) {
          throw new Error("Qualification changed its seed");
        }
        controls.push({
          kind,
          observation,
          sourceSha256: sha256(readFileSync(entry)),
          logSha256: sha256(log),
          processTreeSettled: true,
        });
        rmSync(active, { recursive: true });
      }
    } finally {
      if (settled) {
        rmSync(scratch, { recursive: true });
      }
    }
    const receipt = {
      version: 1,
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      architecture: process.arch,
      executableSha256: sha256(readFileSync(process.execPath)),
      seedFiles,
      controls,
      claim:
        "Synthetic ESM diagnostic qualification only; no workload cache acceptance or performance measurement.",
    };
    writeJsonAtomic(path.join(output, "diagnostics.json"), receipt);
    return receipt;
  });
}
