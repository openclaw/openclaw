import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { assertSealedSeed, NODE_CACHE_DISABLED_INPUTS } from "./node-cache-disabled-control.mts";
import {
  assertDefinitionSources,
  hashPreparedPnpmExecutable,
  validateWorkloadDefinition,
} from "./node-cache-workload-inputs.mts";
import { parseNodeCacheDiagnostic } from "./node-compile-cache-diagnostics.mts";
import {
  parseVitestExecutionReport,
  sha256,
  validateNodeCacheManifest,
  withTerminalManifest,
  writeJsonAtomic,
  type NodeCacheManifest,
} from "./vitest-pair-benchmark-contract.mts";
import {
  buildNodeCacheVitestArgs,
  ownedDirectory,
  withVitestPairDeadline,
  type VitestPairDeadline,
} from "./vitest-pair-benchmark.mts";

type FileIdentity = NodeCacheManifest["inputs"][number];
type QualificationProvenance = {
  version: 1;
  qualificationDir: string;
  controlScratchDir: string;
  harnessSha: string;
  harnessInputs: FileIdentity[];
  workloadDir: string;
  workloadSha: string;
  workloadTree: string;
  definitionSha256: string;
  definitionFile: FileIdentity;
  preparedSha256: string;
  runtime: NodeCacheManifest["runtime"];
  pnpmExecutable: string;
  pnpmSha256: string;
  seedSha256: string;
  receipts: FileIdentity[];
};

function requireEqual(actual: unknown, expected: unknown, label: string) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`Node cache qualification ${label} differs`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Node cache qualification ${label} must be an object`);
  }
  return value;
}

export function readNodeCacheQualification(input: {
  qualificationDir: string;
  definitionPath: string;
  workloadDir: string;
  harnessSha: string;
  pnpmBin: string;
  deadline: VitestPairDeadline;
}): {
  manifest: NodeCacheManifest;
  preparedSha256: string;
  provenance: QualificationProvenance;
  revalidate: () => void;
} {
  const { deadline } = input;
  deadline.throwIfExpired();
  const harness = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  const workload = path.resolve(input.workloadDir);
  const qualification = path.resolve(input.qualificationDir);
  const roots = [harness, workload, qualification];
  for (const root of roots) {
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) {
      throw new Error("Node cache qualification requires physical directories");
    }
    if (roots.some((other) => other !== root && root.startsWith(other + path.sep))) {
      throw new Error("Node cache qualification directories must be disjoint");
    }
  }
  if (new Set(roots).size !== roots.length) {
    throw new Error("Node cache qualification directories must be disjoint");
  }
  const rootIdentities = roots.map((root) => ({ root, stat: lstatSync(root) }));
  const bindings = new Map<string, FileIdentity>();
  const readPhysical = (file: string) => {
    deadline.throwIfExpired();
    const absolute = path.resolve(file);
    if (realpathSync(absolute) !== absolute || !lstatSync(absolute).isFile()) {
      throw new Error(`Node cache qualification requires a regular physical file: ${file}`);
    }
    const bytes = readFileSync(absolute);
    deadline.throwIfExpired();
    return bytes;
  };
  const readBound = (file: string) => {
    const absolute = path.resolve(file);
    const bytes = readPhysical(absolute);
    bindings.set(absolute, { path: absolute, bytes: bytes.length, sha256: sha256(bytes) });
    return bytes;
  };
  const readReceipt = (name: string) =>
    record(JSON.parse(readBound(path.join(qualification, name)).toString("utf8")), name);
  const git = (root: string, args: string[]) => {
    deadline.throwIfExpired();
    const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: Math.max(1, Math.min(10_000, deadline.deadlineAt - Date.now())),
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Node cache qualification Git read failed: ${args[0]}`);
    }
    deadline.throwIfExpired();
    return result.stdout.trim();
  };

  const definition = validateWorkloadDefinition(
    JSON.parse(readBound(input.definitionPath).toString("utf8")),
  );
  const definitionSha256 = sha256(JSON.stringify(definition));
  const terminal = readReceipt("terminal-manifest.json");
  const summary = readReceipt("qualification.json");
  if (
    terminal.version !== 1 ||
    terminal.status !== "success" ||
    terminal.error !== undefined ||
    typeof terminal.startedAt !== "string" ||
    typeof terminal.finishedAt !== "string" ||
    !Number.isFinite(Date.parse(terminal.startedAt)) ||
    !Number.isFinite(Date.parse(terminal.finishedAt)) ||
    Date.parse(terminal.finishedAt) < Date.parse(terminal.startedAt)
  ) {
    throw new Error("Node cache qualification requires a successful terminal receipt");
  }
  requireEqual(summary.version, 1, "version");
  requireEqual(summary.kind, "node-cache-workload-qualification", "kind");
  requireEqual(summary.scope, "disabled-empty-seeded", "scope");
  requireEqual(summary.status, "success", "status");
  requireEqual(summary.error, null, "error");
  requireEqual(summary.processTreeSettled, true, "settlement");
  requireEqual(summary.cleanup, "removed-owned-scratch", "cleanup");
  requireEqual(summary.timingAdmission, false, "control timing admission");
  const controlScratchDir = summary.controlScratchDir;
  if (
    typeof controlScratchDir !== "string" ||
    !path.isAbsolute(controlScratchDir) ||
    controlScratchDir === path.parse(controlScratchDir).root ||
    path.normalize(controlScratchDir) !== controlScratchDir ||
    roots.some(
      (root) =>
        root === controlScratchDir ||
        root.startsWith(controlScratchDir + path.sep) ||
        controlScratchDir.startsWith(root + path.sep),
    )
  ) {
    throw new Error("Node cache qualification control scratch path differs");
  }
  requireEqual(
    summary.controls,
    ["disabled", "empty", "seeded"].map((kind) => ({ kind, status: "success" })),
    "ordered controls",
  );
  requireEqual(summary.definition, definition, "definition");
  requireEqual(summary.definitionSha256, definitionSha256, "definition hash");
  if (!/^[0-9a-f]{40}$/u.test(input.harnessSha)) {
    throw new Error("Node cache qualification requires an exact harness SHA");
  }
  requireEqual(summary.harnessSha, input.harnessSha, "harness SHA");
  const assertSources = () => {
    deadline.throwIfExpired();
    requireEqual(git(harness, ["rev-parse", "HEAD"]), input.harnessSha, "current harness SHA");
    requireEqual(
      git(harness, ["status", "--porcelain=v1", "--untracked-files=all"]),
      "",
      "clean harness",
    );
    requireEqual(git(workload, ["rev-parse", "HEAD"]), definition.workloadSha, "workload SHA");
    requireEqual(
      git(workload, ["rev-parse", "HEAD^{tree}"]),
      definition.workloadTree,
      "workload tree",
    );
    requireEqual(
      git(workload, ["status", "--porcelain=v1", "--untracked-files=all"]),
      "",
      "clean workload",
    );
    requireEqual(
      {
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        architecture: process.arch,
        executableSha256: sha256(readPhysical(process.execPath)),
      },
      definition.runtime,
      "runtime",
    );
    requireEqual(hashPreparedPnpmExecutable(input.pnpmBin), summary.pnpmSha256, "native pnpm");
    assertDefinitionSources(workload, definition);
    deadline.throwIfExpired();
  };
  assertSources();
  requireEqual(summary.pnpmExecutable, input.pnpmBin, "pnpm path");
  requireEqual(
    readBound(path.join(qualification, "pnpm-version.log")).toString("utf8").trim(),
    definition.pnpmVersion,
    "pnpm version",
  );
  const harnessInputs = NODE_CACHE_DISABLED_INPUTS.map((relative) => {
    const bytes = readBound(path.join(harness, relative));
    requireEqual(
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
      git(harness, ["rev-parse", `${input.harnessSha}:${relative}`]),
      `committed harness input ${relative}`,
    );
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });
  requireEqual(summary.harnessInputs, harnessInputs, "complete harness closure");
  const prepared: unknown = JSON.parse(
    readBound(path.join(qualification, "prepared-inventory.json")).toString("utf8"),
  );
  if (!Array.isArray(prepared) || prepared.length === 0) {
    throw new Error("Node cache qualification prepared inventory is missing");
  }
  const preparedSha256 = sha256(JSON.stringify(prepared));
  const seed = record(summary.seed, "seed");
  const manifest = validateNodeCacheManifest({
    version: 2,
    mode: "node-compile-cache",
    workloadSha: definition.workloadSha,
    lane: definition.lane,
    expected: definition.expected,
    runtime: definition.runtime,
    pnpmSha256: summary.pnpmSha256,
    inputs: definition.sourceIdentities.map((entry) => ({
      ...entry,
      bytes: readBound(path.join(workload, entry.path)).length,
    })),
    seed: { files: seed.files },
  });
  const seedSha256 = sha256(JSON.stringify(manifest.seed.files));
  requireEqual(seed.sha256, seedSha256, "seed hash");
  requireEqual(seed.fileMode, "0400", "seed file mode");
  requireEqual(seed.directoryMode, "0500", "seed directory mode");
  const seedRoot = path.join(qualification, "seed");
  assertSealedSeed(seedRoot, manifest.seed.files);
  const sourceUrl = pathToFileURL(path.join(workload, "scripts/run-vitest.mjs")).href;
  const normalizedArgsSha256 = sha256(
    JSON.stringify(buildNodeCacheVitestArgs(definition.lane, "/report/vitest.json")),
  );
  let launcherCacheFile: string | undefined;
  for (const kind of ["disabled", "empty", "seeded"] as const) {
    const control = readReceipt(`${kind}.json`);
    for (const [key, value] of Object.entries({
      version: 1,
      kind: `node-cache-${kind}-control`,
      scope: "disabled-empty-seeded",
      controlKind: kind,
      controlAttempted: true,
      status: "success",
      error: null,
      exitCode: 0,
      processTreeSettled: true,
      timingAdmission: false,
      controlScratchDir,
      definition,
      definitionSha256,
      harnessSha: input.harnessSha,
      harnessInputs,
      pnpmExecutable: input.pnpmBin,
      pnpmSha256: manifest.pnpmSha256,
      preparedSha256,
      seedSha256: kind === "disabled" ? null : seedSha256,
    })) {
      requireEqual(control[key], value, `${kind} ${key}`);
    }
    requireEqual(
      control.checks,
      {
        oracle: { status: "passed" },
        diagnostic: { status: "passed" },
        inventory: { status: "passed" },
      },
      `${kind} checks`,
    );
    for (const key of ["logHashError", "reportHashError", "inventoryError"]) {
      requireEqual(control[key], undefined, `${kind} ${key}`);
    }
    const inventory = record(control.inventory, `${kind} inventory`);
    requireEqual(inventory.beforeSha256, preparedSha256, `${kind} initial inventory`);
    requireEqual(inventory.afterSha256, preparedSha256, `${kind} final inventory`);
    requireEqual(
      inventory.counts,
      { before: prepared.length, after: prepared.length, added: 0, removed: 0, changed: 0 },
      `${kind} inventory counts`,
    );
    for (const key of ["added", "removed", "changed"]) {
      requireEqual(inventory[key], [], `${kind} inventory ${key}`);
    }
    const reportFile = path.join(qualification, `${kind}.vitest.json`);
    const report = readBound(reportFile);
    const log = readBound(path.join(qualification, `${kind}.log`));
    requireEqual(control.reportSha256, sha256(report), `${kind} report hash`);
    requireEqual(control.logSha256, sha256(log), `${kind} log hash`);
    requireEqual(
      control.args,
      buildNodeCacheVitestArgs(definition.lane, reportFile),
      `${kind} arguments`,
    );
    requireEqual(control.argsSha256, normalizedArgsSha256, `${kind} normalized arguments`);
    requireEqual(
      control.execution,
      parseVitestExecutionReport(reportFile, workload, definition.lane, definition.expected),
      `${kind} oracle`,
    );
    // Scratch was removed after the controls settled; bind its recorded path
    // without requiring that deleted directory to exist again.
    const diagnostic = parseNodeCacheDiagnostic(
      log.toString("utf8"),
      sourceUrl,
      path.join(controlScratchDir, kind, "node-cache"),
    );
    if (kind === "disabled") {
      requireEqual(control.diagnostic, null, "disabled diagnostic");
      requireEqual(diagnostic, null, "disabled native activity");
      const disabled = "[compile cache] Disabled by NODE_DISABLE_COMPILE_CACHE.";
      const allowed = new Set([
        disabled,
        "[compile cache] module.flushCompileCache() requested.",
        "[compile cache] module.flushCompileCache() finished.",
      ]);
      const events = log
        .toString("utf8")
        .split("\n")
        .filter((line) => line.includes("[compile cache]"));
      if (!events.includes(disabled) || events.some((line) => !allowed.has(line))) {
        throw new Error("Node cache qualification disabled native events differ");
      }
    } else {
      const observed = record(control.diagnostic, `${kind} diagnostic`);
      if (
        typeof observed.cacheFile !== "string" ||
        !manifest.seed.files.some((file) => file.path === observed.cacheFile && file.bytes > 0) ||
        !diagnostic ||
        diagnostic.cacheFile !== observed.cacheFile
      ) {
        throw new Error(`Node cache qualification ${kind} cache key differs`);
      }
      requireEqual(
        observed,
        {
          sourceUrl,
          cacheFile: observed.cacheFile,
          read: kind === "empty" ? "missing" : "hit",
          state: kind === "empty" ? "not initialized" : "accepted",
        },
        `${kind} launcher acceptance`,
      );
      requireEqual(
        { ...diagnostic, cacheFile: observed.cacheFile },
        observed,
        `${kind} native log`,
      );
      if (kind === "empty") {
        launcherCacheFile = observed.cacheFile;
      }
      if (kind === "seeded") {
        requireEqual(observed.cacheFile, launcherCacheFile, "seeded launcher key");
        requireEqual(control.seed, seed, "seeded sealed seed");
      }
    }
    deadline.throwIfExpired();
  }
  const revalidate = () => {
    for (const { root, stat } of rootIdentities) {
      const current = lstatSync(root);
      if (realpathSync(root) !== root || current.dev !== stat.dev || current.ino !== stat.ino) {
        throw new Error("Node cache qualification directory identity changed");
      }
    }
    assertSources();
    for (const [file, identity] of bindings) {
      const bytes = readPhysical(file);
      if (bytes.length !== identity.bytes || sha256(bytes) !== identity.sha256) {
        throw new Error(`Node cache qualification admitted file changed: ${file}`);
      }
    }
    assertSealedSeed(seedRoot, manifest.seed.files);
    deadline.throwIfExpired();
  };
  deadline.throwIfExpired();
  return {
    manifest,
    preparedSha256,
    provenance: {
      version: 1,
      qualificationDir: qualification,
      controlScratchDir,
      harnessSha: input.harnessSha,
      harnessInputs,
      workloadDir: workload,
      workloadSha: definition.workloadSha,
      workloadTree: definition.workloadTree,
      definitionSha256,
      definitionFile: bindings.get(path.resolve(input.definitionPath))!,
      preparedSha256,
      runtime: definition.runtime,
      pnpmExecutable: input.pnpmBin,
      pnpmSha256: manifest.pnpmSha256,
      seedSha256,
      receipts: [...bindings.values()]
        .filter((entry) => entry.path.startsWith(qualification + path.sep))
        .map(({ path: file, bytes, sha256: contentSha256 }) => ({
          path: path.relative(qualification, file),
          bytes,
          sha256: contentSha256,
        })),
    },
    revalidate,
  };
}

export async function admitNodeCacheQualification(
  input: Omit<Parameters<typeof readNodeCacheQualification>[0], "deadline"> & {
    outputDir: string;
    timeoutMs: number;
  },
) {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 600_000) {
    throw new Error("Qualification admission requires an explicit deadline of at most 10 minutes");
  }
  const output = path.resolve(input.outputDir);
  const roots = [
    realpathSync(fileURLToPath(new URL("../../", import.meta.url))),
    path.resolve(input.workloadDir),
    path.resolve(input.qualificationDir),
  ];
  for (const root of roots) {
    if (
      realpathSync(root) !== root ||
      !lstatSync(root).isDirectory() ||
      output === root ||
      output.startsWith(root + path.sep) ||
      root.startsWith(output + path.sep)
    ) {
      throw new Error(
        "Admission output must be disjoint from physical harness, workload and qualification directories",
      );
    }
  }
  if (
    realpathSync(path.dirname(output)) !== path.dirname(output) ||
    lstatSync(output, { throwIfNoEntry: false }) !== undefined
  ) {
    throw new Error("Admission output requires an absent directory with a physical parent");
  }
  const checkOutput = ownedDirectory(output);
  await withTerminalManifest(
    output,
    () =>
      withVitestPairDeadline(async (deadline) => {
        const admission = readNodeCacheQualification({ ...input, deadline });
        checkOutput();
        writeJsonAtomic(path.join(output, "manifest.json"), admission.manifest);
        writeJsonAtomic(path.join(output, "qualification.json"), {
          ...admission.provenance,
          kind: "node-cache-qualification-admission",
          timingAdmission: false,
          manifestSha256: sha256(JSON.stringify(admission.manifest)),
        });
        admission.revalidate();
        checkOutput();
      }, input.timeoutMs),
    checkOutput,
  );
}
