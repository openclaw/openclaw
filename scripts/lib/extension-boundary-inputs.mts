import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  ARTIFACT_CACHE_VERSION,
  portableRelativePath,
  type ArtifactRecord,
} from "./build-artifact-cache.mts";
import { CompilerInputSnapshot } from "./compiler-input-snapshot.mts";
import { createDeclarationInputBoundary } from "./local-check-runtime.mts";
import {
  replayDeclarationLookups,
  type DeclarationLookup,
} from "./native-declaration-filesystem.mts";
import { nativeTypeScriptToolchainFiles } from "./native-typescript-toolchain.mts";
import { pluginSdkEntrypoints } from "./plugin-sdk-entries.mts";

export const LOCAL_SDK_ROOT = "packages/plugin-sdk/dist";
export const BOUNDARY_CACHE_ROOT = ".artifacts/extension-package-boundary";
export const LOCAL_PLUGIN_ROOT = `${BOUNDARY_CACHE_ROOT}/plugins`;
export const BOUNDARY_PLUGIN_UNITS = [
  ["qa-channel", "api"],
  ["memory-core", "api"],
  ["matrix", "test-api"],
  ["discord", "api"],
  ["slack", "test-api"],
  ["telegram", "api"],
  ["whatsapp", "api"],
] as const;

/** The hashed native compiler/API owns declaration bytes; Node's major fences its client. */
export function boundaryRuntimeVersion() {
  return `node-${process.versions.node.split(".")[0]}`;
}

export function sdkBoundaryUnit(roots?: string[]) {
  return {
    id: "plugin-sdk",
    outDir: LOCAL_SDK_ROOT,
    config: "packages/plugin-sdk/tsconfig.json",
    rootDir: ".",
    roots,
    required: roots
      ? roots.map((source) => `${LOCAL_SDK_ROOT}/${source.replace(/\.([cm]?)tsx?$/u, ".d.$1ts")}`)
      : pluginSdkEntrypoints.map((entry) => `${LOCAL_SDK_ROOT}/src/plugin-sdk/${entry}.d.ts`),
  };
}

/** One request format seals both local preparation and transported SDK receipts. */
export function boundaryPreparationArgs(
  rootDir: string,
  unit: { config: string; outDir: string; rootDir: string; roots?: string[] },
) {
  return [
    path.join(rootDir, "scripts/compile-extension-boundary.mts"),
    JSON.stringify({
      configFile: unit.config,
      roots: unit.roots,
      inputReceipt: `${unit.outDir}/.inputs.json`,
      compilerOptions: { outDir: unit.outDir, rootDir: unit.rootDir, declarationMap: false },
      emit: true,
    }),
  ];
}

const GENERATOR_INPUTS = [
  "pnpm-lock.yaml",
  "package.json",
  // Pnpm's manifest carries machine-local store metadata. Native membership,
  // installed topology, and input bytes own dependency invalidation here.
  "scripts/lib/extension-boundary-inputs.mts",
  "scripts/lib/native-declaration-emitter.mts",
  "scripts/lib/native-declaration-filesystem.mts",
  "scripts/lib/native-typescript.mts",
  "scripts/lib/native-typescript-config.mts",
  "scripts/lib/native-typescript-diagnostics.mts",
  "scripts/lib/native-typescript-toolchain.mts",
  "scripts/lib/compiler-input-snapshot.mts",
  "scripts/lib/tsdown-declaration-boundary.mts",
  "scripts/lib/build-artifact-cache.mts",
  "scripts/lib/bounded-output-tail.mjs",
  "scripts/lib/local-check-runtime.mts",
  "scripts/lib/managed-child-process.mts",
  "scripts/lib/vitest-resource-ownership.mts",
  "scripts/lib/dist-artifact-ownership.mts",
  "scripts/lib/direct-run.mjs",
  "scripts/lib/repo-root.mjs",
  "scripts/tsx.mjs",
  "scripts/lib/tsx-cli-shim.mjs",
  "scripts/lib/plugin-sdk-entries.mts",
  "scripts/lib/plugin-sdk-entrypoints.json",
  "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
  "scripts/prepare-extension-package-boundary-artifacts.mts",
  "scripts/compile-extension-boundary.mts",
  "scripts/check-extension-package-tsc-boundary.mts",
  "scripts/lib/extension-boundary-projects.mts",
  "scripts/lib/bundled-plugin-build-entries.mjs",
  "src/plugins/package-entrypoints.ts",
  "scripts/run-tsgo.mts",
];
/** Successful bounded compiler membership feeds the shared snapshot policy. */
export class BoundaryInputSnapshot extends CompilerInputSnapshot {
  private readonly boundary: ReturnType<typeof createDeclarationInputBoundary>;
  private readonly lookupFacts = new Map<string, DeclarationLookup>();

  constructor(rootDir: string, generatorInputs: string[] = []) {
    const boundary = createDeclarationInputBoundary(rootDir);
    const assertInput = (file: string) => boundary.assert(file);
    // Bind compiler identity to this checkout, never ambient cwd.
    const require = createRequire(path.join(boundary.root, "package.json"));
    const nativePackage = assertInput(require.resolve("typescript/package.json"));
    super(boundary.root, {
      runtimeVersion: boundaryRuntimeVersion(),
      toolchainFiles: nativeTypeScriptToolchainFiles(nativePackage, assertInput),
      generatorInputs: [...GENERATOR_INPUTS, ...generatorInputs],
      assertInput,
    });
    this.boundary = boundary;
  }

  private readReceipt(inputReceipt: string) {
    const receipt = this.boundary.assert(inputReceipt);
    const info: unknown = JSON.parse(this.readText(receipt));
    if (
      !info ||
      typeof info !== "object" ||
      Array.isArray(info) ||
      Object.keys(info).length !== 2 ||
      !("inputs" in info) ||
      !("lookups" in info) ||
      !Array.isArray(info.inputs) ||
      info.inputs.length === 0 ||
      !Array.isArray(info.lookups) ||
      info.lookups.length === 0
    ) {
      throw new Error(`Invalid bounded compiler input receipt: ${receipt}`);
    }
    const normalizedPath = (file: unknown): string => {
      if (typeof file !== "string" || !file || path.isAbsolute(file)) {
        throw new Error(`Invalid bounded compiler lookup path: ${receipt}`);
      }
      const normalized = portableRelativePath(this.rootDir, this.boundary.assert(file)) || ".";
      if (normalized !== file) {
        throw new Error(`Invalid bounded compiler lookup path: ${receipt}`);
      }
      return file;
    };
    const names = (value: unknown): value is string[] =>
      Array.isArray(value) &&
      value.every(
        (name) =>
          typeof name === "string" &&
          name.length > 0 &&
          name !== "." &&
          name !== ".." &&
          path.basename(name) === name,
      ) &&
      new Set(value).size === value.length;
    const lookups = info.lookups.map((value: unknown): DeclarationLookup => {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 3 ||
        !("kind" in value) ||
        !("path" in value) ||
        !("result" in value)
      ) {
        throw new Error(`Invalid bounded compiler lookup: ${receipt}`);
      }
      const file = normalizedPath(value.path);
      if (
        (value.kind === "readFile" ||
          value.kind === "fileExists" ||
          value.kind === "directoryExists") &&
        typeof value.result === "boolean"
      ) {
        return { kind: value.kind, path: file, result: value.result };
      }
      if (value.kind === "realpath") {
        return { kind: value.kind, path: file, result: normalizedPath(value.result) };
      }
      if (
        value.kind === "getAccessibleEntries" &&
        value.result &&
        typeof value.result === "object" &&
        !Array.isArray(value.result) &&
        Object.keys(value.result).length === 2 &&
        "files" in value.result &&
        "directories" in value.result &&
        names(value.result.files) &&
        names(value.result.directories)
      ) {
        const { files, directories } = value.result;
        if (files.every((name) => !directories.includes(name))) {
          return { kind: value.kind, path: file, result: { files, directories } };
        }
      }
      throw new Error(`Invalid bounded compiler lookup result: ${receipt}`);
    });
    const inputs = info.inputs.map(normalizedPath);
    const keys = lookups.map(({ kind, path: file }) => `${kind}\0${file}`);
    const reads = lookups
      .filter((lookup) => lookup.kind === "readFile" && lookup.result)
      .map((lookup) => lookup.path)
      .toSorted();
    if (
      new Set(keys).size !== keys.length ||
      JSON.stringify(keys) !== JSON.stringify(keys.toSorted()) ||
      JSON.stringify(inputs) !== JSON.stringify(reads)
    ) {
      throw new Error(`Incomplete or ambiguous bounded compiler input receipt: ${receipt}`);
    }
    return { inputs, lookups };
  }

  private resolutionFingerprint(lookups: DeclarationLookup[]) {
    const expected = JSON.stringify(lookups);
    const pending = lookups.filter(
      (lookup) => !this.lookupFacts.has(`${lookup.kind}\0${lookup.path}`),
    );
    // Match byte/topology snapshot lifetime; a new snapshot probes again.
    if (pending.length) {
      const observed = replayDeclarationLookups(
        this.rootDir,
        (file) => this.boundary.assert(file),
        pending,
        this.readText,
      );
      for (const lookup of observed) {
        this.lookupFacts.set(`${lookup.kind}\0${lookup.path}`, lookup);
      }
    }
    const current = lookups.map((lookup) => this.lookupFacts.get(`${lookup.kind}\0${lookup.path}`));
    if (JSON.stringify(current) !== expected) {
      throw new Error("Bounded compiler resolution lookups changed");
    }
    return createHash("sha256").update(expected).digest("hex");
  }

  matchesReceipt(
    record: ArtifactRecord | undefined,
    config: string,
    args: string[],
    required: string[],
    inputReceipt: string,
    outputRoot?: string,
  ) {
    try {
      const receiptPath = portableRelativePath(this.rootDir, this.boundary.assert(inputReceipt));
      if (
        !record ||
        !required.includes(receiptPath) ||
        record.outputs[receiptPath] !== this.hash(receiptPath)
      ) {
        return false;
      }
      const receipt = this.readReceipt(inputReceipt);
      if (JSON.stringify(receipt.inputs) !== JSON.stringify(record.inputs)) {
        return false;
      }
      return this.matches(
        record,
        config,
        args,
        required,
        outputRoot,
        this.resolutionFingerprint(receipt.lookups),
      );
    } catch {
      return false;
    }
  }

  record(
    config: string,
    args: string[],
    inputReceipt: string,
    outputs: string[],
    outputRoot?: string,
  ): ArtifactRecord {
    const { inputs, lookups } = this.readReceipt(inputReceipt);
    if (!outputs.includes(portableRelativePath(this.rootDir, this.boundary.assert(inputReceipt)))) {
      throw new Error("Bounded compiler receipt is absent from its output inventory");
    }
    const fingerprint = this.resolutionFingerprint(lookups);
    return {
      version: ARTIFACT_CACHE_VERSION,
      inputs,
      signature: this.signature(config, args, inputs, outputRoot, fingerprint),
      outputs: Object.fromEntries(outputs.map((file) => [file, this.hash(file)])),
    };
  }
}
