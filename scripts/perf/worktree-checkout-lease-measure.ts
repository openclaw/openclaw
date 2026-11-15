/**
 * Real Git maintenance/checkout owners, synthetic packs and isolated state only.
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-checkout-lease-measure.ts \
 *   --prepare <new-seed-directory> [--packs 1024 --files 62000 --pack-kib 512]
 * Save baseline maintenance, checkout and state-lease owners with git show, then:
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-checkout-lease-measure.ts \
 *   --seed <seed> --output <new-output> --base-file <maintenance.ts> \
 *   --base-checkout-file <checkout.ts> --base-lease-file <state-lease.ts> [--pairs 5]
 * Five serial AB/BA pairs followed by A/A, fresh clone/process per sample.
 * --arm candidate --profile runs a separate phase-scoped CPU profile.
 * Acceptance: foreground lease wait <1s during the real consolidation command,
 * unchanged HEAD/object availability, no >=20% owner CPU/allocation regression.
 * Node 26 V8 allocation counters and macOS time -l are required. Copies, startup,
 * fixture registration and verification are outside measurement. Disk caches are
 * warm; this is owner-level APFS proof, not a cold Gateway/btrfs/agent-DB claim.
 * The owner never reads agent databases; a padded 35 GiB DB adds no exercised work.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import { constants, readFileSync, watch } from "node:fs";
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
    prepare: { type: "string" },
    seed: { type: "string" },
    output: { type: "string" },
    "base-file": { type: "string" },
    "base-checkout-file": { type: "string" },
    "base-lease-file": { type: "string" },
    pairs: { type: "string", default: "5" },
    packs: { type: "string", default: "1024" },
    files: { type: "string", default: "62000" },
    "pack-kib": { type: "string", default: "512" },
    arm: { type: "string" },
    profile: { type: "boolean" },
  },
});
const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: "",
};
const git = (cwd: string, args: string[], input?: string | Buffer) =>
  execFileSync(actualGit, ["-C", cwd, ...args], {
    env: gitEnv,
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

if (values.prepare) {
  const seed = path.resolve(values.prepare);
  const packs = Number(values.packs),
    files = Number(values.files),
    kib = Number(values["pack-kib"]);
  assert([packs, files, kib].every((value) => Number.isSafeInteger(value) && value > 0));
  await fs.mkdir(seed);
  git(seed, ["init", "--quiet", "-b", "main"]);
  git(seed, ["config", "gc.auto", "0"]);
  git(seed, ["config", "maintenance.auto", "false"]);
  const contents = Buffer.alloc(18_432, 0x78);
  for (let index = 0; index < files; index++) {
    const directory = path.join(seed, `d${Math.floor(index / 100)}`);
    if (index % 100 === 0) {
      await fs.mkdir(directory);
    }
    contents.writeUInt32LE(index);
    await fs.writeFile(path.join(directory, `f${index}.txt`), contents);
  }
  git(seed, ["add", "."]);
  git(seed, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "synthetic checkout",
  ]);
  git(seed, ["repack", "-a", "-d"]);
  const directory = path.join(seed, ".git", "objects", "pack");
  for (const name of await fs.readdir(directory)) {
    if (name.endsWith(".pack")) {
      await fs.writeFile(path.join(directory, `${name.slice(0, -5)}.keep`), "synthetic base\n");
    }
  }
  const payload = createCipheriv("aes-256-ctr", Buffer.alloc(32), Buffer.alloc(16)).update(
    Buffer.alloc(kib * 1024),
  );
  const oids = [];
  for (let revision = 0; revision < packs; revision++) {
    payload.writeUInt32LE(revision);
    const oid = git(seed, ["hash-object", "-w", "--stdin"], payload);
    const hash = git(
      seed,
      ["pack-objects", "--window=0", path.join(directory, "pack")],
      `${oid}\n`,
    );
    await fs.writeFile(path.join(directory, `pack-${hash}.promisor`), "");
    oids.push(oid);
  }
  git(seed, ["prune-packed"]);
  await fs.writeFile(
    path.join(seed, ".git", "fixture.json"),
    JSON.stringify({
      packs,
      files,
      checkoutBytes: files * contents.length,
      packInputBytes: packs * payload.length,
      oids,
    }),
  );
  console.log(
    JSON.stringify({
      seed,
      packs,
      files,
      checkoutBytes: files * contents.length,
      packInputBytes: packs * payload.length,
    }),
  );
} else {
  assert(values.seed && values.output, "--seed and --output are required");
  assert.equal(process.platform, "darwin", "Native CPU receipts require macOS time -l");
  const seed = await fs.realpath(values.seed);
  const output = path.resolve(values.output);
  const baseline = values["base-file"] && path.resolve(values["base-file"]);
  const baselineCheckout =
    values["base-checkout-file"] && path.resolve(values["base-checkout-file"]);
  const baselineLease = values["base-lease-file"] && path.resolve(values["base-lease-file"]);
  await fs.mkdir(output);
  if (!values.arm) {
    assert(baseline && baselineCheckout && baselineLease, "All baseline owner files are required");
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
          if (arm === "base" || control) {
            args.push(
              "--base-file",
              baseline,
              "--base-checkout-file",
              baselineCheckout,
              "--base-lease-file",
              baselineLease,
            );
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
    await fs.cp(seed, clone, { recursive: true, mode: constants.COPYFILE_FICLONE });
    const fixture: {
      packs: number;
      files: number;
      checkoutBytes: number;
      packInputBytes: number;
      oids: string[];
    } = JSON.parse(await fs.readFile(path.join(clone, ".git", "fixture.json"), "utf8"));
    const expectedHead = git(clone, ["rev-parse", "HEAD"]);
    const metrics = path.join(output, "git-metrics"),
      bin = path.join(output, "bin");
    await fs.mkdir(metrics);
    await fs.mkdir(bin);
    const marker = path.join(metrics, "pack-started");
    const completed = path.join(metrics, "pack-completed");
    await fs.writeFile(marker, "");
    await fs.writeFile(completed, "");
    await fs.writeFile(
      path.join(bin, "git"),
      `#!/bin/sh\nreceipt=${shellQuote(metrics)}/git-$$\n` +
        `printf '%s\\n' "$*" > "$receipt.argv"\n` +
        `case "$*" in *alias.openclaw-consolidate=*) printf started > ${shellQuote(marker)} ;; esac\n` +
        `if [ "$OPENCLAW_PERF_GIT_TIMED" = 1 ]; then exec ${shellQuote(actualGit)} "$@"; fi\n` +
        `export OPENCLAW_PERF_GIT_TIMED=1\n/usr/bin/time -l -o "$receipt.time" ${shellQuote(actualGit)} "$@"\nresult=$?\n` +
        `case "$*" in *alias.openclaw-consolidate=*) printf completed > ${shellQuote(completed)} ;; esac\nexit "$result"\n`,
      { mode: 0o755 },
    );
    Object.assign(process.env, gitEnv, {
      OPENCLAW_STATE_DIR: path.join(output, "state"),
      OPENCLAW_HOME: output,
      PATH: `${bin}:${process.env.PATH}`,
    });
    const owners = [
      ["src/agents/worktrees/git-maintenance.ts", baseline],
      ["src/projects/project-checkout.ts", baselineCheckout],
      ["src/state/openclaw-state-lease.ts", baselineLease],
    ] as const;
    const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
    const ownerSha256 = createHash("sha256");
    for (const [relative, original] of owners) {
      ownerSha256
        .update(relative)
        .update(readFileSync(original ?? path.join(sourceRoot, relative)));
    }
    const hook = registerHooks({
      load(url, context, next) {
        const owner = owners.find(
          ([relative, original]) => original && url.endsWith(`/${relative}`),
        );
        return owner?.[1]
          ? {
              format: "module-typescript",
              shortCircuit: true,
              source: readFileSync(owner[1], "utf8"),
            }
          : next(url, context);
      },
    });
    const { createWorktreeGitMaintenance } =
      await import("../../src/agents/worktrees/git-maintenance.js");
    const { withProjectCheckoutLifecycle } = await import("../../src/projects/project-checkout.js");
    const { insertRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
    const { WorktreeGcProgress } = await import("../../src/agents/worktrees/gc-progress.js");
    const { requireGit } = await import("../../src/agents/worktrees/git.js");
    const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
    const { drainGlobalSingletonLifecycleState } =
      await import("../../src/shared/global-singleton.js");
    setRuntimeConfigSnapshot({});
    await insertRegistryWorktree(process.env, {
      id: "synthetic-packs",
      name: "synthetic-packs",
      repoRoot: clone,
      repoFingerprint: "0123456789abcdef",
      path: clone,
      branch: "main",
      baseRef: "HEAD",
      ownerKind: "manual",
      createdAt: 1,
      lastActiveAt: 1,
    });
    // Warm state admission independently of the measured owner operation.
    await withProjectCheckoutLifecycle(clone, { env: process.env }, async () => {});
    const profiler = values.profile ? new Session() : undefined;
    profiler?.connect();
    if (profiler) {
      await profiler.post("Profiler.enable");
      await profiler.post("Profiler.start");
    }
    const controller = new AbortController();
    let foreground: Promise<void> | undefined;
    let waitMs = 0,
      foregroundMs = 0,
      requestedAt = 0;
    let packStarted = false;
    let acquiredDuringConsolidation = false;
    // Watch the file itself: macOS directory FSEvents can coalesce past a short pass.
    const observer = watch(marker, () => {
      if (packStarted || readFileSync(marker, "utf8") !== "started") {
        return;
      }
      packStarted = true;
      assert.equal(
        readFileSync(completed, "utf8"),
        "",
        "Foreground must request during consolidation",
      );
      requestedAt = performance.now();
      foreground = withProjectCheckoutLifecycle(
        clone,
        { env: process.env, signal: controller.signal, waitMs: 120_000 },
        async (lease) => {
          waitMs = performance.now() - requestedAt;
          acquiredDuringConsolidation = readFileSync(completed, "utf8") === "";
          await requireGit(
            clone,
            [
              "worktree",
              "add",
              "--no-checkout",
              "--detach",
              path.join(output, "registered"),
              expectedHead,
            ],
            { signal: lease.signal, beforeRun: () => lease.assertCurrent() },
          );
        },
      ).then(() => {
        foregroundMs = performance.now() - requestedAt;
      });
      void foreground.catch(() => {});
    });
    const progress = new WorktreeGcProgress();
    const beforeCpu = process.cpuUsage(),
      beforeThread = process.threadCpuUsage();
    const beforeAllocation = getHeapStatistics().total_allocated_bytes;
    assert(Number.isFinite(beforeAllocation), "Runtime must expose V8 allocation counters");
    const loadBefore = loadavg(),
      started = performance.now();
    try {
      await createWorktreeGitMaintenance(process.env)({ progress, signal: controller.signal });
      const maintenanceMs = performance.now() - started;
      assert.equal(
        progress.result.failedCount,
        0,
        "Maintenance must preserve a healthy repository",
      );
      assert(
        foreground && packStarted,
        "A real consolidation launch must trigger the foreground request",
      );
      await foreground;
      const wallMs = performance.now() - started;
      const cpu = process.cpuUsage(beforeCpu),
        thread = process.threadCpuUsage(beforeThread);
      const allocatedBytes = getHeapStatistics().total_allocated_bytes - beforeAllocation;
      observer.close();
      if (profiler) {
        const { profile } = await profiler.post("Profiler.stop");
        await fs.writeFile(path.join(output, "maintenance.cpuprofile"), JSON.stringify(profile));
      }
      assert.equal(git(path.join(output, "registered"), ["rev-parse", "HEAD"]), expectedHead);
      const objects = git(
        clone,
        ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        `${fixture.oids.join("\n")}\n`,
      );
      assert(!objects.includes("missing"), "Every original object remains readable");
      let gitCpuMs = 0,
        gitPeakRssBytes = 0,
        gitCommands = 0;
      for (const name of await fs.readdir(metrics)) {
        if (name.endsWith(".argv")) {
          gitCommands++;
          assert(
            !/\bfetch\b/u.test(await fs.readFile(path.join(metrics, name), "utf8")),
            "Maintenance must not fetch",
          );
        }
        if (!name.endsWith(".time")) {
          continue;
        }
        const receipt = await fs.readFile(path.join(metrics, name), "utf8");
        const used = /([\d.]+) user\s+([\d.]+) sys/u.exec(receipt);
        const rss = /(\d+)\s+maximum resident set size/u.exec(receipt);
        assert(used && rss, receipt);
        gitCpuMs += (Number(used[1]) + Number(used[2])) * 1000;
        gitPeakRssBytes = Math.max(gitPeakRssBytes, Number(rss[1]));
      }
      const row = {
        arm: values.arm,
        baseline: Boolean(baseline),
        ownerSha256: ownerSha256.digest("hex"),
        node: process.version,
        ...fixture,
        oids: undefined,
        waitMs,
        acquiredDuringConsolidation,
        foregroundMs,
        maintenanceMs,
        wallMs,
        processCpuMs: (cpu.user + cpu.system) / 1000,
        threadCpuMs: (thread.user + thread.system) / 1000,
        allocatedBytes,
        gitCpuMs,
        gitPeakRssBytes,
        gitCommands,
        progress: progress.result,
        loadBefore,
        loadAfter: loadavg(),
      };
      await fs.writeFile(path.join(output, "result.json"), JSON.stringify(row, null, 2));
      console.log(JSON.stringify(row));
    } finally {
      observer.close();
      controller.abort(new Error("Benchmark finished"));
      await Promise.allSettled([foreground]);
      await drainGlobalSingletonLifecycleState();
      profiler?.disconnect();
      hook.deregister();
    }
  }
}
