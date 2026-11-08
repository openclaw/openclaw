// Prepare with worktree-hydration-fixture.py --advancing --shallow
// --extra-refs 13505 --extra-packs 1326 --linked-worktrees 2437.
// Run serially: node --import ./scripts/tsx.mjs scripts/perf/publication-fetch-measure.ts
// --fixture <task-owned fixture> --output <new directory> [--base-file <saved transport.ts>]
// [--contents | --present | --base-refresh] [--allocation]
// Each run restores only this disposable fixture's acquired packs and tracking ref.
// Compare five counterbalanced A/B and A/A pairs. Accept lower owner wall/CPU with
// identical received objects and usable ancestry/content; report residual native scans.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    output: { type: "string" },
    "base-file": { type: "string" },
    contents: { type: "boolean" },
    present: { type: "boolean" },
    "base-refresh": { type: "boolean" },
    allocation: { type: "boolean" },
  },
});
assert(values.fixture && values.output);
assert(process.platform === "darwin", "Native CPU receipts use macOS time -l");
const fixture = path.resolve(values.fixture);
const output = path.resolve(values.output);
const cwd = path.join(fixture, "seed");
const remote = path.join(fixture, "origin.git");
const packs = path.join(cwd, ".git/objects/pack");
const configPath = path.join(cwd, ".git/config");
const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: "file",
};
const git = (root: string, args: string[]) =>
  execFileSync(actualGit, ["-C", root, ...args], { env, encoding: "utf8" }).trim();
const base = git(cwd, ["rev-parse", "HEAD"]);
const target = git(remote, ["rev-parse", "HEAD"]);
const config = await fs.readFile(configPath);
const initialPacks = new Set(await fs.readdir(packs));
const shallow = await fs.readFile(path.join(cwd, ".git/shallow"), "utf8").catch(() => "");
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
await fs.mkdir(output);
const bin = path.join(output, "bin");
await fs.mkdir(bin);
const wrapper = path.join(bin, "git");
await fs.writeFile(
  wrapper,
  `#!/bin/sh\nprintf '%s\\n' "$*" > ${quote(output)}/$$.argv\nexec /usr/bin/time -l -o ${quote(output)}/$$.time ${quote(actualGit)} "$@"\n`,
  { mode: 0o755 },
);
Object.assign(process.env, env, {
  PATH: `${bin}:${process.env.PATH}`,
  OPENCLAW_STATE_DIR: path.join(fixture, "isolated-state"),
  GIT_TRACE2_PERF: path.join(output, "git.perf"),
  GIT_TRACE_PACKET: path.join(output, "git.packet"),
});
const ownerUrl = new URL("../../src/gateway/github-publication-git-transport.ts", import.meta.url)
  .href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    return nextLoad(
      url === ownerUrl && values["base-file"]
        ? pathToFileURL(path.resolve(values["base-file"])).href
        : url,
      context,
    );
  },
});
const inspector = new Session();
const allocationBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + allocationBytes(child), 0);
try {
  const owner = (await import(
    ownerUrl
  )) as typeof import("../../src/gateway/github-publication-git-transport.js");
  const baseOwner = values["base-refresh"]
    ? await import("../../src/agents/worktrees/base-ref.js")
    : undefined;
  let fetches = 0;
  const run: typeof owner.runPublicationCommand = (argv, options) => {
    if (argv.includes("fetch")) {
      fetches++;
    }
    return owner.runPublicationCommand(
      argv.map((arg) =>
        arg === "https://github.com/synthetic/fixture.git" ? pathToFileURL(remote).href : arg,
      ),
      options,
    );
  };
  // The long-lived Gateway already owns its spawn worker. Exclude its first boot.
  await owner.runPublicationCommand(["git", "--version"], {
    cwd,
    env: { GIT_TRACE2_PERF: undefined, GIT_TRACE_PACKET: undefined },
  });
  for (const name of await fs.readdir(output)) {
    if (name.endsWith(".time") || name.endsWith(".argv")) {
      await fs.unlink(path.join(output, name));
    }
  }
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const loadBefore = os.loadavg();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  if (baseOwner) {
    const resolved = await baseOwner.resolveWorktreeBase(cwd);
    assert.equal(resolved.commit, target);
  } else {
    await owner.requireGitHubPublicationCommit(
      run,
      "synthetic/fixture",
      values.present ? base : target,
      "github.com",
      cwd,
      process.env,
      "Synthetic publication fetch failed",
      { contents: values.contents, baseBranch: "main" },
    );
  }
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const sampledAllocationBytes = values.allocation
    ? allocationBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  const perf = await fs.readFile(path.join(output, "git.perf"), "utf8");
  const packet = await fs.readFile(path.join(output, "git.packet"), "utf8").catch(() => "");
  const phases: Record<string, number> = {};
  for (const line of perf.split("\n")) {
    const fields = line.split("|").map((field) => field.trim());
    if (fields[3] === "region_leave") {
      const label = fields[8]?.match(/label:(.*)$/u)?.[1];
      if (label) {
        phases[label] = (phases[label] ?? 0) + Number(fields[6]) * 1000;
      }
    }
  }
  let nativeCpuMs = 0;
  let peakRssBytes = 0;
  for (const name of await fs.readdir(output)) {
    if (!name.endsWith(".time")) {
      continue;
    }
    const receipt = await fs.readFile(path.join(output, name), "utf8");
    const times = receipt.match(/([\d.]+) user\s+([\d.]+) sys/u);
    assert(times);
    nativeCpuMs += (Number(times[1]) + Number(times[2])) * 1000;
    peakRssBytes = Math.max(
      peakRssBytes,
      Number(receipt.match(/(\d+)\s+maximum resident set size/u)?.[1]),
    );
  }
  const acquired = (await fs.readdir(packs)).filter(
    (name) => name.endsWith(".pack") && !initialPacks.has(name),
  );
  let packBytes = 0;
  for (const name of acquired) {
    packBytes += (await fs.stat(path.join(packs, name))).size;
  }
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), base);
  assert.equal(await fs.readFile(path.join(cwd, ".git/shallow"), "utf8").catch(() => ""), shallow);
  git(cwd, ["merge-base", "--is-ancestor", base, values.present ? base : target]);
  if (values.contents) {
    assert.equal(git(cwd, ["show", `${target}:target/missing.txt`]).length, 18432);
  }
  const result = {
    variant: values["base-file"] ? "base" : "candidate",
    mode: values["base-refresh"]
      ? "base-refresh"
      : values.contents
        ? "contents"
        : values.present
          ? "present"
          : "commit",
    wallMs,
    jsCpuMs: (cpu.user + cpu.system) / 1000,
    sampledAllocationBytes,
    nativeCpuMs,
    peakRssBytes,
    fetches,
    packBytes,
    offeredHaves: (packet.match(/fetch> have /gu) ?? []).length,
    receivedObjects: perf
      .split("\n")
      .filter((line) => line.includes("child_start"))
      .reduce((sum, line) => sum + Number(line.match(/--pack_header=\d+,(\d+)/u)?.[1] ?? 0), 0),
    phases,
    loadBefore,
    loadAfter: os.loadavg(),
  };
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  hooks.deregister();
  inspector.disconnect();
  git(cwd, ["update-ref", "refs/remotes/origin/main", base]);
  for (const name of await fs.readdir(packs)) {
    if (!initialPacks.has(name)) {
      await fs.unlink(path.join(packs, name));
    }
  }
  await fs.writeFile(configPath, config);
  await fs.rm(path.join(cwd, ".git/FETCH_HEAD"), { force: true });
}
