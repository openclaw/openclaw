import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCompilerNetworkIsolation,
  type CompilerNetworkEvidence,
} from "./compiler-comparison-io.mts";
import { toErrorObject } from "./error-format.mts";
import { TSGO_ROOT_TEST_SHARDS, selectTsgoCoreTestStripe } from "./tsgo-core-test-shards.mts";

export const COMPILER_ROW_POLICY = "canonical-ci-rows-cold-v1";
export const COMPILER_ROW_WORKLOAD = "37ceb90e289b181af83c0c58a74caa1dceec2a5a";
export const COMPILER_ROW_IDENTITIES = {
  pinned: "2330ea6c0951273da91489db91af768d214f93c71583a377a327363a6828e72e",
  candidate: "9785e87da1650d3a4007d234bc194c63b640524c010497884e4b93161c7bb149",
  libraries: "b13ee3a64a0d52a1bffd5b509cdfd56552444b4295dd258463edf46cb58e9133",
  wrapper: "8ff26785a0042e14e5fe042a6cc3f74ebef5a7d4b9a3c42b3a187ed5f26d6d10",
  overlay: "279fbb41c651acb70ac6c9edd43bc9cb48e7adcfaee25bc176ef7af576e9729e",
  lockfile: "077de03581fe84798f14e0ff246a93e97bf3a3668a111cd2c74e968294f7e32f",
} as const;
export const COMPILER_ROW_LIMITS = {
  memoryBytes: 24 * 1024 ** 3,
  swapBytes: 0,
  artifactBytes: 256 * 1024 ** 2,
  cacheFileBytes: 32 * 1024 ** 2,
  outputBytes: 32 * 1024 ** 2,
  temporaryBytes: 64 * 1024 ** 2,
} as const;
export type RowCompiler = "pinned" | "candidate";
type Graph = { name: string; config: string; cache: string };
export type CompilerRow = {
  name: string;
  command: string[];
  graphs: Graph[];
  concurrency: number;
  timeoutMs: number;
};
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const shell = (body: string) => ["bash", "-euo", "pipefail", "-c", body];

/** Stage authenticated package-manager code and the process-owner's ps closure. */
export function prepareCompilerRowRuntime(root: string, destination: string) {
  const run = (bin: string, args: string[]) => {
    const result = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    assert(!result.error && result.status === 0, "Row runtime staging failed");
    return result.stdout;
  };
  fs.mkdirSync(destination);
  fs.mkdirSync(path.join(destination, "bin"));
  fs.copyFileSync(process.execPath, path.join(destination, "bin/node"));
  const archives = [
    [
      "pnpm-12.11.1.tgz",
      "5b0e3288239a7ea4155d2094f547066e122a1376b3cd785a680c9112e116913e64aaaecf20dd83cc34030fa67013f5c5511f9cf430dd8384188b4c60b8a2ad1e",
      "pnpm",
    ],
    [
      "exe.linux-x64-12.11.1.tgz",
      "73b921d30b63834e629f6c249a7e9faecfed722b9a1b0f1735952e82047cf26bd4be627cd63b023f532933ce704c5129b5d781e0e9e5446d0449465bbb8f6af1",
      "pnpm/node_modules/@pnpm/exe.linux-x64",
    ],
  ] as const;
  for (const [name, sha512, target] of archives) {
    const archive = path.join(
      process.env.PNPM_CONFIG_STORE_DIR ?? path.join(root, ".cache/openclaw-pnpm-store"),
      "toolchain",
      name,
    );
    assert.equal(
      createHash("sha512").update(fs.readFileSync(archive)).digest("hex"),
      sha512,
      "Unexpected pnpm distribution",
    );
    const directory = path.join(destination, target);
    fs.mkdirSync(directory, { recursive: true });
    run("tar", ["-xzf", archive, "--strip-components=1", "-C", directory]);
  }
  // No Corepack cache, user npmrc, credentials, or writable package-manager state
  // enters the container. Its packageManager pin resolves to this staged code.
  fs.writeFileSync(
    path.join(destination, "bin/pnpm"),
    '#!/bin/sh\nexec /proof-node /row-runtime/pnpm/bin/pnpm.mjs "$@"\n',
    { mode: 0o755, flag: "wx" },
  );
  fs.copyFileSync("/usr/bin/ps", path.join(destination, "ps-bin"));
  const closure = run("ldd", ["/usr/bin/ps"]);
  assert(!closure.includes("not found"));
  const libraries = closure.split("\n").flatMap((line) => {
    const match = /^\s*(?:\S+ => )?(\/\S+) \(0x[0-9a-f]+\)\s*$/u.exec(line);
    if (match) {
      return [match[1]!];
    }
    assert(line.trim() === "" || /^\s*linux-vdso\.so\./u.test(line), "Unrecognized ps dependency");
    return [];
  });
  assert(
    libraries.length > 0 &&
      new Set(libraries.map((file) => path.basename(file))).size === libraries.length,
  );
  const loader = libraries.find((file) => path.basename(file) === "ld-linux-x86-64.so.2");
  assert(loader, "Missing trusted ps ELF loader");
  fs.mkdirSync(path.join(destination, "ps-libs"));
  for (const file of libraries) {
    const real = fs.realpathSync(file);
    assert(
      real.startsWith("/usr/lib/") || real.startsWith("/lib/"),
      "Unexpected host library location",
    );
    fs.copyFileSync(file, path.join(destination, "ps-libs", path.basename(file)));
  }
  fs.writeFileSync(
    path.join(destination, "bin/ps"),
    '#!/bin/sh\nexec /row-runtime/ps-libs/ld-linux-x86-64.so.2 --library-path /row-runtime/ps-libs /row-runtime/ps-bin "$@"\n',
    { mode: 0o755, flag: "wx" },
  );
  const files = fs
    .readdirSync(destination, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return { name: path.relative(destination, file), sha256: digest(fs.readFileSync(file)) };
    })
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return {
    nodeVersion: process.version,
    pnpmVersion: "12.11.1",
    user: { uid: process.getuid!(), gid: process.getgid!() },
    archives: archives.map(([name, sha512]) => ({ name, sha512 })),
    files,
    manifestSha256: digest(JSON.stringify(files)),
  };
}

/** Full canonical rows, with the existing inner scheduler and failure owners. */
export function compilerRowPlan(): CompilerRow[] {
  const graph = (name: string, config = `tsconfig.${name}.json`): Graph => ({
    name,
    config,
    cache: `.artifacts/tsgo-cache/${name === "core-test-packages" ? "test-packages" : name}.tsbuildinfo`,
  });
  return [
    {
      name: "prod-types",
      command: ["pnpm", "tsgo:prod"],
      graphs: [graph("core"), graph("ui"), graph("extensions")],
      concurrency: 1,
      timeoutMs: 20 * 60_000,
    },
    {
      name: "test-types",
      command: shell(
        "source scripts/ci-collect-checks.sh; " +
          "run_check extension-test-types pnpm tsgo:extensions:test; " +
          "run_check script-types pnpm tsgo:scripts; finish_checks",
      ),
      graphs: [
        graph("extensions-test", "test/tsconfig/tsconfig.extensions.test.json"),
        graph("scripts"),
      ],
      concurrency: 1,
      timeoutMs: 20 * 60_000,
    },
    ...Array.from({ length: 5 }, (_, index) => {
      const stripe = index + 1;
      const shards = selectTsgoCoreTestStripe(`${stripe}/5`);
      assert(shards);
      const root = index === 0 ? undefined : TSGO_ROOT_TEST_SHARDS[index - 1];
      return {
        name: `core-test-${stripe}`,
        command: shell(
          "source scripts/ci-static-step.sh tsgo; " +
            `run_static_check node scripts/run-tsgo-core-test-shards.mjs --stripe ${stripe}/5 --concurrency 2; ` +
            (root
              ? `run_static_check env OPENCLAW_LOCAL_CHECK=0 node scripts/run-tsgo-core-test-shards.mjs --root-stripe ${index}/4; `
              : "") +
            "finish_static_checks",
        ),
        graphs: [
          ...shards.map((shard) => graph(`core-test-${shard.name}`, shard.config)),
          ...(root ? [graph(root.name, root.config)] : []),
        ],
        concurrency: 2,
        timeoutMs: 15 * 60_000,
      };
    }),
  ];
}

/** Preserve the resolver's ownership check; only this experiment binds its result. */
export function compilerRowOverlay(source: string) {
  assert.equal(digest(source), COMPILER_ROW_IDENTITIES.wrapper, "Unexpected workload wrapper");
  const owner =
    'const tsgoPath = resolveRepoToolBinPath("tsgo", { cwd: findRepoRoot(cwd) ?? cwd });';
  assert.equal(source.split(owner).length, 2, "Compiler overlay must match one owner");
  return source.replace(
    owner,
    'resolveRepoToolBinPath("tsgo", { cwd: findRepoRoot(cwd) ?? cwd });\n  const tsgoPath = "/experiment/compiler/tsc";',
  );
}

export type RowCgroupSnapshot = {
  identity: { containerId: string; pid: number; device: number; inode: number; startTicks: string };
  frozen: true;
  supervisorOnly: true;
  hierarchical: true;
  childCgroups: 0;
  memoryBytes: number;
  swapBytes: number;
  cpuSet: string;
  oomGroup: 0;
  events: { oom: number; oom_kill: number; oom_group_kill: number };
};

/** A row cgroup owns every child; PID1's OOMKilled flag cannot certify them. */
export function assertCompilerRowCgroup(
  before: RowCgroupSnapshot,
  after: RowCgroupSnapshot,
  memoryBytes: number,
  cpuSet: string,
  expectedOom = false,
) {
  for (const state of [before, after]) {
    assert.equal(state.frozen, true, "Unfrozen process census");
    assert.equal(state.supervisorOnly, true, "Row descendants remain");
    assert.equal(state.hierarchical, true, "Local OOM counters cannot admit a subtree");
    assert.equal(state.childCgroups, 0, "Unexpected child cgroup");
    assert.equal(state.memoryBytes, memoryBytes);
    assert.equal(state.swapBytes, 0);
    assert.equal(state.cpuSet, cpuSet);
    assert.equal(state.oomGroup, 0);
    assert.match(state.identity.containerId, /^[a-f0-9]{64}$/u);
    assert(Number.isSafeInteger(state.identity.pid) && state.identity.pid > 1);
    assert(Number.isSafeInteger(state.identity.device) && state.identity.device >= 0);
    assert(Number.isSafeInteger(state.identity.inode) && state.identity.inode > 0);
    assert.match(state.identity.startTicks, /^\d+$/u);
    for (const key of ["oom", "oom_kill", "oom_group_kill"] as const) {
      assert(Number.isSafeInteger(state.events[key]) && state.events[key] >= 0);
      assert.equal(before.events[key], 0, "Container had an OOM before row admission");
      assert(after.events[key] >= before.events[key], "OOM counters moved backwards");
    }
  }
  assert.deepEqual(after.identity, before.identity, "Container cgroup or PID identity changed");
  if (expectedOom) {
    assert(after.events.oom > 0 && after.events.oom_kill > 0, "OOM smoke did not kill a child");
    assert.equal(after.events.oom_group_kill, 0, "OOM killed the supervisor group");
  } else {
    assert.deepEqual(after.events, before.events, "Row cgroup observed an OOM");
  }
}

export type RowTerminal = {
  processExitCode: number | null;
  processSignal: string | null;
  infrastructureError?: unknown;
  cleanupVerified: boolean;
  preCleanupState: unknown;
};

export function assertCompilerRowTerminal(receipt: RowTerminal, exitCode: number) {
  assert([0, 1, 2].includes(exitCode), "Invalid row exit");
  assert.equal(receipt.processExitCode, exitCode);
  assert.equal(receipt.processSignal, null);
  assert.equal(receipt.infrastructureError, undefined);
  assert.equal(receipt.cleanupVerified, true);
  assert.deepEqual(receipt.preCleanupState, {
    available: true,
    Status: "exited",
    Running: false,
    OOMKilled: false,
    ExitCode: exitCode,
  });
}

/** Frozen workload configurations must agree with the row owner's cache paths. */
export function verifyCompilerRowWorkload(root: string) {
  assert.equal(
    digest(fs.readFileSync(path.join(root, "pnpm-lock.yaml"))),
    COMPILER_ROW_IDENTITIES.lockfile,
  );
  for (const row of compilerRowPlan()) {
    for (const graph of row.graphs.filter((entry) => entry.config.startsWith("test/"))) {
      const config = JSON.parse(fs.readFileSync(path.join(root, graph.config), "utf8")) as {
        compilerOptions?: { tsBuildInfoFile?: string };
      };
      // The extension-test package command owns its explicit build-info argument.
      if (graph.name === "extensions-test") {
        continue;
      }
      assert.equal(
        path.relative(
          root,
          path.resolve(
            root,
            path.dirname(graph.config),
            config.compilerOptions?.tsBuildInfoFile ?? "",
          ),
        ),
        graph.cache,
        "Canonical graph cache path changed",
      );
    }
  }
}

export type CompilerRowFile = { path: string; bytes: number; sha256: string };
export type CompilerRowFiles = {
  mount: { device: number; inode: number };
  generated: CompilerRowFile[];
  cache: (CompilerRowFile & { fileNames: string[] })[];
  metrics: (CompilerRowFile & { text: string })[];
  totalBytes: number;
};
type RowFinish = {
  code: number | null;
  signal: string | null;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
};
export type CompilerRowObservation = {
  scratch?: { uid: number; gid: number; mode: number };
  before?: RowCgroupSnapshot;
  after?: RowCgroupSnapshot;
  beforeFiles?: CompilerRowFiles;
  files?: CompilerRowFiles;
  finish?: RowFinish;
};

/** Host-only controller; the container never receives cgroup writes or Docker access. */
export function compilerRowController({
  controlDirectory,
  cachePaths,
  memoryBytes,
  cpuSet,
  expectedOom = false,
  collectFiles = true,
}: {
  controlDirectory: string;
  cachePaths: string[];
  memoryBytes: number;
  cpuSet: string;
  expectedOom?: boolean;
  collectFiles?: boolean;
}) {
  const observation: CompilerRowObservation = {};
  const docker = (args: string[]) => {
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 65536,
    });
    assert(!result.error && result.status === 0, "Row lifecycle Docker operation failed");
    return result.stdout;
  };
  return {
    observation,
    async observe(name: string, child: ChildProcess) {
      let pending = "";
      let phase = "ready";
      let pid: number | undefined;
      let startTicks: string | undefined;
      const freeze = (initial: boolean) => {
        docker(["pause", name]);
        const inspected = JSON.parse(
          docker(["inspect", "--format", '{"id":{{json .Id}},"state":{{json .State}}}', name]),
        ) as {
          id: string;
          state: { Running: boolean; Paused: boolean; Pid: number };
        };
        assert.match(inspected.id, /^[a-f0-9]{64}$/u);
        const state = inspected.state;
        assert(state.Running && state.Paused && Number.isSafeInteger(state.Pid) && state.Pid > 1);
        if (pid !== undefined) {
          assert.equal(state.Pid, pid, "Docker PID identity changed");
        }
        pid = state.Pid;
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const currentStart = stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/u)[19];
        assert(currentStart);
        assert(
          startTicks === undefined || startTicks === currentStart,
          "Supervisor PID was reused",
        );
        startTicks = currentStart;
        const result = spawnSync(
          "python3",
          [fileURLToPath(new URL("./compiler-comparison-row-files.py", import.meta.url))],
          {
            input: JSON.stringify({
              pid,
              startTicks,
              initial,
              files: collectFiles,
              cachePaths,
              mount: observation.beforeFiles?.mount,
            }),
            encoding: "utf8",
            timeout: 15_000,
            maxBuffer: COMPILER_ROW_LIMITS.outputBytes,
          },
        );
        assert(
          !result.error && result.status === 0,
          `Frozen row observation failed: ${result.stderr.slice(-2048)}`,
        );
        const observed = JSON.parse(result.stdout) as {
          snapshot: RowCgroupSnapshot;
          files?: CompilerRowFiles;
        };
        observed.snapshot.identity.containerId = inspected.id;
        assert.equal(observed.snapshot.identity.pid, state.Pid);
        if (initial) {
          observation.before = observed.snapshot;
          observation.beforeFiles = observed.files;
          assertCompilerRowCgroup(observed.snapshot, observed.snapshot, memoryBytes, cpuSet);
        } else {
          observation.after = observed.snapshot;
          observation.files = observed.files;
          assert(observation.before);
          assertCompilerRowCgroup(
            observation.before,
            observed.snapshot,
            memoryBytes,
            cpuSet,
            expectedOom,
          );
        }
      };
      await new Promise<void>((resolve, reject) => {
        const fail = (error: unknown) => reject(toErrorObject(error, "Row observation failed"));
        const onClose = () => {
          if (phase !== "released") {
            reject(new Error("Container exited before its frozen finish barrier"));
          }
        };
        child.once("close", onClose);
        child.once("error", fail);
        child.stdout?.on("data", (chunk: Buffer) => {
          try {
            pending += chunk.toString("utf8");
            assert(Buffer.byteLength(pending) <= 2 * 1024 ** 2, "Oversized row protocol line");
            for (;;) {
              const end = pending.indexOf("\n");
              if (end < 0) {
                break;
              }
              const line = pending.slice(0, end);
              pending = pending.slice(end + 1);
              if (line.startsWith("[compiler-row:ready] ")) {
                assert.equal(phase, "ready", "Duplicate row start barrier");
                observation.scratch = JSON.parse(line.slice("[compiler-row:ready] ".length));
                assert.deepEqual(observation.scratch, {
                  uid: process.getuid!(),
                  gid: process.getgid!(),
                  mode: 0o700,
                });
                freeze(true);
                fs.writeFileSync(path.join(controlDirectory, "start"), "start", { flag: "wx" });
                phase = "running";
                docker(["unpause", name]);
              } else if (line.startsWith("[compiler-row:finish] ")) {
                assert.equal(phase, "running", "Unexpected row finish barrier");
                observation.finish = JSON.parse(
                  line.slice("[compiler-row:finish] ".length),
                ) as RowFinish;
                freeze(false);
                fs.writeFileSync(path.join(controlDirectory, "release"), "release", { flag: "wx" });
                phase = "released";
                docker(["unpause", name]);
                resolve();
              }
            }
          } catch (error) {
            fail(error);
          }
        });
      });
    },
  };
}

export type CompilerRowReceipt = RowTerminal & {
  row: string;
  compiler: RowCompiler;
  stdout: string;
  stderr: string;
  observation: CompilerRowObservation;
  isolation?: {
    network: CompilerNetworkEvidence;
    readonlyPaths: string[];
    writable: { path: string; bytes: number; type: number; write: string }[];
    hostAbsent: boolean;
  };
};

/** Observe the actual row profile, including its private writable artifact mount. */
export function assertCompilerRowIsolation(
  receipt: CompilerRowReceipt,
  readonlyPaths: string[],
  generated: CompilerRowFile[],
) {
  assertCompilerRowTerminal(receipt, 0);
  assert(receipt.isolation, "Missing row-profile isolation receipt");
  assertCompilerNetworkIsolation(receipt.isolation.network);
  assert.deepEqual(
    receipt.isolation.readonlyPaths,
    readonlyPaths,
    "Row read-only mounts were not observed",
  );
  assert.deepEqual(receipt.isolation.writable, [
    {
      path: "/tmp",
      bytes: COMPILER_ROW_LIMITS.temporaryBytes,
      type: 0x01021994,
      write: "verified",
    },
    {
      path: "/work/.artifacts",
      bytes: COMPILER_ROW_LIMITS.artifactBytes,
      type: 0x01021994,
      write: "verified",
    },
  ]);
  assert.equal(receipt.isolation.hostAbsent, true);
  assert.deepEqual(receipt.observation.beforeFiles?.generated, generated);
  assert.deepEqual(receipt.observation.files?.generated, generated);
}

/** Exact canonical leaf evidence, not a green aggregate shell exit, admits a row. */
export function auditCompilerRowReceipt(
  row: CompilerRow,
  receipt: CompilerRowReceipt,
  cpuSet: string,
  libraryNames: string[],
  generated: CompilerRowFile[],
) {
  const { before, after, beforeFiles, files, finish, scratch } = receipt.observation;
  assert(before && after && beforeFiles && files && finish, "Incomplete row lifecycle evidence");
  assert(scratch, "Missing row scratch ownership");
  assert(Number.isSafeInteger(scratch.uid) && scratch.uid > 0);
  assert(Number.isSafeInteger(scratch.gid) && scratch.gid >= 0);
  assert.equal(scratch.mode, 0o700, "Row scratch is not owner-only");
  assertCompilerRowCgroup(before, after, COMPILER_ROW_LIMITS.memoryBytes, cpuSet);
  assertCompilerRowTerminal(receipt, finish.exitCode);
  assert.equal(finish.signal, null);
  assert.equal(finish.code, finish.exitCode);
  assert(
    Number.isFinite(Date.parse(finish.startedAt)) &&
      Date.parse(finish.finishedAt) >= Date.parse(finish.startedAt),
  );
  assert.equal(receipt.row, row.name);
  assert(["pinned", "candidate"].includes(receipt.compiler));
  assert(
    Buffer.byteLength(receipt.stdout) + Buffer.byteLength(receipt.stderr) <=
      COMPILER_ROW_LIMITS.outputBytes,
  );
  assert.deepEqual(beforeFiles.cache, [], "Row did not start cold");
  assert.deepEqual(beforeFiles.metrics, []);
  assert.equal(beforeFiles.totalBytes, 0);
  assert.deepEqual(files.mount, beforeFiles.mount);
  assert.deepEqual(beforeFiles.generated, generated, "Generated input identity changed");
  assert.deepEqual(files.generated, generated, "Generated input identity changed");
  assert.equal(files.metrics.length, row.graphs.length, "Missing or extra checking invocation");
  assert.deepEqual(
    files.cache.map((entry) => entry.path).toSorted(),
    row.graphs.map((graph) => graph.cache).toSorted(),
  );
  assert.equal(new Set(files.metrics.map((entry) => entry.path)).size, files.metrics.length);
  assert.equal(new Set(files.cache.map((entry) => entry.path)).size, files.cache.length);
  assert.equal(
    files.totalBytes,
    [...files.metrics, ...files.cache].reduce((total, entry) => total + entry.bytes, 0),
  );
  assert(files.totalBytes <= COMPILER_ROW_LIMITS.artifactBytes);
  const leaves = receipt.stdout
    .split("\n")
    .filter((line) => line.startsWith("[ci-static:tsgo:leaf] "))
    .map(
      (line) =>
        JSON.parse(line.slice("[ci-static:tsgo:leaf] ".length)) as {
          version: number;
          id: string;
          config: string;
          exitCode: number;
          stdout: string;
          stderr: string;
        },
    );
  assert.equal(leaves.length, row.graphs.length, "Missing or duplicate canonical leaf outcome");
  assert.equal(new Set(leaves.map((leaf) => leaf.id)).size, leaves.length);
  const seen = new Set<string>();
  return files.metrics.map((entry) => {
    assert.match(entry.path, /^\.artifacts\/row-metrics\/tsgo-[a-f0-9-]{36}\.json$/u);
    assert(entry.bytes > 0 && entry.bytes <= 1024 * 1024);
    assert.equal(Buffer.byteLength(entry.text), entry.bytes);
    assert.equal(digest(entry.text), entry.sha256);
    const metric = JSON.parse(entry.text) as {
      schemaVersion: number;
      lockfileSha256: string;
      nodeVersion: string;
      command: { bin: string; args: string[]; cwd: string; timeoutMs: number | null };
      outcome: {
        exitCode: number;
        exitSignal: unknown;
        forwardedSignal: unknown;
        errorCode: unknown;
      };
      resources: { policy: Record<string, string | null> };
    };
    assert.equal(metric.schemaVersion, 1);
    assert.equal(metric.lockfileSha256, COMPILER_ROW_IDENTITIES.lockfile);
    assert.equal(metric.nodeVersion, "v24.16.0");
    assert.equal(metric.command.bin, "/experiment/compiler/tsc");
    assert.equal(metric.command.cwd, "/work");
    assert.equal(metric.command.timeoutMs, null);
    const graph = row.graphs.find((item) => item.config === metric.command.args[1]);
    assert(graph && !seen.has(graph.config), "Unplanned or duplicate compiler graph");
    seen.add(graph.config);
    assert.deepEqual(metric.command.args, [
      "-p",
      graph.config,
      "--incremental",
      ...(["core", "ui", "extensions", "extensions-test", "scripts"].includes(graph.name)
        ? ["--tsBuildInfoFile", graph.cache]
        : []),
      "--declaration",
      "false",
      "--singleThreaded",
      "--checkers",
      "1",
      "--pretty",
      "false",
    ]);
    assert.deepEqual(metric.resources.policy, {
      OPENCLAW_LOCAL_CHECK_MODE: null,
      GOMAXPROCS: "2",
      GOGC: "30",
      GOMEMLIMIT: "3GiB",
    });
    assert.equal(metric.outcome.exitSignal, null);
    assert.equal(metric.outcome.forwardedSignal, null);
    assert.equal(metric.outcome.errorCode, null);
    const matches = leaves.filter((leaf) => leaf.config === graph.config);
    assert.equal(matches.length, 1);
    const leaf = matches[0]!;
    assert.equal(leaf.version, 1);
    assert.equal(leaf.exitCode, metric.outcome.exitCode);
    assert([0, 2].includes(leaf.exitCode));
    assert.equal(leaf.stderr, "");
    assert(Buffer.byteLength(leaf.stdout) <= 1024 * 1024);
    const cache = files.cache.find((item) => item.path === graph.cache)!;
    assert(cache.bytes > 0 && cache.bytes <= COMPILER_ROW_LIMITS.cacheFileBytes);
    assert.match(cache.sha256, /^[a-f0-9]{64}$/u);
    const inputFiles = cache.fileNames
      .map((name) => {
        assert(typeof name === "string" && name.length <= 4096);
        const isPath = name.startsWith("./") || name.startsWith("../") || name.startsWith("/");
        assert(isPath || libraryNames.includes(name), "Unknown bare build-info library");
        const resolved = path.posix.resolve(
          isPath ? path.posix.dirname(`/work/${graph.cache}`) : "/experiment/compiler",
          name,
        );
        assert(
          resolved.startsWith("/work/") ||
            libraryNames.some((library) => resolved === `/experiment/compiler/${library}`),
          "Build-info input escaped immutable mounts",
        );
        return resolved;
      })
      .toSorted();
    assert(inputFiles.length > 0 && new Set(inputFiles).size === inputFiles.length);
    return {
      graph: graph.name,
      config: graph.config,
      exitCode: leaf.exitCode,
      stdout: leaf.stdout,
      stderr: leaf.stderr,
      inputFiles,
    };
  });
}

function assertCompilerRowPair(
  receipts: CompilerRowReceipt[],
  results: ReturnType<typeof auditCompilerRowReceipt>[],
) {
  assert.equal(receipts.length, 2);
  const ordered = results.map((leaves) =>
    leaves.toSorted((left, right) =>
      left.graph < right.graph ? -1 : left.graph > right.graph ? 1 : 0,
    ),
  );
  assert.deepEqual(ordered[0], ordered[1], "Compiler outcomes or input sets differ");
  // A clean set of compiler leaves cannot hide a failed canonical parent row.
  assert.deepEqual(
    receipts.map((receipt) => receipt.processExitCode),
    [0, 0],
    "Canonical row shell failed",
  );
  assert(
    ordered[0]!.every((leaf) => leaf.exitCode === 0 && leaf.stdout === "" && leaf.stderr === ""),
    "Row did not typecheck cleanly",
  );
}

/** Persist the attempted arm before admission; rejection stops the entire plan. */
export async function runCompilerRowPairs({
  run,
  retain,
  cpuSet,
  libraryNames,
  generated,
}: {
  run: (row: CompilerRow, compiler: RowCompiler) => Promise<CompilerRowReceipt>;
  retain: (receipt: CompilerRowReceipt) => void;
  cpuSet: string;
  libraryNames: string[];
  generated: CompilerRowFile[];
}) {
  let checking = 0;
  for (const row of compilerRowPlan()) {
    const paired = [];
    const receipts = [];
    for (const compiler of ["pinned", "candidate"] as const) {
      const receipt = await run(row, compiler);
      retain(receipt);
      const leaves = auditCompilerRowReceipt(row, receipt, cpuSet, libraryNames, generated);
      checking += leaves.length;
      paired.push(leaves);
      receipts.push(receipt);
    }
    assertCompilerRowPair(receipts, paired);
  }
  assert.equal(checking, 76);
  return checking;
}

/** Reconcile all planned rows, including rows deliberately never admitted. */
export function auditCompilerRows(directory: string) {
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
  const metadata = read("metadata.json") as {
    sourceHead: string;
    workloadHead: string;
    wrapperAdmission: unknown;
    binarySha256: Record<RowCompiler, string>;
    libraryManifest: { name: string; sha256: string }[];
    overlay: unknown;
    lockfileSha256: string;
    runtime: {
      nodeVersion: string;
      pnpmVersion: string;
      user: { uid: number; gid: number };
      files: { name: string; sha256: string }[];
      manifestSha256: string;
    };
    limits: typeof COMPILER_ROW_LIMITS & { cpuSet: string };
    cpus: number;
    extraCompilerCalls: { versions: number; discovery: number; api: number; declarations: number };
    recordedChecking: number;
    generated: CompilerRowFile[];
    readonlyMounts: string[];
  };
  assert.match(metadata.sourceHead, /^[a-f0-9]{40}$/u);
  assert.equal(metadata.workloadHead, COMPILER_ROW_WORKLOAD);
  assert.deepEqual(metadata.wrapperAdmission, {
    policy: COMPILER_ROW_POLICY,
    performanceEligible: false,
    checkingCalls: 76,
    rowArms: 14,
  });
  assert.deepEqual(metadata.binarySha256, {
    pinned: COMPILER_ROW_IDENTITIES.pinned,
    candidate: COMPILER_ROW_IDENTITIES.candidate,
  });
  assert.equal(metadata.libraryManifest.length, 108);
  assert.equal(digest(JSON.stringify(metadata.libraryManifest)), COMPILER_ROW_IDENTITIES.libraries);
  assert.equal(metadata.lockfileSha256, COMPILER_ROW_IDENTITIES.lockfile);
  assert.deepEqual(metadata.overlay, {
    beforeSha256: COMPILER_ROW_IDENTITIES.wrapper,
    afterSha256: COMPILER_ROW_IDENTITIES.overlay,
  });
  assert.equal(metadata.runtime.nodeVersion, "v24.16.0");
  assert.equal(metadata.runtime.pnpmVersion, "12.11.1");
  assert(Number.isSafeInteger(metadata.runtime.user.uid) && metadata.runtime.user.uid > 0);
  assert(Number.isSafeInteger(metadata.runtime.user.gid) && metadata.runtime.user.gid >= 0);
  assert.equal(digest(JSON.stringify(metadata.runtime.files)), metadata.runtime.manifestSha256);
  assert.equal(
    new Set(metadata.runtime.files.map((entry) => entry.name)).size,
    metadata.runtime.files.length,
  );
  for (const file of metadata.runtime.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/u);
    assert(!path.posix.isAbsolute(file.name) && !file.name.split("/").includes(".."));
  }
  for (const name of [
    "bin/node",
    "bin/pnpm",
    "bin/ps",
    "ps-bin",
    "ps-libs/ld-linux-x86-64.so.2",
    "pnpm/bin/pnpm.mjs",
    "pnpm/node_modules/@pnpm/exe.linux-x64/package.json",
  ]) {
    assert(
      metadata.runtime.files.some((file) => file.name === name),
      "Missing staged runtime owner",
    );
  }
  assert.deepEqual(metadata.limits, { ...COMPILER_ROW_LIMITS, cpuSet: metadata.limits.cpuSet });
  assert.match(metadata.limits.cpuSet, /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u);
  assert.equal(metadata.cpus, 4);
  assert.deepEqual(
    metadata.generated.map((file) => file.path),
    ["inputs.sha256", "openclaw-agent-db.generated.ts", "openclaw-state-db.generated.ts"].map(
      (name) => ".artifacts/kysely/" + name,
    ),
  );
  for (const file of metadata.generated) {
    assert(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= 1024 * 1024);
    assert.match(file.sha256, /^[a-f0-9]{64}$/u);
  }
  assert.equal(new Set(metadata.readonlyMounts).size, metadata.readonlyMounts.length);
  for (const required of [
    "/work",
    "/upload-evidence",
    "/work/.artifacts/kysely",
    "/row-runtime",
    "/row-control",
    "/experiment/compiler",
    "/work/node_modules",
  ]) {
    assert(metadata.readonlyMounts.includes(required), "Missing row read-only mount");
  }
  assert(
    metadata.readonlyMounts.every(
      (entry) => entry.startsWith("/") && !entry.split("/").includes(".."),
    ),
  );
  assert.equal(metadata.extraCompilerCalls.versions, 2);
  assert.equal(metadata.extraCompilerCalls.discovery, 0);
  assert.equal(metadata.extraCompilerCalls.api, 0);
  assert.equal(metadata.extraCompilerCalls.declarations, 0);
  const plan = compilerRowPlan();
  assert.deepEqual(read("row-plan.json"), plan);
  const smokes = read("row-smokes.json") as CompilerRowReceipt[];
  assert.deepEqual(
    smokes.map((entry) => entry.row),
    [
      "isolation",
      "runtime",
      "joined",
      "ordinary-collect",
      "ordinary-static",
      "oom",
      "explicit-137",
      "deadline",
      "descendant",
    ],
  );
  for (const smoke of smokes) {
    assert.equal(smoke.cleanupVerified, true);
    assert.deepEqual(
      smoke.observation.scratch,
      { ...metadata.runtime.user, mode: 0o700 },
      "Missing or changed row scratch ownership",
    );
    if (smoke.row === "deadline" || smoke.row === "descendant") {
      assert(smoke.infrastructureError || smoke.processSignal);
      assert.equal(smoke.observation.after, undefined);
      if (smoke.row === "deadline") {
        assert.equal(smoke.processSignal, "SIGKILL");
      } else {
        assert.match(String(smoke.infrastructureError), /Frozen row descendants remain/u);
      }
      continue;
    }
    const { before, after, finish } = smoke.observation;
    assert(before && after && finish);
    const oom = smoke.row === "oom";
    const abnormal = oom || smoke.row === "explicit-137";
    assertCompilerRowCgroup(
      before,
      after,
      abnormal ? 128 * 1024 ** 2 : COMPILER_ROW_LIMITS.memoryBytes,
      metadata.limits.cpuSet,
      oom,
    );
    const code = abnormal
      ? 137
      : smoke.row === "ordinary-collect"
        ? 1
        : smoke.row === "ordinary-static"
          ? 2
          : 0;
    if (smoke.row === "isolation") {
      assertCompilerRowIsolation(smoke, metadata.readonlyMounts, metadata.generated);
    }
    if (abnormal) {
      assert.throws(() => assertCompilerRowTerminal(smoke, code));
      assert.equal(smoke.infrastructureError, undefined);
      assert.equal(smoke.processSignal, null);
      assert.equal(smoke.processExitCode, 137);
      assert.deepEqual(smoke.preCleanupState, {
        available: true,
        Status: "exited",
        Running: false,
        OOMKilled: oom,
        ExitCode: 137,
      });
      assert.equal(finish.signal, oom ? "SIGKILL" : null);
      if (oom) {
        assert(smoke.stdout.includes("child-oom-score=1000\n"));
      }
    } else {
      assertCompilerRowTerminal(smoke, code);
    }
    if (smoke.row.startsWith("ordinary-")) {
      assert(smoke.stdout.includes("continued\n"));
    }
  }
  const receipts = read("row-receipts.json") as CompilerRowReceipt[];
  const containerIds = [...smokes, ...receipts].map(
    (receipt) => receipt.observation.before?.identity.containerId,
  );
  assert(containerIds.every((id) => typeof id === "string"));
  assert.equal(
    new Set(containerIds).size,
    containerIds.length,
    "A container was reused across trials",
  );
  const expected = plan.flatMap((row) =>
    (["pinned", "candidate"] as const).map((compiler) => ({ row: row.name, compiler })),
  );
  assert(receipts.length <= expected.length);
  assert.deepEqual(
    receipts.map(({ row, compiler }) => ({ row, compiler })),
    expected.slice(0, receipts.length),
    "Rows ran out of canonical admission order",
  );
  const rejected: { row: string; reason: string }[] = [];
  const missing = expected.slice(receipts.length).map(({ row, compiler }) => `${row}/${compiler}`);
  let completedChecking = 0;
  let recordedChecking = 0;
  for (const row of plan) {
    const pair = receipts.filter((receipt) => receipt.row === row.name);
    if (pair.length === 0) {
      continue;
    }
    assert.equal(rejected.length, 0, "Another row started after a rejected pair");
    const results = [];
    for (const receipt of pair) {
      recordedChecking += receipt.observation.files?.metrics.length ?? 0;
      try {
        assert.deepEqual(
          receipt.observation.scratch,
          { ...metadata.runtime.user, mode: 0o700 },
          "Missing or changed row scratch ownership",
        );
        results.push(
          auditCompilerRowReceipt(
            row,
            receipt,
            metadata.limits.cpuSet,
            metadata.libraryManifest.map((entry) => entry.name),
            metadata.generated,
          ),
        );
        completedChecking += row.graphs.length;
      } catch (error) {
        rejected.push({
          row: `${row.name}/${receipt.compiler}`,
          reason: error instanceof Error ? error.message : "Invalid row evidence",
        });
        assert(receipt === pair.at(-1), "Another compiler started after unsafe row evidence");
      }
    }
    if (results.length === 2) {
      try {
        assertCompilerRowPair(pair, results);
      } catch (error) {
        rejected.push({
          row: row.name,
          reason: error instanceof Error ? error.message : "Row parity failed",
        });
      }
    }
  }
  assert(recordedChecking <= 76);
  const passed = missing.length === 0 && rejected.length === 0 && completedChecking === 76;
  assert.equal(metadata.recordedChecking, recordedChecking);
  return {
    sourceHead: metadata.sourceHead,
    workloadHead: metadata.workloadHead,
    binarySha256: metadata.binarySha256,
    libraryManifestSha256: COMPILER_ROW_IDENTITIES.libraries,
    scope: {
      purpose: COMPILER_ROW_POLICY,
      rowNames: plan.map((row) => row.name),
      plannedChecking: 76,
      plannedRowArms: 14,
      performanceEligible: false,
    },
    status: rejected.length ? "invalid" : passed ? "equivalent" : "incomplete",
    qualificationPassed: passed,
    typecheckPassed: passed,
    wrapperAdmissionPassed: passed,
    performanceEligible: false,
    attemptedRowArms: receipts.length,
    recordedChecking,
    checkingCountComplete: passed,
    completedChecking,
    missingCheckingRecords: 76 - recordedChecking,
    missing,
    rejected,
    extraCompilerCalls: metadata.extraCompilerCalls,
  };
}
