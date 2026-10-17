// Opt-in compiler comparison. Never changes the selected repository compiler.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureKyselyTypes } from "./generate-kysely-types.mts";
import {
  captureCompilerComparisonOutput,
  readCompilerComparisonMetrics,
} from "./lib/compiler-comparison-io.mts";
import { applyLocalTsgoPolicy, resolveRepoToolBinPath } from "./lib/local-check-runtime.mts";
import { TSGO_CI_GRAPHS, expandTsgoExecutionGraphs } from "./lib/tsgo-core-test-shards.mts";

const root = fileURLToPath(new URL("../", import.meta.url));

async function main() {
  assert(
    process.platform === "linux" && process.arch === "x64",
    "Use a disposable Linux x64 CI runner",
  );
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Run through the secretless qualification workflow",
  );
  const inventory = expandTsgoExecutionGraphs(TSGO_CI_GRAPHS);
  const argument = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? fallback : process.argv[i + 1];
  };
  const containerImage =
    "ubuntu@sha256:a2d43bffc46670d7108bb3c0468c67c5557c4c92e83e1e34cbff1322ad1b94dc";
  const group = Number(argument("--group", "0"));
  const groups = Number(argument("--groups", String(inventory.length)));
  const repeats = Number(argument("--repeats", "3"));
  assert(Number.isInteger(group) && Number.isInteger(groups) && group >= 0 && group < groups);
  assert(Number.isInteger(repeats) && repeats > 0 && repeats <= 10);
  const directory = path.join(root, ".artifacts/compiler-comparison", "group-" + group);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  // Refuse stale output: partial prior runs must not become evidence for this run.
  fs.mkdirSync(directory);
  const dump = (name, value) =>
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2));
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve("typescript/package.json");
  const packageData = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const pinnedBinary = resolveRepoToolBinPath("tsgo", { cwd: root });
  const libraries = path.dirname(pinnedBinary);
  const graphs = inventory.filter((_, index) => index % groups === group);
  assert(graphs.length > 0, "Empty compiler group");
  dump("inventory.json", { inventory, group, groups, graphs });

  function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
      ...options,
    });
    if (result.error || result.status !== 0) {
      throw new Error(command + ": " + (result.error?.message ?? result.stderr ?? result.status));
    }
    return result.stdout;
  }
  assert.equal(
    run("git", ["status", "--porcelain", "--untracked-files=no"]).trim(),
    "",
    "Commit tracked source before collection",
  );
  const archives = [
    {
      name: "native",
      url: "https://registry.npmjs.org/@tsc-ts/linux-x64-gnu/-/linux-x64-gnu-0.0.2.tgz",
      integrity:
        "sha512-/+IrlTylDCCTqMtmEvV3pH+jWNnsI7I5+pSFFQj5tMFTYA7ArwROsaygtP6voPZtY6o+jFg6G7gPfxpCLPyYRg==",
    },
    {
      name: "reference",
      url: "https://registry.npmjs.org/@typescript/typescript-linux-x64/-/typescript-linux-x64-7.0.2.tgz",
      integrity:
        "sha512-EYdf2cNg7rgCWJnxCdJ+F3V39O8ihb37eHAu1LK8oAFizgTQbPOK7zHHXbPt8rX24COqODXeI3sIf0fCXG7H/A==",
    },
  ];
  for (const entry of archives) {
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) {
      throw new Error("Download HTTP " + response.status + ": " + entry.url);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const [algorithm, expected] = entry.integrity.split("-");
    assert.equal(
      createHash(algorithm).update(bytes).digest("base64"),
      expected,
      entry.name + " integrity",
    );
    const archive = path.join(directory, entry.name + ".tgz");
    fs.writeFileSync(archive, bytes);
    const destination = path.join(directory, entry.name);
    fs.mkdirSync(destination, { recursive: true });
    run("tar", ["--no-same-owner", "-xzf", archive, "-C", destination]);
  }
  await ensureKyselyTypes(root);
  const nativeDirectory = path.join(directory, "native/package/lib");
  const referenceDirectory = path.join(directory, "reference/package/lib");
  const binaries = { pinned: "/pin/tsc", candidate: "/native/tsc-ts", reference: "/reference/tsc" };
  const common = ["--noEmit", "--declaration", "false", "--pretty", "false"];
  const cpuSet = fs
    .readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]
    .trim();
  assert(cpuSet, "Missing CPU affinity");
  const memoryCapacity = Math.min(os.totalmem(), process.constrainedMemory() || os.totalmem());
  const memoryBytes = Math.floor((memoryCapacity * 0.8) / 1024 ** 3) * 1024 ** 3;
  assert(memoryBytes > 0, "Missing memory capacity");
  const resources = { logicalCpuCount: os.availableParallelism(), totalMemoryBytes: memoryBytes };
  const modesFor = (graph) => [
    "incremental-cold",
    ...(["core", "ui", "extensions", "scripts"].includes(graph.name) ? ["nonincremental"] : []),
    ...(graph.name === "core" ? ["single-threaded", "incremental-unthrottled"] : []),
  ];
  const compilers = Object.keys(binaries);
  const expectedSamples = graphs.flatMap((graph) =>
    modesFor(graph).flatMap((mode) =>
      compilers.flatMap((compiler) =>
        Array.from({ length: repeats }, (_, index) =>
          [graph.name, mode, compiler, index + 1].join("-"),
        ),
      ),
    ),
  );

  const ciEnv = { CI: "true", GITHUB_ACTIONS: "true", OPENCLAW_LOCAL_CHECK: "0" };
  const ciPolicy = applyLocalTsgoPolicy([...common], ciEnv, resources);
  // Compiler-writable files never enter the artifact upload tree. Host-side reads
  // reject symlinks, then publish only parsed numeric metrics as new regular files.
  const metricsDirectory = path.join(
    root,
    ".artifacts/compiler-comparison-scratch",
    "group-" + group,
  );
  const evidenceMetrics = path.join(directory, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  fs.mkdirSync(evidenceMetrics, { recursive: true });

  function sandbox(mode, containerName) {
    const args = [
      "run",
      "--rm",
      "--pull",
      "never",
      "--cpuset-cpus",
      cpuSet,
      "--memory",
      String(memoryBytes),
      "--memory-swap",
      String(memoryBytes),
      "--name",
      containerName,
      "--network",
      "none",
      "--read-only",
      "--user",
      process.getuid() + ":" + process.getgid(),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev",
      "--tmpfs",
      "/cache:rw,nosuid,nodev,size=256m",
      "--workdir",
      "/work",
    ];
    const mount = (source, destination, readonly = true) =>
      args.push(
        "--mount",
        "type=bind,src=" + source + ",dst=" + destination + (readonly ? ",readonly" : ""),
      );
    mount(root, "/work");
    if (fs.statSync(path.join(root, ".git")).isDirectory()) {
      args.push("--tmpfs", "/work/.git:rw,nosuid,nodev");
    } else {
      mount("/dev/null", "/work/.git");
    }
    if (fs.existsSync(path.join(root, ".openclaw"))) {
      args.push("--tmpfs", "/work/.openclaw:rw,nosuid,nodev");
    }
    mount(libraries, "/libs");
    mount(libraries, "/pin");
    mount(libraries, "/reference");
    mount(path.join(referenceDirectory, "tsc"), "/reference/tsc");
    mount(nativeDirectory, "/native");
    mount(metricsDirectory, "/metrics", false);
    mount("/usr/bin/time", "/usr/bin/time");
    for (const value of ["PATH=/usr/bin:/bin", "HOME=/tmp", "LC_ALL=C", "TSC_TS_LIB_DIR=/libs"]) {
      args.push("--env", value);
    }
    if (mode === "incremental-cold") {
      for (const name of ["GOMAXPROCS", "GOGC", "GOMEMLIMIT"]) {
        if (ciPolicy.env[name]) {
          args.push("--env", name + "=" + ciPolicy.env[name]);
        }
      }
    }
    args.push(containerImage);
    return args;
  }
  let containerSequence = 0;
  const cancellation = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => cancellation.abort());
  }
  async function executeIsolated(args, { mode, files, ...options } = {}) {
    const name = "compiler-comparison-" + process.pid + "-" + containerSequence++;
    let result, failure;
    try {
      result = await new Promise((resolve) => {
        const child = spawn("docker", [...sandbox(mode, name), ...args], {
          cwd: root,
          timeout: 120000,
          killSignal: "SIGKILL",
          signal: cancellation.signal,
          ...options,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const output = captureCompilerComparisonOutput(files);
        let error;
        const capture = (chunk, stream) => {
          if (error) {
            return;
          }
          try {
            output.accept(chunk, stream);
          } catch (value) {
            error = value;
            child.kill("SIGKILL");
          }
        };
        child.stdout.on("data", (chunk) => capture(chunk, "stdout"));
        child.stderr.on("data", (chunk) => capture(chunk, "stderr"));
        child.on("error", (value) => {
          error = value;
        });
        child.on("close", (status, signal) =>
          resolve({ status, signal, error, ...output.finish() }),
        );
      });
    } catch (error) {
      failure = error;
    }
    // Join the exact container after timeout/cancellation; terminating its client
    // alone leaves the compiler running and invalidates subsequent measurements.
    if (!result || result.error || result.signal || result.status > 2) {
      const cleanup = spawnSync("docker", ["rm", "--force", name], {
        encoding: "utf8",
        timeout: 30000,
      });
      if (
        cleanup.error ||
        (cleanup.status !== 0 && !cleanup.stderr.includes("No such container"))
      ) {
        throw new Error("Failed to join task-owned container " + name);
      }
    }
    if (!result) {
      throw failure;
    }
    return result;
  }
  async function isolatedOutput(args, options = {}) {
    const result = await executeIsolated(args, options);
    if (result.error || result.status !== 0) {
      throw new Error("Isolation: " + (result.error?.message ?? result.stderr ?? result.status));
    }
    return result.stdout;
  }
  // Read back enforcement from inside the actual mount/resource namespace.
  const limits = (
    await isolatedOutput([
      "sh",
      "-c",
      "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/cpuset.cpus.effective",
    ])
  )
    .trim()
    .split("\n");
  assert.deepEqual(
    limits,
    [String(memoryBytes), "0", cpuSet],
    "Container limits were not enforced",
  );
  const probe = ".compiler-isolation-" + randomUUID();
  const probePaths = {
    checkout: path.join(root, probe),
    evidence: path.join(directory, probe),
    metrics: path.join(metricsDirectory, probe),
  };
  for (const file of Object.values(probePaths)) {
    assert(!fs.existsSync(file), "Isolation probe already exists");
  }
  const isolationSmoke = {
    metricsWrite: "verified",
    checkoutWrite: "EROFS",
    evidenceWrite: "EROFS",
    networkInterfaces: "loopback-only",
    externalIpv4Tcp: "ENETUNREACH",
  };
  try {
    // Linux EROFS/ENETUNREACH distinguish isolation from missing paths or a
    // refused remote port. The documentation-only address is never a service dependency.
    await isolatedOutput(
      [
        "bash",
        "--noprofile",
        "--norc",
        "-c",
        `set -eu
fail() { printf '%s\\n' "$1" >&2; exit 1; }
printf '%s' "$1" > "/metrics/$1"
for target in "$2" "$3"; do
  test -d "\${target%/*}" || fail "Missing isolation probe parent"
  if printf forbidden 2>/tmp/write-error > "$target"; then fail "Unexpected writable checkout or evidence"; fi
  [[ "$(</tmp/write-error)" == *"Read-only file system"* ]] || fail "Write failed without EROFS"
done
interfaces=(/sys/class/net/*)
[[ \${#interfaces[@]} == 1 && \${interfaces[0]##*/} == lo ]] || fail "Non-loopback network interface"
while read -r interface rest; do
  [[ $interface == Iface || $interface == lo ]] || fail "Non-loopback IPv4 route"
done < /proc/net/route
if ( : > /dev/tcp/192.0.2.1/9 ) 2>/tmp/network-error; then fail "Unexpected external TCP connection"; fi
[[ "$(</tmp/network-error)" == *"Network is unreachable"* ]] || fail "TCP failed without ENETUNREACH"`,
        "isolation-proof",
        probe,
        "/work/" + probe,
        "/work/" + path.relative(root, path.join(directory, probe)),
      ],
      { timeout: 10000 },
    );
    assert.equal(fs.readFileSync(probePaths.metrics, "utf8"), probe);
    assert(!fs.existsSync(probePaths.checkout) && !fs.existsSync(probePaths.evidence));
  } finally {
    // A broken mount must not leave even the probe's unexpected writes behind.
    for (const file of Object.values(probePaths)) {
      fs.rmSync(file, { force: true });
    }
  }
  const version = {};
  for (const [name, binary] of Object.entries(binaries)) {
    version[name] = (await isolatedOutput([binary, "--version"])).trim();
  }
  dump("metadata.json", {
    sourceHead: run("git", ["rev-parse", "HEAD"]).trim(),
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    workflowRef: process.env.GITHUB_WORKFLOW_REF ?? null,
    node: process.version,
    os: os.release(),
    cpu: os.cpus()[0]?.model,
    cpus: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
    loadAverage: os.loadavg(),
    version,
    pinnedPackage: packageData.version,
    pinnedRevision: packageData.gitHead,
    candidateVersion: "0.0.2",
    candidateRevision: "b0dbfb0ea2240b59d51de5de1aae3a35a9f3dc10",
    referenceRevision: "2bd066d87f5bafd315be9f40889d0a60b9e58e0b",
    binarySha256: {
      pinned: hash(fs.readFileSync(pinnedBinary)),
      candidate: hash(fs.readFileSync(path.join(nativeDirectory, "tsc-ts"))),
      reference: hash(fs.readFileSync(path.join(referenceDirectory, "tsc"))),
    },
    libraries:
      "All compilers use repository-pinned library declarations; compiler-directory prefixes normalized only for comparison.",
    libraryManifest: fs
      .readdirSync(libraries)
      .filter((name) => name.startsWith("lib.") && name.endsWith(".d.ts"))
      .toSorted()
      .map((name) => ({ name, sha256: hash(fs.readFileSync(path.join(libraries, name))) })),
    repeats,
    group,
    groups,
    archives,
    ciPolicy,
    isolation: "docker",
    isolationSmoke,
    containerImage,
    limits: { cpuSet, memoryBytes, swapBytes: 0 },
    expectedSamples,
    method:
      "Fresh process and empty incremental cache per sample. Warm filesystem after input preflight. GNU time inside secretless sandbox. incremental-cold applies the canonical CI resource policy to both compilers; other modes use explicit direct flags without Go tuning.",
  });
  const normalize = (text) =>
    text.replaceAll("/pin/", "/libs/").replaceAll("/reference/", "/libs/");
  const flags = (graph, mode) => {
    const incremental = mode.startsWith("incremental-");
    const args = [
      "-p",
      graph.config,
      ...common,
      "--incremental",
      incremental ? "true" : "false",
      ...(incremental ? ["--tsBuildInfoFile", "/cache/project.tsbuildinfo"] : []),
      ...(mode === "single-threaded" ? ["--singleThreaded"] : []),
    ];
    return mode === "incremental-cold" ? applyLocalTsgoPolicy(args, ciEnv, resources).args : args;
  };
  const records = [];
  const parity = [];
  async function measure(graph, compiler, mode, iteration) {
    const id = [graph.name, mode, compiler, iteration].join("-");
    const stdoutFile = path.join(directory, id + ".stdout");
    const stderrFile = path.join(directory, id + ".stderr");
    const stdoutFd = fs.openSync(stdoutFile, "w");
    const stderrFd = fs.openSync(stderrFile, "w");
    let result;
    try {
      result = await executeIsolated(
        [
          "/usr/bin/time",
          "-f",
          "%e %U %S %M %x",
          "-o",
          "/metrics/" + id + ".time",
          binaries[compiler],
          ...flags(graph, mode),
        ],
        {
          timeout: 600000,
          killSignal: "SIGKILL",
          mode,
          files: { stdout: stdoutFd, stderr: stderrFd },
        },
      );
    } finally {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
    }
    if (result.error || result.signal) {
      throw new Error(id + ": infrastructure failure: " + (result.error?.message ?? result.signal));
    }
    const metricFile = path.join(metricsDirectory, id + ".time");
    const metrics = readCompilerComparisonMetrics(metricFile);
    const [wallSeconds, userSeconds, sysSeconds, peakRssKiB, exitCode] = metrics;
    fs.writeFileSync(
      path.join(evidenceMetrics, id + ".json"),
      JSON.stringify({
        wallSeconds,
        userSeconds,
        sysSeconds,
        peakRssKiB,
        exitCode,
        processExitCode: result.status,
      }),
    );
    // Keep rejected trials out of measurements while collecting the remaining
    // isolated samples. Their planned IDs keep the audit incomplete.
    if (![0, 1, 2].includes(result.status) || result.status !== exitCode) {
      console.error(
        id + ": rejected sample: process exit " + result.status + ", GNU time " + exitCode,
      );
      return;
    }
    const stdout = normalize(fs.readFileSync(stdoutFile, "utf8"));
    const stderr = fs.readFileSync(stderrFile);
    const row = {
      graph: graph.name,
      config: graph.config,
      mode,
      compiler,
      iteration,
      flags: flags(graph, mode),
      wallSeconds,
      userSeconds,
      sysSeconds,
      peakRssKiB,
      exitCode,
      diagnosticSha256: hash(stdout),
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: stderr.length,
      diagnosticCount: stdout
        .split(String.fromCharCode(10))
        .filter((line) => line.includes("): error TS")).length,
    };
    records.push(row);
    dump("measurements.json", records);
    console.log(JSON.stringify(row));
  }
  for (const graph of graphs) {
    const proofs = {};
    for (const compiler of compilers) {
      proofs[compiler] = {};
      for (const [label, option] of [
        ["config", "--showConfig"],
        ["files", "--listFilesOnly"],
      ]) {
        const output = normalize(
          await isolatedOutput([binaries[compiler], ...flags(graph, "incremental-cold"), option], {
            mode: "incremental-cold",
          }),
        );
        fs.writeFileSync(
          path.join(directory, graph.name + "-" + compiler + "-" + label + ".txt"),
          output,
        );
        proofs[compiler][label] = {
          sha256: hash(output),
          lines: output.split(String.fromCharCode(10)).filter(Boolean).length,
        };
      }
    }
    const equal =
      proofs.pinned.config.sha256 === proofs.candidate.config.sha256 &&
      proofs.pinned.files.sha256 === proofs.candidate.files.sha256 &&
      proofs.pinned.config.sha256 === proofs.reference.config.sha256 &&
      proofs.pinned.files.sha256 === proofs.reference.files.sha256;
    parity.push({ graph: graph.name, equal, proofs });
    dump("input-parity.json", parity);
    assert(equal, "Different compiler inputs for " + graph.name);
    for (const mode of modesFor(graph)) {
      for (let iteration = 1; iteration <= repeats; iteration++) {
        // Rotate each compiler through first/middle/last over three repetitions.
        const start = (iteration + group) % compilers.length;
        const order = [...compilers.slice(start), ...compilers.slice(0, start)];
        for (const compiler of order) {
          await measure(graph, compiler, mode, iteration);
        }
      }
    }
  }
  console.log(
    "Collected " +
      records.length +
      " samples for " +
      graphs.length +
      " canonical graphs. Run audit-compiler-comparison.mts before interpreting timings.",
  );
}
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[compiler-comparison] FAILED (exit 1)");
  process.exitCode = 1;
}
