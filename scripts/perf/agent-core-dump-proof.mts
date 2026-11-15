/**
 * Isolated Linux core-limit proof at the production process owner. Never run on a
 * production host: requires core_pattern=core and writes temporary synthetic cores.
 * Prepare frozen bundles locally (esbuild uses the current dependency installation):
 *   node scripts/perf/agent-core-dump-proof.mts --prepare /proof/base --revision HEAD
 *   node scripts/perf/agent-core-dump-proof.mts --prepare /proof/head
 * In each prepared directory install task-only @openclaw/proc-safe@0.4.2
 * with npm --ignore-scripts, then mount /proof into
 * disposable node:26.12.1-bookworm with --ulimit core=-1 --memory=1g --pids-limit=128.
 *   node agent-core-dump-proof.mts --compare /proof/base --candidate /proof/head
 *
 * Five serial AB/BA and A/A pairs; healthy first-owner and later abort calls stay
 * separate. Acceptance: candidate agent+descendant limits/core bytes are zero,
 * internal helpers and parent retain positive limits. Report timing/CPU/allocation
 * ranges, including regressions. CPU/allocation cover the host isolate only, not
 * anchor/prlimit/command processes. This is not full-Gateway or production-scale proof:
 * the spawn owner reads neither the agent database nor the workspace inventory.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    prepare: { type: "string" },
    revision: { type: "string" },
    compare: { type: "string" },
    candidate: { type: "string" },
    run: { type: "string" },
    samples: { type: "string", default: "5" },
  },
});
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
if (values.prepare) {
  const root = process.cwd(),
    directory = path.resolve(values.prepare);
  fs.mkdirSync(directory, { recursive: true });
  const revision = execFileSync("git", ["rev-parse", values.revision ?? "HEAD"], {
    encoding: "utf8",
  }).trim();
  const originals = new Map<string, string>();
  if (values.revision) {
    assert.equal(
      execFileSync("git", ["diff", revision, "--", "pnpm-lock.yaml"], { encoding: "utf8" }),
      "",
      "Prepare revisions with matching dependencies",
    );
    assert.equal(
      execFileSync("git", ["diff", "--diff-filter=D", "--name-only", revision, "--", "src"], {
        encoding: "utf8",
      }),
      "",
      "Use a separate checkout to prepare a revision with deleted source files",
    );
    for (const name of execFileSync(
      "git",
      ["diff", "--diff-filter=M", "--name-only", revision, "--", "src"],
      {
        encoding: "utf8",
      },
    )
      .trim()
      .split("\n")
      .filter(Boolean)) {
      originals.set(
        path.join(root, name),
        execFileSync("git", ["show", `${revision}:${name}`], { encoding: "utf8" }),
      );
    }
  }
  const { build } = await import("esbuild");
  const options = {
    bundle: true,
    platform: "node" as const,
    format: "esm" as const,
    external: ["*.node", "@openclaw/proc-safe", "@openclaw/proc-safe/*", "@lydell/node-pty"],
    define: { WORKER_DEPLOY_BUILD: "false" },
    banner: {
      js: 'import {createRequire as __createRequire} from "node:module"; const require = __createRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "frozen-revision",
        setup(builder: import("esbuild").PluginBuild) {
          builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, ({ path: file }) =>
            originals.has(file)
              ? { contents: originals.get(file), loader: "ts", resolveDir: path.dirname(file) }
              : undefined,
          );
        },
      },
    ],
  };
  const artifacts: Record<string, string> = {};
  const entry = `export {createProcessSupervisor} from ${JSON.stringify(path.join(root, "src/process/supervisor/supervisor.ts"))};`;
  const fixture = "dist/fixture.mjs";
  await build({
    ...options,
    stdin: { contents: entry, resolveDir: root },
    outfile: path.join(directory, fixture),
  });
  for (const source of [
    "process/supervisor/service-child-group-anchor",
    "process/supervisor/service-child-relay",
  ]) {
    const output = `dist/${source}.js`;
    await build({
      ...options,
      entryPoints: [`src/${source}.ts`],
      outfile: path.join(directory, output),
    });
    artifacts[output] = hash(fs.readFileSync(path.join(directory, output)));
  }
  artifacts[fixture] = hash(fs.readFileSync(path.join(directory, fixture)));
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  fs.writeFileSync(
    path.join(directory, "source.json"),
    JSON.stringify({ revision, workingTree: !values.revision, artifacts }, null, 2),
  );
  console.log(JSON.stringify({ directory, revision, artifacts }));
  process.exit(0);
}

assert.equal(process.platform, "linux");
assert.equal(
  fs.readFileSync("/proc/sys/kernel/core_pattern", "utf8").trim(),
  "core",
  "Use a disposable Linux host with cwd-local direct cores",
);
if (values.compare) {
  assert(values.candidate);
  const samples = Number(values.samples);
  assert(Number.isInteger(samples) && samples >= 5);
  for (const series of ["ab", "aa"]) {
    for (let round = 0; round < samples; round++) {
      const pair: string[] =
        series === "aa"
          ? [values.compare, values.compare]
          : round % 2
            ? [values.candidate, values.compare]
            : [values.compare, values.candidate];
      for (let slot = 0; slot < pair.length; slot++) {
        const output = execFileSync(
          process.execPath,
          [fileURLToPath(import.meta.url), "--run", pair[slot]!],
          { encoding: "utf8", timeout: 60_000 },
        );
        const report = JSON.parse(output);
        for (const row of report.rows) {
          const limited: boolean =
            pair[slot] === values.candidate && row.executionIntent === "agent-tool";
          assert.deepEqual(row.own, limited ? ["0", "0"] : report.parent);
          assert.equal(row.argv0, "core-limit-fixture");
          if (limited) {
            assert.deepEqual(row.descendant, ["0", "0"]);
          } else {
            assert(
              row.descendant.every((value: string) => value === "unlimited" || Number(value) > 0),
            );
          }
          assert.equal(row.coreBytes > 0, row.abort && !limited);
        }
        console.log(JSON.stringify({ series, round, slot, ...report }));
      }
    }
  }
  process.exit(0);
}
assert(values.run, "Select --prepare, --compare or --run");
const directory = path.resolve(values.run);
const source = JSON.parse(fs.readFileSync(path.join(directory, "source.json"), "utf8"));
for (const [file, digest] of Object.entries(source.artifacts)) {
  assert.equal(hash(fs.readFileSync(path.join(directory, file))), digest);
}
// Prepared artifacts export the unmodified production owners, not test substitutes.
const api: Pick<
  typeof import("../../src/process/supervisor/supervisor.js"),
  "createProcessSupervisor"
> = await import(pathToFileURL(path.join(directory, "dist/fixture.mjs")).href);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-core-proof-"));
process.env.OPENCLAW_STATE_DIR = temporary;
process.env.OPENCLAW_SERVICE_MARKER = "core-proof";
const limits = (pid = process.pid): string[] =>
  fs
    .readFileSync(`/proc/${pid}/limits`, "utf8")
    .match(/^Max core file size\s+(\S+)\s+(\S+)/mu)!
    .slice(1);
const parent = limits();
assert(
  parent.every((value) => value === "unlimited" || Number(value) > 0),
  "Seed a positive parent core limit",
);
const childCode = `const fs=require('node:fs');const cp=require('node:child_process');const own=fs.readFileSync('/proc/self/limits','utf8').match(/^Max core file size\\s+(\\S+)\\s+(\\S+)/m).slice(1);const descendant=cp.execFileSync('/bin/sh',['-c','ulimit -Sc; ulimit -Hc'],{encoding:'utf8'}).trim().split('\\n');console.log(JSON.stringify({own,descendant,argv0:process.argv0}));`;
const rows = [];
try {
  const supervisor = api.createProcessSupervisor();
  try {
    for (const abort of [false, true]) {
      for (const executionIntent of ["agent-tool", "gateway-internal"] as const) {
        const cwd = path.join(temporary, `${abort}-${executionIntent}`);
        fs.mkdirSync(cwd);
        const cpu = process.cpuUsage(),
          allocated = getHeapStatistics().total_allocated_bytes,
          started = performance.now();
        const run = await supervisor.spawn({
          mode: "child",
          runId: `${abort}-${executionIntent}`,
          executionIntent,
          argv: [
            process.execPath,
            "-e",
            `globalThis.payload=Buffer.alloc(16*1024*1024,0x5a);${childCode}${abort ? "process.abort();" : ""}`,
          ],
          argv0: "core-limit-fixture",
          exactEnv: true,
          env: process.env,
          cwd,
          timeoutMs: 20_000,
        });
        const result = await run.wait();
        await run.waitForExtinction?.();
        const elapsedMs = performance.now() - started,
          used = process.cpuUsage(cpu);
        const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocated;
        assert.equal(result.exitCode, abort ? null : 0, result.stderr);
        assert.equal(result.exitSignal, abort ? "SIGABRT" : null, result.stderr);
        const cores = fs.readdirSync(cwd).filter((name) => name.startsWith("core"));
        const coreBytes = cores.reduce(
          (sum, name) => sum + fs.statSync(path.join(cwd, name)).size,
          0,
        );
        rows.push({
          abort,
          executionIntent,
          elapsedMs,
          cpuMs: (used.user + used.system) / 1000,
          allocatedBytes,
          coreBytes,
          ...JSON.parse(result.stdout),
        });
        for (const name of cores) {
          fs.unlinkSync(path.join(cwd, name));
        }
      }
    }
  } finally {
    await supervisor.shutdown();
  }
  assert.deepEqual(limits(), parent);
  console.log(
    JSON.stringify({
      directory,
      source,
      node: process.version,
      arch: process.arch,
      load: os.loadavg(),
      parent,
      rows,
    }),
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
