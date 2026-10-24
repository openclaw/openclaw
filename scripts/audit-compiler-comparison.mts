import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { auditCompilerCache } from "./lib/compiler-comparison-cache.mts";
import {
  assertCompilerNetworkIsolation,
  type CompilerNetworkEvidence,
} from "./lib/compiler-comparison-io.mts";
import { auditCompilerRows } from "./lib/compiler-comparison-rows.mts";

type Graph = { name: string; config: string };
type Canary = Graph & {
  kind: "control" | "port-probe" | "version-probe";
  expectedCodes?: number[];
  source?: string;
};
type Compiler = "pinned" | "candidate" | "reference";
type Measurement = {
  graph: string;
  config: string;
  mode: string;
  compiler: Compiler;
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
type Outcome = { exitCode: number; stdout: string; stderr: string };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
// Only the collector's library mount aliases differ. Diagnostic order, locations,
// messages and all other paths remain evidence, including global diagnostics.
const normalize = (value: string) =>
  value.replaceAll("/pin/", "/libs/").replaceAll("/reference/", "/libs/");
const hashPattern = /^[a-f0-9]{64}$/u;

/** Audit one collector group. Completion covers its declared graphs, not all CI. */
export function auditCompilerComparison(directory: string) {
  const read = (name: string) => fs.readFileSync(path.join(directory, name), "utf8");
  const networkIsolation = assertCompilerNetworkIsolation(
    JSON.parse(read("network-isolation.json")) as CompilerNetworkEvidence,
  );
  const metadata = JSON.parse(read("metadata.json")) as {
    sourceHead: string;
    repeats: number;
    group: number;
    groups: number;
    binarySha256: Record<Compiler, string>;
    libraryManifest: { name: string; sha256: string }[];
    expectedSamples?: string[];
    canaries?: Canary[];
    memoryDiagnostic?: unknown;
    capacityControl?: unknown;
    cacheCorrectness?: unknown;
    cacheWrapperSmoke?: unknown;
    ciPolicy?: { args: string[]; env: Record<string, string> };
    cpus?: number;
    limits?: { memoryBytes: number; swapBytes: number };
  };
  assert.equal(
    metadata.memoryDiagnostic,
    undefined,
    "Memory diagnostics are not qualification evidence",
  );
  assert(metadata.capacityControl === undefined || metadata.capacityControl === true);
  if (metadata.capacityControl) {
    assert.equal(metadata.cpus, 4, "Capacity control requires four CPUs");
    assert.equal(metadata.limits?.memoryBytes, 24 * 1024 ** 3, "Capacity control requires 24 GiB");
    assert.equal(metadata.limits?.swapBytes, 0, "Capacity control forbids swap");
  }
  const inventory = JSON.parse(read("inventory.json")) as {
    inventory: Graph[];
    graphs: Graph[];
    group: number;
    groups: number;
  };
  const parity = (metadata.cacheCorrectness ? [] : JSON.parse(read("input-parity.json"))) as {
    graph: string;
    proofs: Record<Compiler, Record<"config" | "files", { sha256: string }>>;
  }[];
  const measurements = JSON.parse(read("measurements.json")) as Measurement[];
  assert.match(metadata.sourceHead, /^[a-f0-9]{40}$/u, "Invalid source identity");
  assert(Number.isInteger(metadata.repeats) && metadata.repeats > 0 && metadata.repeats <= 10);
  assert(Number.isInteger(metadata.groups) && metadata.groups > 0);
  assert(
    Number.isInteger(metadata.group) && metadata.group >= 0 && metadata.group < metadata.groups,
  );
  assert.equal(inventory.group, metadata.group);
  assert.equal(inventory.groups, metadata.groups);
  assert(inventory.inventory.length > 0, "Empty graph inventory");
  assert.equal(
    new Set(inventory.inventory.map((graph) => graph.name)).size,
    inventory.inventory.length,
  );
  assert.deepEqual(
    inventory.graphs,
    inventory.inventory.filter((_, index) => index % metadata.groups === metadata.group),
    "Selected graphs differ from the declared partition",
  );
  assert(inventory.graphs.length > 0, "Empty group");
  const canaries = metadata.canaries ?? [];
  const graphs = [...inventory.graphs, ...canaries];
  assert.equal(new Set(graphs.map((graph) => graph.name)).size, graphs.length);
  for (const canary of canaries) {
    assert(canary.name.startsWith("canary-"));
    assert(["control", "port-probe", "version-probe"].includes(canary.kind));
    assert(metadata.expectedSamples, "Canaries require a complete sample plan");
    assert(canary.kind === "version-probe" || canary.expectedCodes, "Missing canary expectation");
    assert(canary.expectedCodes?.every((code) => Number.isInteger(code) && code > 0) ?? true);
  }
  for (const compiler of ["pinned", "candidate", "reference"] as const) {
    assert.match(
      metadata.binarySha256[compiler],
      hashPattern,
      `Missing ${compiler} binary identity`,
    );
  }
  assert(metadata.libraryManifest.length > 0, "Missing library identity");
  assert.equal(
    new Set(metadata.libraryManifest.map((entry) => entry.name)).size,
    metadata.libraryManifest.length,
    "Duplicate library identity",
  );
  for (const entry of metadata.libraryManifest) {
    assert.match(entry.name, /^lib(?:\.[\w.-]+)?\.d\.ts$/u);
    assert.match(entry.sha256, hashPattern);
  }
  if (metadata.cacheCorrectness !== undefined) {
    assert.deepEqual(inventory.inventory, [
      { name: "cache-contract", config: "/case/tsconfig.json" },
    ]);
    assert.deepEqual(canaries, []);
    return {
      sourceHead: metadata.sourceHead,
      binarySha256: metadata.binarySha256,
      libraryManifestSha256: digest(JSON.stringify(metadata.libraryManifest)),
      scope: {
        purpose: "synthetic-cache-correctness",
        networkIsolation,
        graphs: inventory.graphs,
        capacityControl: false,
        group: 0,
        groups: 1,
        canaries: [],
        plannedSamples: 56,
        referenceInputsVerified: false,
      },
      typecheckPassed: null,
      canariesPassed: null,
      missing: [],
      comparisons: [] as typeof comparisons,
      ...auditCompilerCache(directory, metadata),
    };
  }

  const missing: string[] = [];
  const expected = metadata.expectedSamples;
  if (expected) {
    assert(expected.length > 0 && expected.every((id) => typeof id === "string"));
    assert.equal(new Set(expected).size, expected.length, "Duplicate planned sample");
  }
  const inputs = new Map<string, boolean>();
  assert.equal(
    new Set(parity.map((entry) => entry.graph)).size,
    parity.length,
    "Duplicate input proof",
  );
  for (const graph of graphs) {
    assert.match(graph.name, /^[\w-]+$/u, "Invalid graph name");
    const proof = parity.find((entry) => entry.graph === graph.name);
    if (!proof) {
      missing.push(`${graph.name}: input proof`);
      continue;
    }
    let equal = true;
    for (const label of ["config", "files"] as const) {
      const compilers: Compiler[] = expected
        ? ["pinned", "candidate", "reference"]
        : ["pinned", "candidate"];
      const values = compilers.map((compiler) => {
        const output = normalize(read(`${graph.name}-${compiler}-${label}.txt`));
        assert(output.length > 0, `Empty ${graph.name}/${compiler}/${label}`);
        assert.equal(digest(output), proof.proofs[compiler][label].sha256, "Input hash mismatch");
        if (label === "config") {
          const config = JSON.parse(output) as { compilerOptions: { noCheck?: unknown } };
          assert(
            config.compilerOptions.noCheck === undefined ||
              config.compilerOptions.noCheck === false,
            "Expanded configuration disables typechecking",
          );
        }
        return output;
      });
      equal &&= values.every((value) => value === values[0]);
    }
    inputs.set(graph.name, equal);
  }
  assert(parity.every((entry) => graphs.some((graph) => graph.name === entry.graph)));

  const samples = new Map<string, Outcome[]>();
  const iterations = new Set<string>();
  const flags = new Map<string, string>();
  for (const row of measurements) {
    const graph = graphs.find((entry) => entry.name === row.graph);
    assert(graph && graph.config === row.config, "Measurement outside declared graphs");
    assert(
      ["incremental-cold", "nonincremental", "single-threaded", "incremental-unthrottled"].includes(
        row.mode,
      ),
    );
    assert(["pinned", "candidate", "reference"].includes(row.compiler));
    assert(
      Number.isInteger(row.iteration) && row.iteration >= 1 && row.iteration <= metadata.repeats,
    );
    assert([0, 1, 2].includes(row.exitCode), "Unexpected compiler exit (not typecheck evidence)");
    for (const value of [row.wallSeconds, row.userSeconds, row.sysSeconds, row.peakRssKiB]) {
      assert(Number.isFinite(value) && value >= 0, "Invalid measurement");
    }
    const key = `${row.graph}/${row.mode}`;
    const id = [row.graph, row.mode, row.compiler, row.iteration].join("-");
    assert(!expected || expected.includes(id), `Unplanned sample ${id}`);
    assert(!iterations.has(id), `Duplicate sample ${id}`);
    iterations.add(id);
    assert(Array.isArray(row.flags) && row.flags.every((flag) => typeof flag === "string"));
    const incremental = row.mode.startsWith("incremental-");
    const expectedFlags = [
      "-p",
      graph.config,
      "--noEmit",
      "--declaration",
      "false",
      "--pretty",
      "false",
      "--incremental",
      incremental ? "true" : "false",
      ...(incremental ? ["--tsBuildInfoFile", "/cache/project.tsbuildinfo"] : []),
      ...(row.mode === "single-threaded" ? ["--singleThreaded"] : []),
    ];
    // Pin the collector's checking contract: equal --noCheck/query invocations
    // or a different -p target must never become a passing qualification.
    if (row.mode === "incremental-cold" && row.flags.length > expectedFlags.length) {
      expectedFlags.push("--singleThreaded", "--checkers", "1");
    }
    assert.deepEqual(row.flags, expectedFlags, `Invalid checking invocation: ${id}`);
    const serializedFlags = JSON.stringify(row.flags);
    assert(!flags.has(key) || flags.get(key) === serializedFlags, `Different flags for ${key}`);
    flags.set(key, serializedFlags);
    const stdout = normalize(read(`${id}.stdout`));
    const stderr = read(`${id}.stderr`);
    assert.equal(digest(stdout), row.diagnosticSha256, `Diagnostic hash mismatch: ${id}`);
    assert.equal(Buffer.byteLength(stdout), row.stdoutBytes, `Stdout size mismatch: ${id}`);
    assert.equal(Buffer.byteLength(stderr), row.stderrBytes, `Stderr size mismatch: ${id}`);
    const sampleKey = `${key}/${row.compiler}`;
    const values = samples.get(sampleKey) ?? [];
    values.push({ exitCode: row.exitCode, stdout, stderr });
    samples.set(sampleKey, values);
  }
  // A declared control profile or reference must not vanish just because its
  // entire batch failed before writing the first measurement.
  for (const id of expected ?? []) {
    if (!iterations.has(id)) {
      missing.push(`Planned sample missing: ${id}`);
    }
  }

  // Primary coverage is mandatory. Additional modes are scoped to those actually
  // collected; an absent reference is reported, never invented from the core run.
  const keys = new Set(inventory.graphs.map((graph) => `${graph.name}/incremental-cold`));
  for (const canary of canaries) {
    for (const mode of ["nonincremental", "single-threaded"]) {
      keys.add(`${canary.name}/${mode}`);
    }
  }
  for (const key of flags.keys()) {
    keys.add(key);
  }
  const comparisons = [...keys].map((key) => {
    const [graphName] = key.split("/");
    assert(graphName);
    const canary = canaries.find((entry) => entry.name === graphName);
    const outcomes = new Map<Compiler, Outcome>();
    const stability = new Map<Compiler, boolean>();
    for (const compiler of ["pinned", "candidate", "reference"] as const) {
      const values = samples.get(`${key}/${compiler}`);
      if (!values && compiler === "reference" && !canary) {
        continue;
      }
      if (values?.length !== metadata.repeats) {
        missing.push(
          `${key}/${compiler}: expected ${metadata.repeats}, found ${values?.length ?? 0}`,
        );
      }
      const first = values?.[0];
      if (first) {
        stability.set(
          compiler,
          values?.length === metadata.repeats &&
            values.every((value) => JSON.stringify(value) === JSON.stringify(first)),
        );
        outcomes.set(compiler, first);
      }
    }
    const pinned = outcomes.get("pinned");
    const candidate = outcomes.get("candidate");
    const reference = outcomes.get("reference");
    const inputEqual = inputs.get(graphName) === true;
    const stable = stability.get("pinned") === true && stability.get("candidate") === true;
    const equivalent = Boolean(
      pinned &&
      candidate &&
      stable &&
      inputEqual &&
      JSON.stringify(pinned) === JSON.stringify(candidate),
    );
    // Negative controls must still fail in both upstream baselines. Equal empty
    // output from a skipped check cannot qualify a compiler as correct or fast.
    const expectedDiagnosticsMatch = canary?.expectedCodes
      ? [pinned, reference].every((outcome) => {
          if (!outcome || outcome.stderr !== "") {
            return false;
          }
          const codes = [
            ...new Set(
              [...outcome.stdout.matchAll(/\berror TS(\d+):/gu)].map((match) => Number(match[1])),
            ),
          ].toSorted((a, b) => a - b);
          return (
            JSON.stringify(codes) ===
              JSON.stringify(canary.expectedCodes?.toSorted((a, b) => a - b)) &&
            (codes.length
              ? outcome.exitCode !== 0
              : outcome.exitCode === 0 && outcome.stdout === "")
          );
        })
      : null;
    return {
      key,
      canary: canary?.kind ?? null,
      expectedDiagnosticsMatch,
      inputEqual,
      stable,
      equivalent,
      typecheckPassed:
        equivalent && pinned?.exitCode === 0 && pinned.stdout === "" && pinned.stderr === "",
      pinnedExit: pinned?.exitCode ?? null,
      candidateExit: candidate?.exitCode ?? null,
      referenceStable: reference ? stability.get("reference") === true : null,
      referenceOutcomeMatches:
        reference && candidate && stability.get("reference") && stability.get("candidate")
          ? JSON.stringify(reference) === JSON.stringify(candidate)
          : null,
    };
  });
  const canariesPassed = canaries.length
    ? comparisons
        .filter((row) => row.canary)
        .every(
          (row) => row.equivalent && row.referenceStable && row.expectedDiagnosticsMatch !== false,
        )
    : null;
  const typecheckPassed =
    missing.length === 0 &&
    comparisons.filter((row) => !row.canary).every((row) => row.typecheckPassed);
  return {
    sourceHead: metadata.sourceHead,
    binarySha256: metadata.binarySha256,
    libraryManifestSha256: digest(
      JSON.stringify(metadata.libraryManifest.toSorted((a, b) => (a.name < b.name ? -1 : 1))),
    ),
    scope: {
      networkIsolation,
      capacityControl: metadata.capacityControl === true,
      group: metadata.group,
      groups: metadata.groups,
      graphs: inventory.graphs,
      canaries,
      plannedSamples: expected?.length ?? null,
      referenceInputsVerified: Boolean(expected) && inputs.size === graphs.length,
    },
    status: missing.length
      ? "incomplete"
      : comparisons.every((row) => row.equivalent) && canariesPassed !== false
        ? "equivalent"
        : "divergent",
    typecheckPassed,
    canariesPassed,
    qualificationPassed: typecheckPassed && canariesPassed !== false,
    missing,
    comparisons,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assert.equal(
      process.argv.length,
      3,
      "Usage: node scripts/audit-compiler-comparison.mts <artifact-group>",
    );
    const directory = process.argv[2];
    assert(directory);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, "metadata.json"), "utf8")) as {
      wrapperAdmission?: unknown;
    };
    const verdict =
      metadata.wrapperAdmission === undefined
        ? auditCompilerComparison(directory)
        : {
            networkIsolation: assertCompilerNetworkIsolation(
              JSON.parse(
                fs.readFileSync(path.join(directory, "network-isolation.json"), "utf8"),
              ) as CompilerNetworkEvidence,
            ),
            ...auditCompilerRows(directory),
          };
    console.log(JSON.stringify(verdict, null, 2));
    process.exitCode = verdict.qualificationPassed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    const missingFile = error instanceof Error && "code" in error && error.code === "ENOENT";
    console.log(
      JSON.stringify({ status: missingFile ? "incomplete" : "invalid", typecheckPassed: false }),
    );
    process.exitCode = 2;
  }
  if (process.exitCode) {
    console.error(`[compiler-comparison] FAILED (exit ${process.exitCode})`);
  }
}
