import { spawnSync } from "node:child_process";
// Synthetic Git-only benchmark; run: node --import ./scripts/tsx.mjs scripts/perf/agent-git-probes.mts --scratch-parent <directory>
// Historical blobs: add --history-blobs --commits 600 --baseline-shim <saved-shim>;
// --aa-only/--ab-only split controls from comparisons; --warm hydrates before measurement.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AGENT_GIT_SHIM } from "../../src/infra/agent-git-shim.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "scratch-parent": { type: "string" },
    files: { type: "string" },
    commits: { type: "string" },
    samples: { type: "string" },
    "shared-shallow": { type: "boolean" },
    "history-blobs": { type: "boolean" },
    "aa-only": { type: "boolean" },
    "ab-only": { type: "boolean" },
    "allocation-preload": { type: "string" },
    warm: { type: "boolean" },
    "baseline-shim": { type: "string" },
  },
});
if (!values["scratch-parent"]) {
  throw new Error("--scratch-parent is required; only the new child directory is removed");
}
const integer = (name: "files" | "commits" | "samples", fallback: number) =>
  parseStrictIntegerOption({ raw: values[name] ?? "", label: `--${name}`, fallback, min: 1 });
const files = integer("files", 62_000);
const commits = integer("commits", 20_000);
const samples = integer("samples", 5);
const sharedShallow = values["shared-shallow"] === true;
const historyBlobs = values["history-blobs"] === true;
const baselineShimPath = values["baseline-shim"] ?? "";
if (sharedShallow && (!baselineShimPath || commits < 4010)) {
  throw new Error("--shared-shallow requires --baseline-shim and at least 4010 commits");
}
if (historyBlobs && (!baselineShimPath || sharedShallow)) {
  throw new Error("--history-blobs requires --baseline-shim and excludes --shared-shallow");
}
if (values["aa-only"] && values["ab-only"]) {
  throw new Error("--aa-only and --ab-only are mutually exclusive");
}
const root = mkdtempSync(path.join(values["scratch-parent"], "agent-git-probes-"));
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.platform() === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "gc.auto",
  GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "maintenance.auto",
  GIT_CONFIG_VALUE_1: "false",
};
const git = (cwd: string, args: string[], input?: string) => {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    env,
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]}: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout.trim();
};
type Sample = {
  lane: string;
  wallMs: number;
  cpuMs: number;
  maxRssBytes: number;
  packBytes: number;
  offeredObjects: number;
  fetchChildren: number;
  gitStarts: number;
  transports: number;
  shallowChanged: number;
  exitCode: number | null;
  hint: boolean;
  newPacks: number;
  newPromisorPacks: number;
  outputSha256: string;
  allocationCalls: number;
  allocationRequestedBytes: number;
  load: number[];
};
const rows: Sample[] = [];
const origin = path.join(root, "origin.git");
const template = path.join(root, "template");
const workspace = path.join(root, "workspace");
const bin = path.join(root, "bin");
const baselineBin = path.join(root, "baseline-bin");
const report = (message: string) => process.stderr.write(`${message}\n`);
try {
  report(`Fixture: ${files} files, ${commits} history commits; ${root}`);
  mkdirSync(bin);
  writeFileSync(path.join(bin, "git"), AGENT_GIT_SHIM, { mode: 0o755 });
  if (sharedShallow || historyBlobs) {
    mkdirSync(baselineBin);
    writeFileSync(path.join(baselineBin, "git"), readFileSync(baselineShimPath), { mode: 0o755 });
  }
  git(root, ["init", "--bare", "--initial-branch=main", origin]);
  git(origin, ["config", "uploadpack.allowFilter", "true"]);
  git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const content = "synthetic workspace content\n".padEnd(18_000, "x");
  let input = `blob\nmark :1\ndata ${Buffer.byteLength(content)}\n${content}\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ndata 4\nbase\n`;
  for (let index = 0; index < files; index++) {
    input += `M 100644 :1 files/${Math.floor(index / 1000)}/file-${index}.txt\n`;
  }
  input += "\n";
  let history = "";
  for (let index = 0; index < commits; index++) {
    history = historyBlobs ? `${history}history ${index}\n` : `history ${index}\n`;
    const text = history;
    input += `commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> ${1700000001 + index} +0000\ndata 7\nhistory\nM 100644 inline history.txt\ndata ${text.length}\n${text}\n`;
  }
  git(origin, ["fast-import", "--quiet"], input);
  git(origin, ["repack", "-adq"]);
  git(root, [
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    ...(sharedShallow ? ["--depth=10"] : []),
    pathToFileURL(origin).href,
    template,
  ]);
  const base = git(template, ["rev-parse", "HEAD"]);
  // One materialized production-sized workspace; each sample gets isolated private Git metadata.
  git(root, ["clone", "--local", origin, workspace]);
  const next = "new tip\n";
  git(
    origin,
    ["fast-import", "--quiet"],
    `commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1800000000 +0000\ndata 3\nnew\nfrom ${base}\nM 100644 inline history.txt\ndata ${next.length}\n${next}\n`,
  );
  const missing = git(origin, ["rev-parse", "HEAD"]);
  const sample = (
    lane: string,
    guarded: boolean,
    args: string[],
    expectedCode: number,
    extraEnv: NodeJS.ProcessEnv = {},
  ) => {
    const index = rows.length;
    const metadata = path.join(root, `sample-${index}.git`);
    cpSync(path.join(template, ".git"), metadata, { recursive: true });
    let gitDir = metadata;
    const shallowFile = path.join(metadata, "shallow");
    const shallowBefore = existsSync(shallowFile) ? readFileSync(shallowFile, "utf8") : "";
    if (sharedShallow || historyBlobs) {
      const linked = path.join(root, `linked-${index}`);
      git(root, [
        "--git-dir",
        metadata,
        "worktree",
        "add",
        "--detach",
        "--no-checkout",
        linked,
        "HEAD",
      ]);
      gitDir = git(linked, ["rev-parse", "--absolute-git-dir"]);
    }
    if (historyBlobs && values.warm) {
      const missingBlobs = git(root, [
        "--git-dir",
        gitDir,
        "rev-list",
        "--objects",
        "--missing=print",
        "HEAD",
        "--",
        "history.txt",
      ])
        .split("\n")
        .filter((line) => line.startsWith("?"))
        .map((line) => line.slice(1));
      git(
        root,
        [
          "--git-dir",
          gitDir,
          "-c",
          "fetch.negotiationAlgorithm=noop",
          "fetch",
          "--quiet",
          "--filter=blob:none",
          "--no-auto-maintenance",
          "--no-tags",
          "--no-write-fetch-head",
          "origin",
          "--stdin",
        ],
        `${missingBlobs.join("\n")}\n`,
      );
    }
    const trace = path.join(root, `trace-${index}.jsonl`);
    const packTrace = path.join(root, `trace-${index}.pack`);
    const allocationLog = path.join(root, `allocations-${index}.jsonl`);
    const packsBefore = new Set(readdirSync(path.join(metadata, "objects/pack")));
    const sampleEnv = {
      ...env,
      PATH:
        guarded || sharedShallow || historyBlobs
          ? `${guarded ? bin : baselineBin}${path.delimiter}${env.PATH}`
          : env.PATH,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: workspace,
      GIT_TRACE2_EVENT: trace,
      GIT_TRACE_PACKFILE: packTrace,
      ...(values["allocation-preload"]
        ? {
            LD_PRELOAD: values["allocation-preload"],
            OPENCLAW_ALLOC_TARGET: "git",
            OPENCLAW_ALLOC_LOG: allocationLog,
          }
        : {}),
      ...extraEnv,
    };
    const load = os.loadavg();
    const started = performance.now();
    const result = spawnSync(
      "/usr/bin/time",
      [process.platform === "darwin" ? "-l" : "-v", "git", ...args],
      { cwd: workspace, env: sampleEnv, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const wallMs = performance.now() - started;
    if (result.status !== expectedCode) {
      throw new Error(`${lane}: exit ${result.status}, expected ${expectedCode}: ${result.stderr}`);
    }
    const events = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { event?: string; argv?: string[]; key?: string; value?: string },
      );
    const time = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(result.stderr);
    const user = /User time \(seconds\): ([\d.]+)/.exec(result.stderr);
    const system = /System time \(seconds\): ([\d.]+)/.exec(result.stderr);
    const rss =
      /([\d]+)\s+maximum resident set size/.exec(result.stderr) ??
      /Maximum resident set size \(kbytes\): (\d+)/.exec(result.stderr);
    const allocations = existsSync(allocationLog)
      ? readFileSync(allocationLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { calls: number; requestedBytes: number })
      : [];
    if (values["allocation-preload"] && allocations.length === 0) {
      throw new Error("Allocation preload produced no Git process receipts");
    }
    const row: Sample = {
      lane,
      wallMs,
      cpuMs: time
        ? (Number(time[2]) + Number(time[3])) * 1000
        : (Number(user?.[1]) + Number(system?.[1])) * 1000,
      maxRssBytes: Number(rss?.[1]) * (process.platform === "darwin" ? 1 : 1024),
      packBytes: existsSync(packTrace) ? statSync(packTrace).size : 0,
      offeredObjects: events
        .filter((event) => event.event === "data" && event.key === "write_pack_file/wrote")
        .reduce((sum, event) => sum + Number(event.value), 0),
      fetchChildren: events.filter(
        (event) => event.event === "child_start" && event.argv?.includes("fetch"),
      ).length,
      gitStarts: events.filter((event) => event.event === "start").length,
      transports: events.filter(
        (event) =>
          event.event === "child_start" && event.argv?.some((arg) => arg.includes("upload-pack")),
      ).length,
      shallowChanged: Number(
        shallowBefore !== (existsSync(shallowFile) ? readFileSync(shallowFile, "utf8") : ""),
      ),
      exitCode: result.status,
      hint: result.stderr.includes("OpenClaw:"),
      newPacks: readdirSync(path.join(metadata, "objects/pack")).filter(
        (name) => name.endsWith(".pack") && !packsBefore.has(name),
      ).length,
      newPromisorPacks: readdirSync(path.join(metadata, "objects/pack")).filter(
        (name) => name.endsWith(".promisor") && !packsBefore.has(name),
      ).length,
      outputSha256: createHash("sha256").update(result.stdout).digest("hex"),
      allocationCalls: allocations.reduce((sum, receipt) => sum + receipt.calls, 0),
      allocationRequestedBytes: allocations.reduce(
        (sum, receipt) => sum + receipt.requestedBytes,
        0,
      ),
      load,
    };
    rows.push(row);
    report(
      `${lane}: ${wallMs.toFixed(1)} ms; ${row.offeredObjects} objects; ${row.packBytes} pack bytes`,
    );
    rmSync(metadata, { recursive: true });
    return row;
  };
  if (historyBlobs) {
    report(
      "Rule: identical output and object counts; many promisor packs become one; lower wall/CPU without >20% regression. A/A controls use the baseline shim twice.",
    );
    for (const command of ["log", "blame"]) {
      const args =
        command === "log"
          ? ["log", "-p", "--format=%H", "HEAD", "--", "history.txt"]
          : ["blame", "--line-porcelain", "HEAD", "--", "history.txt"];
      for (const control of values["aa-only"]
        ? [true]
        : values["ab-only"]
          ? [false]
          : [true, false]) {
        for (let index = 0; index < samples; index++) {
          const runSample = (candidate: boolean) =>
            sample(
              `${command}-${control ? "AA" : "AB"}-${candidate ? "B" : "A"}`,
              candidate && !control,
              args,
              0,
            );
          const first = runSample(index % 2 === 1);
          const second = runSample(index % 2 === 0);
          if (first.outputSha256 !== second.outputSha256) {
            throw new Error(`${command}: baseline and candidate output differs`);
          }
        }
      }
    }
  } else if (sharedShallow) {
    report(
      "Rule: shared shallow writes and transport 1→0; normal commands add no Git starts; disclose A/A timing controls",
    );
    for (let index = 0; index < samples; index++) {
      const args = ["fetch", "-q", "--deepen=4000", "origin", "main"];
      const before = sample("deepen-baseline", false, args, 0);
      const after = sample("deepen-guarded", true, args, 2);
      if (
        before.shallowChanged !== 1 ||
        before.transports !== 1 ||
        before.offeredObjects < 4000 ||
        after.shallowChanged !== 0 ||
        after.transports !== 0 ||
        after.packBytes !== 0 ||
        !after.hint
      ) {
        throw new Error("Shared shallow boundary contract failed");
      }
      const control = ["fetch", "-q", "origin", "main"];
      const a1 = sample("fetch-A1", false, control, 0);
      const a2 = sample("fetch-A2", false, control, 0);
      const b = sample("fetch-guarded", true, control, 0);
      if (
        a1.shallowChanged ||
        a2.shallowChanged ||
        b.shallowChanged ||
        a1.gitStarts !== b.gitStarts
      ) {
        throw new Error("Normal fetch changed its boundary or added Git starts");
      }
    }
  } else {
    report("Fixture prepared; interleaved absent-object samples");
    for (let index = 0; index < samples; index++) {
      const before = sample("missing-baseline", false, ["cat-file", "-t", missing], 0);
      const after = sample("missing-guarded", true, ["cat-file", "-t", missing], 128);
      if (
        before.fetchChildren !== 1 ||
        before.offeredObjects < commits ||
        after.fetchChildren !== 0 ||
        after.packBytes !== 0 ||
        !after.hint
      ) {
        throw new Error("Missing-object count contract failed");
      }
    }
    for (let index = 0; index < samples; index++) {
      sample("present-A1", false, ["cat-file", "-t", base], 0);
      sample("present-A2", false, ["cat-file", "-t", base], 0);
      sample("present-guarded", true, ["cat-file", "-t", base], 0);
      sample("blob-baseline", false, ["show", "HEAD:files/0/file-0.txt"], 0);
      sample("blob-guarded", true, ["show", "HEAD:files/0/file-0.txt"], 0);
      sample(
        "explicit-guarded",
        true,
        ["fetch", "origin", missing, "--negotiation-tip=origin/main"],
        0,
      );
    }
    for (const [name, args] of [
      ["show", ["show", "HEAD~1:history.txt"]],
      ["log", ["log", "-p", "-2", "--", "history.txt"]],
      ["blame", ["blame", "HEAD", "--", "history.txt"]],
      ["diff", ["diff", "HEAD~1", "HEAD", "--", "history.txt"]],
    ] as const) {
      const disabled = sample(`global-no-lazy-${name}`, false, [...args], 128, {
        GIT_NO_LAZY_FETCH: "1",
      });
      if (disabled.fetchChildren !== 0 || disabled.packBytes !== 0) {
        throw new Error("Global no-lazy control fetched objects");
      }
      sample(`history-guarded-${name}`, true, [...args], 0);
    }
  }
  const stats = (numbers: number[]) => {
    const sorted = numbers.toSorted((left, right) => left - right);
    return {
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      min: sorted[0],
      max: sorted.at(-1),
    };
  };
  const lanes = [...new Set(rows.map((row) => row.lane))];
  const summary = Object.fromEntries(
    lanes.map((lane) => [
      lane,
      Object.fromEntries(
        (
          [
            "wallMs",
            "cpuMs",
            "maxRssBytes",
            "packBytes",
            "offeredObjects",
            "fetchChildren",
            "gitStarts",
            "transports",
            "shallowChanged",
            "newPacks",
            "newPromisorPacks",
            "allocationCalls",
            "allocationRequestedBytes",
          ] as const
        ).map((metric) => [
          metric,
          stats(rows.filter((row) => row.lane === lane).map((row) => row[metric])),
        ]),
      ),
    ]),
  );
  process.stdout.write(
    JSON.stringify(
      {
        gitVersion: git(root, ["--version"]),
        mode: historyBlobs ? "history-blobs" : sharedShallow ? "shared-shallow" : "missing-commit",
        warm: values.warm === true,
        allocationInstrumented: Boolean(values["allocation-preload"]),
        baselineShimSha256:
          sharedShallow || historyBlobs
            ? createHash("sha256").update(readFileSync(baselineShimPath)).digest("hex")
            : undefined,
        shimSha256: createHash("sha256").update(AGENT_GIT_SHIM).digest("hex"),
        platform: process.platform,
        files: files + 1,
        workingTreeBytes: files * content.length + history.length,
        commits: commits + 1,
        samples,
        summary,
        rows,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
