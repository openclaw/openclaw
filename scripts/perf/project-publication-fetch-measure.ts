/**
 * Synthetic partial-clone publication fetch benchmark (macOS and Linux).
 * Usage: node --import ./scripts/tsx.mjs scripts/perf/project-publication-fetch-measure.ts
 *   --mode prepare --fixture .local/fetch-repro/fixture [--packs 256 --blobs 2048 --refs 15000]
 *   --mode measure --fixture .local/fetch-repro/fixture --output .local/fetch-repro/base
 *   [--samples 5 --revision /path/to/checkout]
 *   --mode connectivity --fixture .local/fetch-repro/fixture --output .local/fetch-repro/connectivity
 *   --trace .local/fetch-repro/base/command-0.trace.jsonl
 * Run measure on base, then candidate, against the same prepared fixture. The real
 * publication owner uses a local synthetic remote; Git cannot access the network.
 * No maintenance or other command touches an operator repository. Preparation is
 * sequential and caps synthetic blob payload at 128 MiB. Hundreds of promisor packs
 * coexist with an already-present non-promisor commit and 15,000 remote refs.
 * Each owner Git command is timed; RSS is largest-process rusage, not summed RSS.
 * A separate replay of Git's traced connectivity argv measures that child directly.
 * This targeted owner proof supplements the canonical Team-shaped Gateway stress.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "measure" },
    fixture: { type: "string" },
    output: { type: "string" },
    revision: { type: "string", default: process.cwd() },
    trace: { type: "string" },
    packs: { type: "string", default: "256" },
    blobs: { type: "string", default: "2048" },
    refs: { type: "string", default: "15000" },
    samples: { type: "string", default: "5" },
  },
});
assert(values.fixture, "--fixture is required");
assert(["prepare", "measure", "connectivity"].includes(values.mode));
assert(["darwin", "linux"].includes(process.platform));
const fixture = path.resolve(values.fixture);
const receiver = path.join(fixture, "receiver");
const remote = path.join(fixture, "remote.git");
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  DEVELOPER_DIR: process.env.DEVELOPER_DIR,
  HOME: fixture,
  TMPDIR: path.join(fixture, "tmp"),
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "file",
  GIT_NO_LAZY_FETCH: "1",
};
const integer = (value: string) => {
  const number = Number(value);
  assert(Number.isSafeInteger(number) && number > 0);
  return number;
};
const run = async (argv: string[], cwd: string, input?: string | Buffer, overrides = env) =>
  await new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: overrides, stdio: "pipe" });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }),
    );
    child.stdin.end(input);
  });
const git = async (cwd: string, args: string[], input?: string | Buffer) => {
  const result = await run(["git", ...args], cwd, input);
  assert.equal(result.code, 0, result.stderr.toString());
  return result.stdout.toString().trim();
};
if (values.mode === "prepare") {
  const packs = integer(values.packs);
  const blobs = integer(values.blobs);
  const refs = integer(values.refs);
  assert(packs * blobs * 32 <= 128 * 1024 * 1024, "Payload exceeds 128 MiB");
  await fs.mkdir(fixture);
  await fs.mkdir(env.TMPDIR!);
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(remote, ["config", "uploadpack.allowFilter", "true"]);
  await git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const emptyTree = await git(remote, ["mktree"], "");
  const commitText = `tree ${emptyTree}\nauthor Synthetic <synthetic@example.invalid> 1700000000 +0000\ncommitter Synthetic <synthetic@example.invalid> 1700000000 +0000\n\nSynthetic\n`;
  const initial = await git(remote, ["hash-object", "-t", "commit", "-w", "--stdin"], commitText);
  await git(remote, ["update-ref", "refs/heads/main", initial]);
  await git(fixture, [
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    pathToFileURL(remote).href,
    receiver,
  ]);
  for (const [key, value] of [
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["fastimport.unpackLimit", "0"],
  ]) {
    await git(receiver, ["config", key!, value!]);
  }
  for (let pack = 0; pack < packs; pack++) {
    const commands: Buffer[] = [];
    for (let blob = 0; blob < blobs; blob++) {
      const bytes = Buffer.alloc(32);
      bytes.writeUInt32LE(pack, 0);
      bytes.writeUInt32LE(blob, 4);
      commands.push(Buffer.from("blob\ndata 32\n"), bytes, Buffer.from("\n"));
    }
    commands.push(Buffer.from("done\n"));
    await git(receiver, ["fast-import", "--quiet", "--done"], Buffer.concat(commands));
    if (pack % 64 === 63) {
      console.log(`Prepared ${pack + 1}/${packs} packs`);
    }
  }
  const packDirectory = path.join(receiver, ".git", "objects", "pack");
  const names = await fs.readdir(packDirectory);
  for (const name of names.filter((entry) => entry.endsWith(".pack"))) {
    await fs.writeFile(path.join(packDirectory, name.replace(/\.pack$/, ".promisor")), "");
  }
  // This physically local commit is not promised. Fetch's connectivity fast path
  // therefore falls back to excluding every promised object from a full walk.
  const targetText = commitText
    .replace(`tree ${emptyTree}\n`, `tree ${emptyTree}\nparent ${initial}\n`)
    .replace("Synthetic\n", "Existing local commit\n");
  const target = await git(receiver, ["hash-object", "-t", "commit", "-w", "--stdin"], targetText);
  assert.equal(
    await git(remote, ["hash-object", "-t", "commit", "-w", "--stdin"], targetText),
    target,
  );
  await git(remote, ["update-ref", "refs/heads/main", target]);
  await fs.writeFile(
    path.join(receiver, ".git", "packed-refs"),
    "# pack-refs with: peeled fully-peeled sorted\n" +
      Array.from(
        { length: refs },
        (_, i) => `${target} refs/remotes/origin/pr-${String(i).padStart(5, "0")}\n`,
      ).join(""),
  );
  const metadata = {
    target,
    initial,
    packs: names.filter((name) => name.endsWith(".pack")).length,
    blobs: packs * blobs,
    refs,
    payloadBytes: packs * blobs * 32,
  };
  await fs.writeFile(path.join(fixture, "fixture.json"), JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify(metadata));
} else {
  assert(values.output, "--output is required");
  const output = path.resolve(values.output);
  await fs.mkdir(output);
  const metadata = JSON.parse(await fs.readFile(path.join(fixture, "fixture.json"), "utf8")) as {
    target: string;
  };
  const ownerFile = path.join(
    path.resolve(values.revision),
    "src/gateway/github-publication-git-transport.ts",
  );
  const ownerSha256 = createHash("sha256")
    .update(await fs.readFile(ownerFile))
    .digest("hex");
  const owner = (await import(
    pathToFileURL(ownerFile).href
  )) as typeof import("../../src/gateway/github-publication-git-transport.js");
  const metrics: unknown[] = [];
  let commandIndex = 0;
  const command = async (
    argv: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      input?: string | Buffer | (() => string | Buffer);
    } = {},
  ) => {
    assert.equal(argv[0], "git");
    const id = commandIndex++;
    const trace = path.join(output, `command-${id}.trace.jsonl`);
    const safeArgs = argv.map((arg) =>
      arg === "https://github.com/synthetic/fixture.git" ? pathToFileURL(remote).href : arg,
    );
    const started = performance.now();
    const result = await run(
      ["/usr/bin/time", ...(process.platform === "darwin" ? ["-l"] : ["-v"]), ...safeArgs],
      options.cwd ?? receiver,
      typeof options.input === "function" ? options.input() : options.input,
      { ...env, ...options.env, GIT_TRACE2_EVENT: trace },
    );
    const elapsedMs = performance.now() - started;
    await fs.writeFile(path.join(output, `command-${id}.time.txt`), result.stderr);
    const timing = result.stderr.toString();
    const rss =
      process.platform === "darwin"
        ? Number(/(\d+)\s+maximum resident set size/.exec(timing)?.[1])
        : Number(/Maximum resident set size \(kbytes\): (\d+)/.exec(timing)?.[1]) * 1024;
    const cpu =
      process.platform === "darwin" ? /([\d.]+)\s+user\s+([\d.]+)\s+sys/.exec(timing) : undefined;
    const cpuSeconds = cpu
      ? Number(cpu[1]) + Number(cpu[2])
      : Number(/User time \(seconds\): ([\d.]+)/.exec(timing)?.[1]) +
        Number(/System time \(seconds\): ([\d.]+)/.exec(timing)?.[1]);
    const events = (await fs.readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { event: string; argv?: string[]; t_rel?: number; child_id?: number },
      );
    const connectivity = events.filter(
      (event) =>
        event.event === "child_start" && event.argv?.includes("--exclude-promisor-objects"),
    );
    metrics.push({
      id,
      argv: safeArgs,
      elapsedMs,
      rssBytes: rss,
      cpuSeconds,
      connectivityChildren: connectivity.length,
      hostLoad: os.loadavg(),
    });
    return {
      ...result,
      termination: "exit" as const,
      signal: null,
      killed: false,
    };
  };
  const samples = integer(values.samples);
  const connectivityArgs =
    values.mode === "connectivity" && values.trace
      ? (await fs.readFile(path.resolve(values.trace), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
          .find(
            (event) =>
              event.event === "child_start" && event.argv?.includes("--exclude-promisor-objects"),
          )?.argv
      : undefined;
  if (values.mode === "connectivity") {
    assert(connectivityArgs, "--trace must contain a connectivity child");
  }
  const runs = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    if (connectivityArgs) {
      const result = await command(connectivityArgs, { input: `${metadata.target}\n` });
      assert.equal(result.code, 0, result.stderr.toString());
    } else {
      await owner.requireGitHubPublicationCommit(
        command,
        "synthetic/fixture",
        metadata.target,
        "github.com",
        receiver,
        env,
        "Synthetic fetch failed",
      );
    }
    runs.push({ sample, elapsedMs: performance.now() - start });
  }
  const summary = {
    fixture: metadata,
    ownerSha256,
    measuredAt: new Date().toISOString(),
    mode: values.mode,
    gitVersion: await git(receiver, ["--version"]),
    revision: path.resolve(values.revision),
    runs,
    commands: metrics,
  };
  await fs.writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
