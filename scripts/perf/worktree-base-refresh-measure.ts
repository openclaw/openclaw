/**
 * Real default-base owner, local synthetic origin; no operator state or network.
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-base-refresh-measure.ts \
 *   --seed <disposable-seed> --base-file <saved-base-ref.ts> --output <new-directory>
 * Five serial AB/BA pairs, then five A/A pairs; fresh clone/process per sample.
 * Add --profile for a separate phase-scoped candidate CPU profile.
 * Acceptance: unchanged origin selects the same commit with fetches 1 -> 0,
 * lower baseRefresh wall/CPU/allocation, no >20% regression in owner metrics.
 * Add --advancing for a newer local origin HEAD: both arms must fetch once,
 * preserve the target/ancestry, and reduce ref-completeness without extra objects.
 * --base-fetch-file compares the extracted fetch owner. --registration starts a
 * real no-checkout worktree registration when the fetch reaches Git execution;
 * reports its admission wait separately, with no injected network delay.
 * Run on Node 26 for the exact V8 total_allocated_bytes counter.
 * JS allocation is exact V8 allocation; native Git CPU/RSS uses macOS time -l.
 * File copying, startup and hydration are outside baseRefresh. This is neither
 * a Gateway send benchmark nor a reproduction of production network latency.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    seed: { type: "string" },
    "base-file": { type: "string" },
    "base-fetch-file": { type: "string" },
    output: { type: "string" },
    pairs: { type: "string", default: "5" },
    arm: { type: "string" },
    profile: { type: "boolean" },
    advancing: { type: "boolean" },
    registration: { type: "boolean" },
  },
});
assert(values.seed && values.output, "--seed and --output are required");
assert(process.platform === "darwin", "Native CPU receipts require macOS time -l");
const seed = await fs.realpath(values.seed);
const output = path.resolve(values.output);
const baseline = values["base-file"] ? path.resolve(values["base-file"]) : undefined;
const baselineFetch = values["base-fetch-file"]
  ? path.resolve(values["base-fetch-file"])
  : undefined;
const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const origin = execFileSync(actualGit, ["-C", seed, "remote", "get-url", "origin"], {
  env: gitEnv,
  encoding: "utf8",
}).trim();
assert(origin.startsWith("file://"), "The fixture must use a local file:// origin");
const ownerSha256 = createHash("sha256")
  .update(
    readFileSync(baseline ?? new URL("../../src/agents/worktrees/base-ref.ts", import.meta.url)),
  )
  .update(
    readFileSync(
      baselineFetch ?? new URL("../../src/agents/worktrees/base-fetch.ts", import.meta.url),
    ),
  )
  .digest("hex");
await fs.mkdir(output);

if (!values.arm) {
  assert(baseline || baselineFetch, "A baseline owner file is required for paired comparison");
  const pairs = Number(values.pairs);
  assert(Number.isSafeInteger(pairs) && pairs >= 5);
  const rows: unknown[] = [];
  for (const control of [false, true]) {
    for (let pair = 0; pair < pairs; pair++) {
      for (const arm of pair % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"]) {
        const label = `${control ? "aa" : "ab"}-${pair}-${arm}`;
        const sampleOutput = path.join(output, label);
        const args = [
          "--import",
          "./scripts/tsx.mjs",
          fileURLToPath(import.meta.url),
          "--seed",
          seed,
          "--output",
          sampleOutput,
          "--arm",
          arm,
        ];
        if (values.advancing) {
          args.push("--advancing");
        }
        if (values.registration) {
          args.push("--registration");
        }
        if (arm === "base" || control) {
          if (baseline) {
            args.push("--base-file", baseline);
          }
          if (baselineFetch) {
            args.push("--base-fetch-file", baselineFetch);
          }
        }
        const stdout = execFileSync(process.execPath, args, {
          env: gitEnv,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        });
        await fs.writeFile(path.join(sampleOutput, "stdout.log"), stdout);
        const row = JSON.parse(await fs.readFile(path.join(sampleOutput, "result.json"), "utf8"));
        rows.push({ label, control, ...row });
        console.log(JSON.stringify(rows.at(-1)));
        await fs.writeFile(path.join(output, "results.json"), JSON.stringify(rows, null, 2));
        await fs.rm(path.join(sampleOutput, "clone"), { recursive: true });
        await fs.rm(path.join(sampleOutput, "registered"), { recursive: true, force: true });
      }
    }
  }
} else {
  const clone = path.join(output, "clone");
  await fs.cp(seed, clone, { recursive: true });
  const cached = execFileSync(actualGit, ["-C", clone, "rev-parse", "refs/remotes/origin/main"], {
    env: gitEnv,
    encoding: "utf8",
  }).trim();
  const expected = values.advancing
    ? execFileSync(actualGit, ["-C", fileURLToPath(origin), "rev-parse", "HEAD"], {
        env: gitEnv,
        encoding: "utf8",
      }).trim()
    : cached;
  if (values.advancing) {
    assert.notEqual(cached, expected, "--advancing needs an unfetched origin tip");
  }
  const metrics = path.join(output, "git-metrics");
  const bin = path.join(output, "bin");
  await fs.mkdir(metrics);
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "git"),
    `#!/bin/sh\nreceipt=${shellQuote(metrics)}/\${OPENCLAW_PERF_GIT_PHASE:-outside}-$$\n` +
      `printf '%s\\n' "$*" > "$receipt.argv"\n` +
      `if [ "$OPENCLAW_PERF_GIT_PHASE" = baseRefresh ]; then\n` +
      `  export GIT_TRACE2_PERF="$receipt.perf" GIT_TRACE_PACKET="$receipt.packet"\nfi\n` +
      `exec /usr/bin/time -l -o "$receipt.time" ${shellQuote(actualGit)} "$@"\n`,
    { mode: 0o755 },
  );
  // Keep Git's transport configuration isolated while retaining the timing shim.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    OPENCLAW_STATE_DIR: path.join(output, "state"),
    OPENCLAW_HOME: output,
    PATH: `${bin}:${process.env.PATH}`,
  });
  const phases: Record<string, { wallMs: number; cpuMs: number; allocatedBytes: number }> = {};
  let phase = "outside";
  let commandCount = 0;
  let fetches = 0;
  let advertisements = 0;
  let register: (() => void) | undefined;
  let registration: Promise<void> | undefined;
  let registrationStart = 0;
  let registrationQueueWaitMs: number | undefined;
  let registrationWallMs: number | undefined;
  const profiler = values.profile ? new Session() : undefined;
  profiler?.connect();
  if (profiler) {
    await profiler.post("Profiler.enable");
  }
  const key = Symbol.for("openclaw.perf.base-refresh");
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: {
      async measure<T>(name: string, run: () => Promise<T>): Promise<T> {
        if (name !== "baseRefresh") {
          return await run();
        }
        phase = name;
        if (profiler) {
          await profiler.post("Profiler.start");
        }
        const cpu = process.threadCpuUsage();
        const allocated = getHeapStatistics().total_allocated_bytes;
        assert(Number.isFinite(allocated), "Runtime must expose V8 allocation counters");
        const start = performance.now();
        try {
          return await run();
        } finally {
          const wallMs = performance.now() - start;
          const used = process.threadCpuUsage(cpu);
          phases[name] = {
            wallMs,
            cpuMs: (used.user + used.system) / 1000,
            allocatedBytes: getHeapStatistics().total_allocated_bytes - allocated,
          };
          phase = "outside";
          if (profiler) {
            const { profile } = await profiler.post("Profiler.stop");
            await fs.writeFile(
              path.join(output, "baseRefresh.cpuprofile"),
              JSON.stringify(profile),
            );
          }
        }
      },
      command(args: string[]) {
        if (args[0] === "worktree" && args[1] === "add") {
          registrationQueueWaitMs = performance.now() - registrationStart;
          return "registration";
        }
        if (phase === "baseRefresh") {
          commandCount++;
          fetches += Number(args[0] === "fetch");
          advertisements += Number(args[0] === "ls-remote");
          if (args[0] === "fetch") {
            register?.();
          }
        }
        return phase;
      },
    },
  });
  const hook = registerHooks({
    load(url, context, next) {
      if (url.endsWith("/src/agents/worktrees/base-ref.ts") && baseline) {
        return {
          format: "module-typescript",
          shortCircuit: true,
          source: readFileSync(baseline, "utf8"),
        };
      }
      if (url.endsWith("/src/agents/worktrees/base-fetch.ts") && baselineFetch) {
        return {
          format: "module-typescript",
          shortCircuit: true,
          source: readFileSync(baselineFetch, "utf8"),
        };
      }
      if (url.endsWith("/src/agents/worktrees/preparation-timing.ts")) {
        let source = readFileSync(new URL(url), "utf8");
        source = source.replace(
          "export async function timeWorktreePreparationPhase<T>(",
          "async function timeWorktreePreparationPhaseOriginal<T>(",
        );
        source += `\nexport async function timeWorktreePreparationPhase<T>(phase: PreparationPhase, run: () => Promise<T>): Promise<T> {
          return globalThis[Symbol.for("openclaw.perf.base-refresh")].measure(phase, () => timeWorktreePreparationPhaseOriginal(phase, run));
        }\n`;
        return { format: "module-typescript", shortCircuit: true, source };
      }
      if (url.endsWith("/src/infra/git-exec.ts")) {
        let source = readFileSync(new URL(url), "utf8");
        source = source.replace(
          "export async function executeGitCommand(",
          "async function executeGitCommandOriginal(",
        );
        source += `\nexport async function executeGitCommand(...args: Parameters<typeof executeGitCommandOriginal>) {
          const phase = globalThis[Symbol.for("openclaw.perf.base-refresh")].command(args[1]);
          args[2] = { ...args[2], env: { ...args[2]?.env, OPENCLAW_PERF_GIT_PHASE: phase } };
          return await executeGitCommandOriginal(...args);
        }\n`;
        return { format: "module-typescript", shortCircuit: true, source };
      }
      return next(url, context);
    },
  });
  const { resolveWorktreeBase } = await import("../../src/agents/worktrees/base-ref.js");
  const { requireGit } = await import("../../src/agents/worktrees/git.js");
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  const loadBefore = loadavg();
  if (values.registration) {
    register = () => {
      register = undefined;
      registrationStart = performance.now();
      registration = requireGit(
        clone,
        [
          "worktree",
          "add",
          "--no-checkout",
          "-b",
          "fixture-concurrent",
          path.join(output, "registered"),
          cached,
        ],
        { refMutationDirectory: path.join(clone, ".git") },
      ).then(() => {
        registrationWallMs = performance.now() - registrationStart;
      });
    };
  }
  try {
    const result = await resolveWorktreeBase(clone);
    if (values.registration) {
      assert(registration, "The refresh must fetch to measure concurrent registration");
      await registration;
      assert.equal(
        execFileSync(actualGit, ["-C", path.join(output, "registered"), "rev-parse", "HEAD"], {
          env: gitEnv,
          encoding: "utf8",
        }).trim(),
        cached,
      );
    }
    assert.equal(result.commit, expected);
    assert.equal(result.fetchSucceeded, true);
    assert.equal(fetches, values.advancing || baseline ? 1 : 0);
    if (values.advancing) {
      execFileSync(actualGit, ["-C", clone, "merge-base", "--is-ancestor", cached, expected], {
        env: gitEnv,
      });
    }
    assert.equal(advertisements, 1);
    let gitCpuMs = 0;
    let gitPeakRssBytes = 0;
    let receivedObjects = 0;
    let offeredHaves = 0;
    const gitPhasesMs: Record<string, number> = {};
    for (const filename of await fs.readdir(metrics)) {
      if (!filename.startsWith("baseRefresh-")) {
        continue;
      }
      const text = await fs.readFile(path.join(metrics, filename), "utf8");
      if (filename.endsWith(".packet")) {
        offeredHaves += [...text.matchAll(/fetch> have /gu)].length;
      }
      if (filename.endsWith(".perf")) {
        for (const match of text.matchAll(/write_pack_file\/wrote:(\d+)/gu)) {
          receivedObjects += Number(match[1]);
        }
        for (const line of text.split("\n")) {
          const fields = line.split("|").map((field) => field.trim());
          if (fields[3] === "region_leave") {
            const label = /label:(.*)$/u.exec(fields[8] ?? "")?.[1];
            if (label) {
              gitPhasesMs[label] = (gitPhasesMs[label] ?? 0) + Number(fields[6]) * 1000;
            }
          }
        }
      }
      if (!filename.endsWith(".time")) {
        continue;
      }
      const receipt = text;
      const cpu = /([\d.]+) user\s+([\d.]+) sys/u.exec(receipt);
      const rss = /(\d+)\s+maximum resident set size/u.exec(receipt);
      assert(cpu && rss, receipt);
      gitCpuMs += (Number(cpu[1]) + Number(cpu[2])) * 1000;
      gitPeakRssBytes = Math.max(gitPeakRssBytes, Number(rss[1]));
    }
    const row = {
      arm: values.arm,
      advancing: Boolean(values.advancing),
      baseline: Boolean(baseline || baselineFetch),
      ownerSha256,
      ...phases.baseRefresh,
      commandCount,
      fetches,
      advertisements,
      gitCpuMs,
      gitPeakRssBytes,
      receivedObjects,
      offeredHaves,
      gitPhasesMs,
      registrationQueueWaitMs,
      registrationWallMs,
      commit: result.commit,
      loadBefore,
      loadAfter: loadavg(),
    };
    await fs.writeFile(path.join(output, "result.json"), JSON.stringify(row, null, 2));
    console.log(JSON.stringify(row));
  } finally {
    await Promise.allSettled([registration]);
    await drainGlobalSingletonLifecycleState();
    profiler?.disconnect();
    hook.deregister();
    Reflect.deleteProperty(globalThis, key);
  }
}
