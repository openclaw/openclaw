/**
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-fast-forward-measure.ts \
 *   --base <parent-sha> --output <new-directory-on-scratch-volume>
 *
 * Warm owner phase on 500 real linked worktrees and a 62k-file primary checkout.
 * Five interleaved A1/A2/B samples. Accept fewer Node reservation FS requests and
 * lower allocated bytes on clean attempts, zero linked scans on dirty attempts,
 * matching ref outcomes, and no >20% wall/CPU median or p95 regression.
 * Node CPU includes its filesystem workers. Git child CPU and syscalls are excluded.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    output: { type: "string" },
    fixture: { type: "string" },
    owner: { type: "string" },
    dirty: { type: "boolean" },
    profile: { type: "boolean" },
  },
});
assert(values.output, "--output is required");
const output = path.resolve(values.output);
await fs.mkdir(output);
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(output, "empty-gitconfig"),
  OPENCLAW_HOME: output,
  OPENCLAW_STATE_DIR: path.join(output, "state"),
});
const ownerPath = "src/agents/worktrees/base-ref.ts";
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", input }).trim();

if (values.fixture) {
  const repo = path.join(await fs.realpath(values.fixture), "repo");
  const commonDir = path.join(repo, ".git");
  const linkedDir = path.join(commonDir, "worktrees");
  const prior = git(repo, ["rev-parse", "HEAD"]);
  const target = git(repo, ["rev-parse", "origin/main"]);
  assert.notEqual(prior, target);
  const owner = values.owner ? await fs.readFile(values.owner, "utf8") : undefined;
  const ownerSha256 = createHash("sha256")
    .update(owner ?? (await fs.readFile(ownerPath, "utf8")))
    .digest("hex");
  const profiler = values.profile ? new Session() : undefined;
  profiler?.connect();
  await profiler?.post("Profiler.enable");
  let active = false;
  let listings = 0;
  let reads = 0;
  let linkedListings = 0;
  let phase: object | undefined;
  const readdir = fs.readdir;
  const readFile = fs.readFile;
  const readFileCallback = fsSync.readFile;
  const linkedPrefix = `${linkedDir}${path.sep}`;
  fs.readdir = new Proxy(readdir, {
    apply(method, receiver: unknown, args: unknown[]) {
      const [directory] = args;
      if (active && typeof directory === "string") {
        listings += Number(
          directory === commonDir || directory === linkedDir || directory.startsWith(linkedPrefix),
        );
        linkedListings += Number(directory === linkedDir);
      }
      return Reflect.apply(method, receiver, args);
    },
  });
  const readCounter = {
    apply(method: typeof readFile | typeof readFileCallback, receiver: unknown, args: unknown[]) {
      const [file] = args;
      if (active && typeof file === "string" && file.startsWith(linkedPrefix)) {
        reads++;
      }
      return Reflect.apply(method, receiver, args);
    },
  };
  fs.readFile = new Proxy<typeof readFile>(readFile, readCounter);
  fsSync.readFile = new Proxy<typeof readFileCallback>(readFileCallback, readCounter);
  syncBuiltinESMExports();
  const key = Symbol.for("openclaw.perf.worktree-fast-forward");
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: async (name: string, run: () => Promise<unknown>) => {
      if (name !== "baseFastForward") {
        return await run();
      }
      assert(!active && !phase);
      await profiler?.post("Profiler.start");
      const load = loadavg();
      const cpu = process.cpuUsage();
      const thread = process.threadCpuUsage();
      const allocated = getHeapStatistics().total_allocated_bytes;
      assert(Number.isFinite(allocated), "Run on Node 26 with V8 allocation counters");
      const start = performance.now();
      active = true;
      try {
        return await run();
      } finally {
        const wallMs = performance.now() - start;
        const processCpu = process.cpuUsage(cpu);
        const threadCpu = process.threadCpuUsage(thread);
        const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocated;
        active = false;
        phase = {
          wallMs,
          processCpuMs: (processCpu.user + processCpu.system) / 1000,
          threadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
          allocatedBytes,
          listings,
          reads,
          linkedListings,
          load,
        };
        if (profiler) {
          const { profile } = await profiler.post("Profiler.stop");
          await fs.writeFile(path.join(output, "cpu.cpuprofile"), JSON.stringify(profile));
        }
      }
    },
  });
  const hook = registerHooks({
    load(url, context, next) {
      if (owner && url.endsWith(`/${ownerPath}`)) {
        return { format: "module-typescript", shortCircuit: true, source: owner };
      }
      if (url.endsWith("/src/agents/worktrees/preparation-timing.ts")) {
        const source = fsSync.readFileSync(new URL(url), "utf8");
        const entry = "export async function timeWorktreePreparationPhase<T>(";
        assert(source.includes(entry));
        return {
          format: "module-typescript",
          shortCircuit: true,
          source:
            source.replace(entry, "async function timeOriginal<T>(") +
            `\nexport async function timeWorktreePreparationPhase<T>(phase: PreparationPhase, run: () => Promise<T>): Promise<T> {
              return globalThis[Symbol.for("openclaw.perf.worktree-fast-forward")](phase, () => timeOriginal(phase, run));
            }\n`,
        };
      }
      return next(url, context);
    },
  });
  try {
    const { resolveWorktreeBase } = await import("../../src/agents/worktrees/base-ref.js");
    const { drainGlobalSingletonLifecycleState } =
      await import("../../src/shared/global-singleton.js");
    try {
      assert.equal((await resolveWorktreeBase(repo)).commit, target);
      const selected = await resolveWorktreeBase(
        repo,
        undefined,
        undefined,
        undefined,
        "fast-forward",
      );
      assert.equal(selected.commit, target);
      assert.equal(selected.warning, undefined);
      assert.equal(git(repo, ["rev-parse", "HEAD"]), values.dirty ? prior : target);
      assert(phase);
      await fs.writeFile(
        path.join(output, "result.json"),
        JSON.stringify({ ownerSha256, ...phase }),
      );
    } finally {
      await drainGlobalSingletonLifecycleState();
    }
  } finally {
    hook.deregister();
    profiler?.disconnect();
    fs.readdir = readdir;
    fs.readFile = readFile;
    fsSync.readFile = readFileCallback;
    syncBuiltinESMExports();
    Reflect.deleteProperty(globalThis, key);
  }
} else {
  assert(values.base, "--base must name the baseline revision");
  const base = git(process.cwd(), ["rev-parse", `${values.base}^{commit}`]);
  const baseFile = path.join(output, "base-ref.baseline.ts");
  await fs.writeFile(baseFile, execFileSync("git", ["show", `${base}:${ownerPath}`]));
  const fixture = await fs.mkdtemp(path.join(output, "fixture-"));
  const repo = path.join(fixture, "repo");
  const origin = path.join(fixture, "origin.git");
  const dirtyFile = path.join(repo, "dirty");
  try {
    git(fixture, ["init", "--template=", "-b", "main", repo]);
    git(repo, ["config", "user.name", "Synthetic fixture"]);
    git(repo, ["config", "user.email", "fixture@example.invalid"]);
    git(repo, ["config", "gc.auto", "0"]);
    const blob = git(repo, ["hash-object", "-w", "--stdin"], "x".repeat(18_000));
    const index = Array.from(
      { length: 62_000 },
      (_, i) => `100644 ${blob}\tfiles/${Math.floor(i / 200)}/${i}\n`,
    ).join("");
    git(repo, ["update-index", "--index-info"], index);
    git(repo, ["checkout-index", "-a", "-u"]);
    git(repo, ["commit", "--quiet", "-m", "fixture"]);
    const prior = git(repo, ["rev-parse", "HEAD"]);
    const target = git(repo, ["commit-tree", "HEAD^{tree}", "-p", prior, "-m", "advance"]);
    for (let i = 0; i < 500; i++) {
      git(repo, [
        "worktree",
        "add",
        "--no-checkout",
        "-b",
        `fixture/${i}`,
        path.join(fixture, `linked-${i}`),
        prior,
      ]);
    }
    git(fixture, ["clone", "--bare", repo, origin]);
    git(origin, ["update-ref", "refs/heads/main", target]);
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["fetch", "origin"]);
    git(repo, ["remote", "set-head", "origin", "main"]);
    const rows: unknown[] = [];
    for (const mode of ["clean", "dirty", "profile"]) {
      if (mode === "dirty") {
        await fs.writeFile(dirtyFile, "operator edit\n");
      } else if (mode === "profile") {
        await fs.unlink(dirtyFile);
      }
      for (let round = 0; round < (mode === "profile" ? 1 : 5); round++) {
        const orders = [
          ["A1", "A2", "B"],
          ["B", "A2", "A1"],
          ["A2", "B", "A1"],
        ];
        const order = mode === "profile" ? ["A1", "B"] : orders[round % orders.length];
        assert(order);
        for (const label of order) {
          const sample = path.join(output, `${mode}-${round}-${label}`);
          execFileSync(
            process.execPath,
            [
              "--import",
              "./scripts/tsx.mjs",
              fileURLToPath(import.meta.url),
              "--output",
              sample,
              "--fixture",
              fixture,
              ...(label === "B" ? [] : ["--owner", baseFile]),
              ...(mode === "dirty" ? ["--dirty"] : []),
              ...(mode === "profile" ? ["--profile"] : []),
            ],
            { stdio: "inherit" },
          );
          const row = {
            mode,
            round,
            label,
            ...JSON.parse(await fs.readFile(path.join(sample, "result.json"), "utf8")),
          };
          console.log(JSON.stringify(row));
          rows.push(row);
          await fs.writeFile(path.join(output, "results.json"), JSON.stringify(rows, null, 2));
          if (mode !== "dirty") {
            git(repo, ["update-ref", "refs/heads/main", prior, target]);
          }
        }
      }
    }
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}
