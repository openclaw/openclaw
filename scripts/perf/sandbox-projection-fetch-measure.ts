/**
 * Run with node --import ./scripts/tsx.mjs scripts/perf/sandbox-projection-fetch-measure.ts
 * --source <complete-local-repo> --base <commit> --remote <url> --heads <sha,sha,sha>
 * --output <report.json> [--samples 5] [--baseline] [--instead-of <fixture-url>].
 *
 * Acceptance: the same three-head fetch adds no blobs and transfers fewer pack
 * bytes; status/diff/log/checkout/commit still work. Repeat identical invocations
 * for A/A controls; interleave baseline/candidate --samples 1 runs for A/B proof.
 * Every sample starts fresh; filesystem cache is warm, not artificially evicted.
 * --baseline removes only the owner's remote promisor/filter settings before
 * fetching. It emulates the old fetch state, not the old owner's preparation cost.
 * --owner-module <absolute-path-or-file-URL> loads a frozen owner for actual
 * before/after preparation measurements; the report records its module URL.
 * --profile-owner runs one separate allocation sample, without fetching. Allocation
 * covers only this JS isolate; owner CPU excludes Git children. Fetch CPU/RSS from
 * /usr/bin/time includes Git children. Publication requires separate broker proof.
 * This owner never reads agent/session databases; database padding adds no work.
 *
 * Freeze the old owner from a reviewed base (set baseCommit and ownerModule):
 *   node --input-type=module - "$baseCommit" "$ownerModule" <<'JS'
 *   import { execFileSync } from 'node:child_process';
 *   import path from 'node:path';
 *   import { build } from 'esbuild';
 *   const file = 'src/gateway/worker-environments/local-workspace-checkout.ts';
 *   await build({
 *     stdin: { contents: execFileSync('git', ['show', process.argv[2] + ':' + file],
 *       { encoding: 'utf8' }), sourcefile: path.basename(file),
 *       resolveDir: path.resolve(path.dirname(file)), loader: 'ts' },
 *     bundle: true, platform: 'node', format: 'esm', packages: 'external',
 *     outfile: process.argv[3], plugins: [{ name: 'preserve-peers', setup(b) {
 *       b.onResolve({ filter: /^\./ }, a => ({
 *         path: path.resolve(a.resolveDir, a.path.replace(/\.js$/, '.ts')), external: true,
 *       }));
 *     }}],
 *   });
 *   JS
 * Unchanged peers retain their original paths and package resolution in both runs.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    base: { type: "string" },
    remote: { type: "string" },
    heads: { type: "string" },
    output: { type: "string" },
    samples: { type: "string", default: "5" },
    baseline: { type: "boolean", default: false },
    "instead-of": { type: "string" },
    "profile-owner": { type: "boolean", default: false },
    "owner-module": { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "--source PATH --base COMMIT --remote URL --heads SHA,SHA,SHA --output FILE " +
      "[--samples 5] [--baseline] [--instead-of FIXTURE_URL] [--profile-owner] [--owner-module FILE]",
  );
  process.exit(0);
}
assert(values.source && values.base && values.remote && values.heads && values.output);
assert(["darwin", "linux"].includes(process.platform), "Requires macOS or Linux time(1)");
const remote = values.remote;
for (const url of [remote, values["instead-of"]].filter((value) => value !== undefined)) {
  const parsed = new URL(url);
  assert(!parsed.username && !parsed.password, "Use credential-free fetch URLs");
}
const heads = values.heads.split(",");
assert(heads.length === 3 && heads.every((head) => /^[a-f0-9]{4,64}$/u.test(head)));
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0);
const ownerModule = values["owner-module"];
assert(!ownerModule || ownerModule.startsWith("file:") || path.isAbsolute(ownerModule));
const ownerModuleUrl = ownerModule
  ? ownerModule.startsWith("file:")
    ? new URL(ownerModule)
    : pathToFileURL(ownerModule)
  : undefined;
const output = path.resolve(values.output);
await fs.mkdir(path.dirname(output), { recursive: true });
const scratch = await fs.mkdtemp(path.join(path.dirname(output), ".sandbox-fetch-"));
const environment = {
  PATH: process.env.PATH,
  HOME: scratch,
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
};
const execute = promisify(execFile);
const git = async (repo: string, args: string[]) =>
  (
    await execute("git", ["-C", repo, ...args], {
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout.trim();

async function inventory(repo: string) {
  const packs = path.join(repo, ".git", "objects", "pack");
  const names = (await fs.readdir(packs)).filter((name) => name.endsWith(".pack"));
  let packBytes = 0;
  for (const name of names) {
    packBytes += (await fs.stat(path.join(packs, name))).size;
  }
  const counts: Record<string, number> = { blob: 0, tree: 0, commit: 0, tag: 0 };
  const child = spawn(
    "git",
    ["-C", repo, "cat-file", "--batch-all-objects", "--unordered", "--batch-check=%(objecttype)"],
    { env: { ...environment, GIT_NO_LAZY_FETCH: "1" }, stdio: ["ignore", "pipe", "inherit"] },
  );
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Object inventory exited ${code}`)),
    );
  });
  for await (const type of createInterface({ input: child.stdout })) {
    counts[type] = (counts[type] ?? 0) + 1;
  }
  await closed;
  const packed = await git(repo, ["count-objects", "-v"]);
  return {
    packBytes,
    packs: names.length,
    packedObjects: Number(/^in-pack: (\d+)$/mu.exec(packed)?.[1]),
    objects: Object.values(counts).reduce((sum, count) => sum + count, 0),
    blobs: counts.blob,
    trees: counts.tree,
    commits: counts.commit,
  };
}

async function timedFetch(repo: string) {
  const timingArgs = process.platform === "darwin" ? ["-l"] : ["-f", "OPENCLAW_TIME %U %S %M"];
  const start = performance.now();
  const { stderr } = await execute(
    "/usr/bin/time",
    [...timingArgs, "git", "-C", repo, "fetch", "--no-tags", remote, ...heads],
    { env: environment, maxBuffer: 16 * 1024 * 1024 },
  );
  const wallMs = performance.now() - start;
  const cpu =
    process.platform === "darwin"
      ? /([\d.]+)\s+user\s+([\d.]+)\s+sys/u.exec(stderr)
      : /OPENCLAW_TIME ([\d.]+) ([\d.]+) (\d+)/u.exec(stderr);
  const memory =
    process.platform === "darwin"
      ? /^\s*(\d+)\s+maximum resident set size$/mu.exec(stderr)?.[1]
      : cpu?.[3];
  assert(cpu && memory, "time(1) did not return CPU and RSS measurements");
  return {
    wallMs,
    userCpuMs: Number(cpu[1]) * 1000,
    systemCpuMs: Number(cpu[2]) * 1000,
    peakRssBytes: Number(memory) * (process.platform === "darwin" ? 1 : 1024),
    nativeOutput: stderr,
  };
}

const results: unknown[] = [];
try {
  const source = await fs.realpath(values.source);
  const base = await git(source, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${values.base}^{commit}`,
  ]);
  const {
    prepareLocalWorkspaceCheckout,
  }: typeof import("../../src/gateway/worker-environments/local-workspace-checkout.js") =
    ownerModuleUrl
      ? await import(ownerModuleUrl.href)
      : await import("../../src/gateway/worker-environments/local-workspace-checkout.js");
  for (let sample = 0; sample < (values["profile-owner"] ? 1 : samples); sample++) {
    const repo = path.join(scratch, `sample-${sample}`);
    const inspector = values["profile-owner"] ? new Session() : undefined;
    inspector?.connect();
    await inspector?.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const start = performance.now();
    const cpu = process.cpuUsage();
    await prepareLocalWorkspaceCheckout({
      source,
      destination: repo,
      temporaryRoot: scratch,
      baseCommit: base,
      branch: "fetch-proof",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    const elapsed = process.cpuUsage(cpu);
    const owner = {
      wallMs: performance.now() - start,
      userCpuMs: elapsed.user / 1000,
      systemCpuMs: elapsed.system / 1000,
    };
    if (inspector) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      inspector.disconnect();
      results.push({
        sample,
        owner,
        sampledAllocationBytes: profile.samples.reduce((sum, entry) => sum + entry.size, 0),
        profile,
      });
    } else {
      if (values.baseline) {
        const config = await git(repo, ["config", "--local", "--name-only", "--list"]);
        for (const key of config
          .split("\n")
          .filter((setting) => /^remote\..*\.(promisor|partialclonefilter)$/u.test(setting))) {
          await git(repo, ["config", "--local", "--unset-all", key]);
        }
      }
      if (values["instead-of"]) {
        await git(repo, ["config", `url.${values["instead-of"]}.insteadOf`, remote]);
      }
      const before = await inventory(repo);
      const fetch = await timedFetch(repo);
      const after = await inventory(repo);
      const fetched = {
        objects: after.objects - before.objects,
        packBytes: after.packBytes - before.packBytes,
        blobs: after.blobs! - before.blobs!,
      };
      assert.equal(await git(repo, ["status", "--porcelain"]), "");
      const diff = await git(repo, ["diff", "--stat", base, heads[0]!]);
      const log = await git(repo, ["log", "-3", "--oneline", heads[0]!]);
      await git(repo, ["checkout", "--quiet", "--detach", heads[0]!]);
      assert.equal(await git(repo, ["status", "--porcelain"]), "");
      await git(repo, [
        "-c",
        "user.name=Fetch Proof",
        "-c",
        "user.email=fetch@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "Synthetic fetch workflow proof",
      ]);
      results.push({
        sample,
        owner,
        before,
        after,
        fetched,
        fetch,
        noFetchedBlobs: fetched.blobs === 0,
        workflow: {
          diff,
          log,
          commit: await git(repo, ["rev-parse", "HEAD"]),
          afterCheckout: await inventory(repo),
        },
      });
    }
    await fs.rm(repo, { recursive: true, force: true });
    const report = {
      source,
      ownerModule:
        ownerModuleUrl?.href ??
        new URL(
          "../../src/gateway/worker-environments/local-workspace-checkout.ts",
          import.meta.url,
        ).href,
      base,
      remote,
      heads,
      mode: values.baseline ? "baseline" : "candidate",
      profileOwner: values["profile-owner"],
      platform: process.platform,
      gitVersion: await git(source, ["--version"]),
      loadAverage: os.loadavg(),
      results,
    };
    await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ sample, output, owner }));
  }
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
