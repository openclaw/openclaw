import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  ARTIFACT_CACHE_VERSION,
  portableRelativePath,
  type ArtifactRecord,
} from "./build-artifact-cache.mts";
import { CompilerInputSnapshot } from "./compiler-input-snapshot.mts";
import { createDeclarationInputBoundary } from "./local-check-runtime.mts";
import { nativeTypeScriptToolchainFiles } from "./native-typescript-toolchain.mts";

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

  constructor(rootDir: string, generatorInputs: string[] = []) {
    const boundary = createDeclarationInputBoundary(rootDir);
    const assertInput = (file: string) => boundary.assert(file);
    // Bind compiler identity to this checkout, never ambient cwd.
    const require = createRequire(path.join(boundary.root, "package.json"));
    const nativePackage = assertInput(require.resolve("typescript/package.json"));
    super(boundary.root, {
      toolchainFiles: nativeTypeScriptToolchainFiles(nativePackage, assertInput),
      generatorInputs: [...GENERATOR_INPUTS, ...generatorInputs],
      assertInput,
    });
    this.boundary = boundary;
  }

  record(
    config: string,
    args: string[],
    inputReceipt: string,
    outputs: string[],
    before: BoundaryInputSnapshot,
    startedAt: number,
    outputRoot?: string,
  ): ArtifactRecord {
    const receipt = this.boundary.assert(inputReceipt);
    const info: unknown = JSON.parse(fs.readFileSync(receipt, "utf8"));
    if (
      !info ||
      typeof info !== "object" ||
      Array.isArray(info) ||
      Object.keys(info).length !== 1 ||
      !("inputs" in info) ||
      !Array.isArray(info.inputs) ||
      info.inputs.length === 0 ||
      !info.inputs.every(
        (file): file is string =>
          typeof file === "string" && file.length > 0 && !path.isAbsolute(file),
      )
    ) {
      throw new Error(`Invalid bounded compiler input receipt: ${receipt}`);
    }
    const inputs = [...new Set(info.inputs)]
      .map((file) => {
        const normalized = portableRelativePath(this.rootDir, this.boundary.assert(file));
        if (normalized !== file) {
          throw new Error(`Invalid bounded compiler input path: ${file}`);
        }
        return normalized;
      })
      .toSorted();
    return {
      version: ARTIFACT_CACHE_VERSION,
      ...this.seal(config, args, inputs, before, startedAt, outputRoot),
      outputs: Object.fromEntries(outputs.map((file) => [file, this.hash(file)])),
    };
  }
}
