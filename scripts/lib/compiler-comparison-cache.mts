import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const COMPILER_CACHE_FILE_LIMIT = 4 * 1024 * 1024;
export const COMPILER_CACHE_EVIDENCE_LIMIT = 256 * 1024 * 1024;
export const COMPILER_CACHE_POLICY = "synthetic-incremental-contract-v1";

export type CacheExecution = {
  processExitCode: number | null;
  processSignal: string | null;
  infrastructureError?: unknown;
  cleanupVerified: boolean;
  preCleanupState: unknown;
};

/** A rejected producer must never supply a seed to another invocation. */
export function assertCompilerCacheExecution(receipt: CacheExecution, exitCode: number) {
  assert([0, 1, 2].includes(exitCode), "Invalid cache producer exit");
  assert.equal(receipt.processExitCode, exitCode, "Container/time exit mismatch");
  assert.equal(receipt.processSignal, null);
  assert.equal(receipt.infrastructureError, undefined);
  assert.equal(receipt.cleanupVerified, true);
  assert.deepEqual(
    receipt.preCleanupState,
    {
      available: true,
      Status: "exited",
      Running: false,
      OOMKilled: false,
      ExitCode: exitCode,
    },
    "Cache producer is not a verified terminal invocation",
  );
}

/** Both trusted admission smokes and compiler phases use this exact wrapper. */
export function compilerCacheCommand(command: string[], id: string, seed: boolean) {
  assert.match(id, /^[a-z0-9-]+$/u);
  return [
    "/bin/bash",
    "-c",
    `
set -u
helper=/work/scripts/lib/compiler-comparison-cache.mts
${seed ? '/proof-node "$helper" copy /seed.tsbuildinfo /cache/project.tsbuildinfo || exit 77' : ""}
"$@"
status=$?
/proof-node "$helper" copy /cache/project.tsbuildinfo /metrics/${id}.cache || exit 77
exit "$status"
`,
    "compiler-cache",
    ...command,
  ];
}

export type CacheCompiler = "pinned" | "candidate" | "reference";
export type CacheState = "clean" | "error" | "missing" | "dependency";
export type CachePhase = {
  id: string;
  compiler: CacheCompiler;
  state: CacheState;
  seed?: string;
  truncate?: boolean;
  control?: string;
};

/** One immutable plan counts seeds, receiving invocations and fresh controls. */
export function compilerCachePlan(): CachePhase[] {
  const phases: CachePhase[] = [];
  for (const compiler of ["pinned", "candidate", "reference"] as const) {
    const add = (
      name: string,
      state: CacheState,
      seed?: string,
      control?: string,
      truncate?: boolean,
    ) =>
      phases.push({
        id: `${compiler}-${name}`,
        compiler,
        state,
        ...(seed ? { seed: `${compiler}-${seed}` } : {}),
        ...(control ? { control: `${compiler}-${control}` } : {}),
        ...(truncate ? { truncate: true } : {}),
      });
    add("cold", "clean");
    add("unchanged", "clean", "cold", "cold");
    add("error", "error", "unchanged", "error-fresh");
    add("error-fresh", "error");
    add("repair", "clean", "error", "repair-fresh");
    add("repair-fresh", "clean");
    add("delete", "missing", "repair", "delete-fresh");
    add("delete-fresh", "missing");
    add("dependency", "dependency", "delete", "dependency-fresh");
    add("dependency-fresh", "dependency");
    add("truncated", "clean", "dependency", "truncated-fresh", true);
    add("truncated-fresh", "clean");
  }
  for (const [producer, receiver] of [
    ["pinned", "candidate"],
    ["candidate", "pinned"],
    ["reference", "candidate"],
    ["candidate", "reference"],
  ] as const) {
    const prefix = `${producer}-to-${receiver}`;
    phases.push(
      { id: `${prefix}-seed`, compiler: producer, state: "clean" },
      {
        id: `${prefix}-unchanged`,
        compiler: receiver,
        state: "clean",
        seed: `${prefix}-seed`,
        control: `${prefix}-fresh`,
      },
      { id: `${prefix}-fresh`, compiler: receiver, state: "clean" },
      {
        // The edit receives the original producer seed, never the receiver's rewrite.
        id: `${prefix}-edited`,
        compiler: receiver,
        state: "error",
        seed: `${prefix}-seed`,
        control: `${prefix}-edited-fresh`,
      },
      { id: `${prefix}-edited-fresh`, compiler: receiver, state: "error" },
    );
  }
  return phases;
}

/** Each transition replaces the entire readonly fixture, including deleted imports. */
export function compilerCacheFixture(state: CacheState): Record<string, string> {
  return {
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: [],
        lib: ["es2022"],
      },
      files: ["input.ts"],
    }),
    "input.ts": `import { value } from "./dep.js";\nexport const result: ${state === "error" ? "string" : "number"} = value;\n`,
    ...(state === "missing"
      ? {}
      : {
          "dep.d.ts": `export declare const value: ${state === "dependency" ? "string" : "number"};\n`,
        }),
  };
}

/** Descriptor checks and an incremental byte cap also cover concurrent writers. */
export function readCompilerCacheFile(file: string): Buffer {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile(), "Cache input must be a regular file");
    assert(stat.size > 0, "Cache input must not be empty");
    assert(stat.size <= COMPILER_CACHE_FILE_LIMIT, "Cache input exceeds 4 MiB");
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(65536);
      const count = fs.readSync(fd, chunk);
      if (!count) {
        break;
      }
      size += count;
      assert(size <= COMPILER_CACHE_FILE_LIMIT, "Cache input exceeds 4 MiB");
      chunks.push(chunk.subarray(0, count));
    }
    assert.equal(size, stat.size, "Cache size changed during transport");
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
}

export function copyCompilerCacheFile(source: string, destination: string) {
  const bytes = readCompilerCacheFile(source);
  fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function readCompilerCacheOutput(file: string, receipt: CacheExecution, exitCode: number) {
  assertCompilerCacheExecution(receipt, exitCode);
  return readCompilerCacheFile(file);
}

type CacheReceipt = { file: string; bytes: number; sha256: string };
type CacheRecord = CachePhase & {
  input: Record<string, string>;
  inputSha256: string;
  seedCache: CacheReceipt | null;
  outputCache: CacheReceipt;
};
type CacheMeasurement = {
  id: string;
  compiler: CacheCompiler;
  graph: string;
  config: string;
  mode: string;
  iteration: number;
  flags: string[];
  exitCode: number;
  diagnosticSha256: string;
  stdoutBytes: number;
  stderrBytes: number;
  wallSeconds: number;
  userSeconds: number;
  sysSeconds: number;
  peakRssKiB: number;
};

/** This proof admits only the fixed synthetic plan, never repository timing claims. */
export function auditCompilerCache(
  directory: string,
  metadata: {
    cacheCorrectness?: unknown;
    cacheWrapperSmoke?: unknown;
    libraryManifest: { name: string; sha256: string }[];
    expectedSamples?: string[];
    cpus?: number;
    limits?: { memoryBytes: number; swapBytes: number };
    repeats: number;
    group: number;
    groups: number;
    capacityControl?: unknown;
    ciPolicy?: { args: string[]; env: Record<string, string> };
  },
) {
  const read = (name: string) => fs.readFileSync(path.join(directory, name), "utf8");
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const profile = metadata.cacheCorrectness as { nodeBinarySha256: string; seedAcceptance: string };
  assert(profile && typeof profile === "object", "Missing cache profile");
  assert.match(profile.nodeBinarySha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(metadata.cacheCorrectness, {
    policy: COMPILER_CACHE_POLICY,
    compilerPath: "/compiler/tsc",
    libraryPath: "/compiler",
    fixturePath: "/case",
    nodeVersion: "v24.16.0",
    nodeBinarySha256: profile.nodeBinarySha256,
    fileLimit: COMPILER_CACHE_FILE_LIMIT,
    scratchLimit: 3 * COMPILER_CACHE_FILE_LIMIT,
    evidenceLimit: COMPILER_CACHE_EVIDENCE_LIMIT,
    performanceEligible: false,
    seedAcceptance: "A seed is offered; compiler cache acceptance is not inferred.",
  });
  assert.equal(metadata.capacityControl, undefined);
  assert.equal(metadata.cpus, 4);
  assert.equal(metadata.limits?.memoryBytes, 12 * 1024 ** 3);
  assert.equal(metadata.limits?.swapBytes, 0);
  assert.equal(metadata.repeats, 1);
  assert.equal(metadata.group, 0);
  assert.equal(metadata.groups, 1);
  assert.equal(metadata.ciPolicy?.env.GOMAXPROCS, "2");
  assert.equal(metadata.ciPolicy?.env.GOGC, "30");
  assert.equal(metadata.ciPolicy?.env.GOMEMLIMIT, "3GiB");
  assert.equal(metadata.ciPolicy?.env.GODEBUG, undefined);
  const smoke = metadata.cacheWrapperSmoke as {
    exits: (CacheExecution & { cacheSha256: string; admitted: boolean })[];
    deadline: CacheExecution;
    exportFailure: CacheExecution;
  };
  assert(smoke, "Missing cache wrapper admission");
  assert.deepEqual(
    smoke.exits.map((receipt) => receipt.processExitCode),
    [0, 1, 2, 137],
  );
  for (const receipt of smoke.exits) {
    const exitCode = receipt.processExitCode!;
    assert.equal(receipt.admitted, exitCode !== 137);
    assert.equal(receipt.cacheSha256, hash("{}"));
    if (exitCode === 137) {
      assert.throws(() => assertCompilerCacheExecution(receipt, exitCode));
      assert.equal(receipt.cleanupVerified, true);
    } else {
      assertCompilerCacheExecution(receipt, exitCode);
    }
  }
  assert.equal(smoke.exportFailure.processExitCode, 77);
  assert.equal(smoke.exportFailure.processSignal, null);
  assert.equal(smoke.exportFailure.infrastructureError, undefined);
  assert.equal(smoke.exportFailure.cleanupVerified, true);
  assert.deepEqual(smoke.exportFailure.preCleanupState, {
    available: true,
    Status: "exited",
    Running: false,
    OOMKilled: false,
    ExitCode: 77,
  });
  assert.equal(smoke.deadline.processSignal, "SIGKILL");
  assert.equal(smoke.deadline.cleanupVerified, true);
  assert.throws(() => assertCompilerCacheExecution(smoke.deadline, 0));
  const plan = compilerCachePlan();
  assert.equal(plan.length, 56);
  assert.deepEqual(
    metadata.expectedSamples,
    plan.map((phase) => phase.id),
    "Incomplete cache plan",
  );
  const contract = JSON.parse(read("cache-contract.json")) as {
    policy: string;
    phases: CacheRecord[];
    evidenceBytes: number;
  };
  assert.equal(contract.policy, COMPILER_CACHE_POLICY);
  assert.equal(contract.phases.length, plan.length, "Missing cache phase");
  const rows = JSON.parse(read("measurements.json")) as CacheMeasurement[];
  assert.deepEqual(
    rows.map((row) => row.id),
    plan.map((phase) => phase.id),
    "Missing cache measurement",
  );
  const caches = new Map<string, Buffer>();
  const libraryNames = new Set(metadata.libraryManifest.map((entry) => entry.name));
  const outputs = new Map<string, CacheReceipt>();
  const outcomes = new Map<string, { exitCode: number; stdout: string; stderr: string }>();
  const comparisons: { phase: string; expected: boolean; freshEquivalent: boolean | null }[] = [];
  let evidenceBytes = 0;
  const checkCache = (receipt: CacheReceipt, expectedName: string) => {
    assert.equal(receipt.file, expectedName, "Unexpected cache path");
    const bytes = readCompilerCacheFile(path.join(directory, "cache", expectedName));
    assert(bytes.length > 0, "Empty cache output");
    assert.equal(receipt.bytes, bytes.length);
    assert.equal(receipt.sha256, hash(bytes), "Cache hash mismatch");
    if (!caches.has(expectedName)) {
      evidenceBytes += bytes.length;
      assert(evidenceBytes <= COMPILER_CACHE_EVIDENCE_LIMIT);
      caches.set(expectedName, bytes);
    }
    return bytes;
  };
  for (const [index, phase] of plan.entries()) {
    const record = contract.phases[index]!;
    const { input, inputSha256, seedCache, outputCache, ...declaredPhase } = record;
    assert.deepEqual(declaredPhase, phase, "Changed cache phase");
    assert.deepEqual(input, compilerCacheFixture(phase.state), "Changed fixture inputs");
    assert.equal(inputSha256, hash(JSON.stringify(input)));
    if (phase.seed) {
      const producer = outputs.get(phase.seed);
      assert(producer && seedCache, "Missing predecessor cache");
      if (phase.truncate) {
        const original = caches.get(producer.file)!;
        assert.deepEqual(
          checkCache(seedCache, `seed-${phase.id}.tsbuildinfo`),
          original.subarray(0, Math.floor(original.length / 2)),
        );
      } else {
        assert.deepEqual(seedCache, producer, "Receiver did not use immutable producer cache");
      }
    } else {
      assert.equal(seedCache, null);
    }
    const bytes = checkCache(outputCache, phase.id + ".tsbuildinfo");
    const buildInfo = JSON.parse(bytes.toString("utf8")) as {
      fileNames: string[];
      version: string;
    };
    assert(typeof buildInfo.version === "string" && buildInfo.version.length > 0);
    assert(Array.isArray(buildInfo.fileNames) && buildInfo.fileNames.length > 0);
    const sourcePaths = new Set([
      ...Object.keys(input).map((name) => `/case/${name}`),
      ...[...libraryNames].map((name) => `/compiler/${name}`),
    ]);
    for (const name of buildInfo.fileNames) {
      assert(typeof name === "string");
      // Build-info stores default libraries as bare names; the compiler resolves
      // them against its library directory, not the build-info directory.
      const isPath = name.startsWith("/") || name.startsWith("./") || name.startsWith("../");
      assert(isPath || libraryNames.has(name), "Unexpected cache source path");
      assert(
        sourcePaths.has(path.posix.resolve(isPath ? "/cache" : "/compiler", name)),
        "Unexpected cache source path",
      );
    }
    outputs.set(phase.id, outputCache);
    const row = rows[index]!;
    assert.equal(row.compiler, phase.compiler);
    assert.equal(row.graph, "cache-contract");
    assert.equal(row.config, "/case/tsconfig.json");
    assert.equal(row.mode, "incremental-cold");
    assert.equal(row.iteration, 1);
    assert.deepEqual(row.flags, [
      "-p",
      "/case/tsconfig.json",
      "--noEmit",
      "--declaration",
      "false",
      "--pretty",
      "false",
      "--incremental",
      "true",
      "--tsBuildInfoFile",
      "/cache/project.tsbuildinfo",
      "--singleThreaded",
      "--checkers",
      "1",
    ]);
    const metric = JSON.parse(read(`metrics/${phase.id}.json`)) as CacheExecution &
      Pick<
        CacheMeasurement,
        "exitCode" | "wallSeconds" | "userSeconds" | "sysSeconds" | "peakRssKiB"
      >;
    assert([0, 1, 2].includes(row.exitCode), "Invalid compiler exit");
    assert.equal(metric.exitCode, row.exitCode);
    assertCompilerCacheExecution(metric, row.exitCode);
    for (const key of ["wallSeconds", "userSeconds", "sysSeconds", "peakRssKiB"] as const) {
      assert(Number.isFinite(row[key]) && row[key] >= 0);
      assert.equal(metric[key], row[key]);
    }
    // All phases have the same virtual paths. No alias normalization can hide a difference.
    const stdout = read(phase.id + ".stdout");
    const stderr = read(phase.id + ".stderr");
    assert.equal(hash(stdout), row.diagnosticSha256);
    assert.equal(Buffer.byteLength(stdout), row.stdoutBytes);
    assert.equal(Buffer.byteLength(stderr), row.stderrBytes);
    const codes = [...stdout.matchAll(/error TS(\d+):/gu)].map((match) => Number(match[1]));
    const expectedCodes = phase.state === "clean" ? [] : [phase.state === "missing" ? 2307 : 2322];
    const expectedExit = phase.state === "clean" ? 0 : phase.compiler === "reference" ? 1 : 2;
    const expected =
      row.exitCode === expectedExit &&
      stderr === "" &&
      JSON.stringify(codes) === JSON.stringify(expectedCodes) &&
      (phase.state !== "clean" || stdout === "");
    outcomes.set(phase.id, { exitCode: row.exitCode, stdout, stderr });
    comparisons.push({ phase: phase.id, expected, freshEquivalent: null });
  }
  assert.equal(contract.evidenceBytes, evidenceBytes);
  assert.deepEqual(
    fs.readdirSync(path.join(directory, "cache")).toSorted(),
    [...caches.keys()].toSorted(),
    "Unexpected cache inventory",
  );
  assert.deepEqual(
    fs.readdirSync(path.join(directory, "metrics")).toSorted(),
    plan.map((phase) => phase.id + ".json").toSorted(),
    "Unexpected execution receipt inventory",
  );
  for (const [index, phase] of plan.entries()) {
    if (phase.control) {
      comparisons[index]!.freshEquivalent =
        JSON.stringify(outcomes.get(phase.id)) === JSON.stringify(outcomes.get(phase.control));
    }
  }
  const pinnedCandidateEquivalent = plan
    .filter((phase) => phase.id.startsWith("candidate-") && !phase.id.startsWith("candidate-to-"))
    .every(
      (phase) =>
        JSON.stringify(outcomes.get(phase.id)) ===
        JSON.stringify(outcomes.get(phase.id.replace(/^candidate-/u, "pinned-"))),
    );
  const passed =
    pinnedCandidateEquivalent &&
    comparisons.every((row) => row.expected && row.freshEquivalent !== false);
  return {
    status: passed ? "equivalent" : "divergent",
    qualificationPassed: passed,
    cacheCorrectnessPassed: passed,
    performanceEligible: false,
    plannedCalls: plan.length,
    completedCalls: rows.length,
    pinnedCandidateEquivalent,
    cacheComparisons: comparisons,
    evidenceBytes,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 5);
    assert.equal(process.argv[2], "copy");
    copyCompilerCacheFile(process.argv[3]!, process.argv[4]!);
  } catch {
    // A transport error must not become a valid compiler diagnostic exit 1 or 2.
    console.error("[compiler-cache] transport failed");
    console.error("[compiler-cache] FAILED (exit 77)");
    process.exitCode = 77;
  }
}
