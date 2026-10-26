#!/usr/bin/env node
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { buildSync } from "esbuild";
import JSON5 from "json5";
import { format } from "oxfmt";
import { RESTORE_PUBLICATION_INDEX_JS } from "../src/gateway/github-repository-publication-restore.ts";
import { REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS } from "../src/gateway/github-repository-publication-snapshot.ts";
import { localWorkspaceQuiescenceScripts } from "../src/gateway/worker-environments/workspace-quiescence-scripts.ts";
import {
  REMOTE_WORKSPACE_MANIFEST_JS,
  WORKSPACE_MANIFEST_PROGRAM,
} from "../src/gateway/worker-environments/workspace-sync-scripts.ts";
import { runtimeProcessEntrypoints } from "../src/infra/runtime-process-entrypoints.ts";
import {
  runtimeProcessDependencyEntrypoints,
  runtimeProcessExternalPackageEntrypoints,
  runtimeProcessScriptEntrypoints,
  runtimeProcessToolingEntrypoints,
} from "../src/infra/runtime-process-manifest.ts";
import { NODE_WORKSPACE_GIT_HISTORY_SCRIPT } from "../src/worker/node-workspace-transfer-protocol.ts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** @type {import("oxfmt").FormatConfig} */
const FORMAT_OPTIONS = JSON5.parse(
  fs.readFileSync(new URL("../.oxfmtrc.jsonc", import.meta.url), "utf8"),
);
/** @type {({entry: string, output: string, constant: string, platform: import("esbuild").Platform, encoding?: "data-url"} & ({program: true} | {program?: false, exportName: string}))[]} */
const ASSETS = [
  {
    entry: "src/shared/keyboard-shortcuts.ts",
    exportName: "createKeyboardShortcutMatcher",
    output: "src/shared/keyboard-shortcuts.generated.ts",
    constant: "KEYBOARD_SHORTCUT_MATCHER_SOURCE",
    platform: "browser",
  },
  {
    entry: "src/gateway/mcp-app-standalone-host.ts",
    exportName: "runStandaloneMcpAppHost",
    output: "src/gateway/mcp-app-standalone-host.generated.ts",
    constant: "MCP_APP_STANDALONE_HOST_SOURCE",
    platform: "browser",
  },
  {
    entry: "src/gateway/worker-environments/repository-node-requirement.ts",
    exportName: "resolveRepositoryNodeRequirement",
    output: "src/gateway/worker-environments/repository-node-requirement.generated.ts",
    constant: "REPOSITORY_NODE_REQUIREMENT_SOURCE",
    platform: "node",
  },
  {
    entry: "src/cli/update-cli/update-command-native-gate.worker.ts",
    output: "src/cli/update-cli/update-command-native-gate.generated.ts",
    constant: "UPDATE_NATIVE_GATE_SOURCE",
    platform: "node",
    program: true,
  },
];
for (const entry of Object.values(runtimeProcessScriptEntrypoints)) {
  if (("materialize" in entry && entry.materialize) || entry.kind === "data-url") {
    ASSETS.push({
      entry:
        "runtimeEntrypoint" in entry
          ? runtimeProcessEntrypoints[entry.runtimeEntrypoint].sourceModulePath
          : entry.buildSource,
      output: entry.sourceModule,
      constant: entry.sourceBinding,
      ...(entry.kind === "data-url" ? { encoding: "data-url" } : {}),
      platform: "node",
      program: true,
    });
  }
}

/** Build complete, self-contained programs without reflecting on runtime functions. */
async function generateRuntimeScriptAssets(rootDir = ROOT) {
  const programs = new Map();
  const assets = ASSETS.map((asset) => {
    const result = buildSync({
      absWorkingDir: rootDir,
      stdin: {
        contents: asset.program
          ? `import ${JSON.stringify(`./${asset.entry}`)};`
          : `export { ${asset.exportName} as run } from ${JSON.stringify(`./${asset.entry}`)};`,
        resolveDir: rootDir,
        sourcefile: "runtime-script.ts",
      },
      bundle: true,
      format: asset.program ? "esm" : "iife",
      globalName: asset.program ? undefined : "__openclawRuntimeScript",
      legalComments: "none",
      // Drop esbuild's source-path comments so dependency store locations cannot enter assets.
      minifyWhitespace: true,
      logLevel: "silent",
      metafile: true,
      platform: asset.platform,
      target: "es2022",
      write: false,
    });
    const output = result.outputFiles?.[0];
    if (!output || result.outputFiles.length !== 1) {
      throw new Error(`Expected one runtime script asset for ${asset.entry}`);
    }
    if (
      Object.values(result.metafile.outputs).some((file) =>
        file.imports.some((entry) => !asset.program || !isBuiltin(entry.path)),
      )
    ) {
      throw new Error(`Runtime script asset must be self-contained: ${asset.entry}`);
    }
    const program = asset.program
      ? output.text
      : `(() => {\n${output.text}\nreturn __openclawRuntimeScript.run;\n})()`;
    if (!asset.program) {
      void new Script(program, { filename: asset.output });
    }
    const value =
      asset.encoding === "data-url"
        ? `data:text/javascript;base64,${Buffer.from(program).toString("base64")}`
        : program;
    programs.set(asset.output, program);
    return {
      outputPath: asset.output,
      contents: `// Generated by scripts/generate-runtime-script-assets.mjs; do not edit.\nexport const ${asset.constant} =\n  ${JSON.stringify(value)};\n`,
    };
  });
  const materialized = Object.fromEntries(
    Object.entries(runtimeProcessScriptEntrypoints).flatMap(([name, entry]) => {
      if (entry.kind !== "file" || !("materialize" in entry) || !entry.materialize) {
        return [];
      }
      const source = programs.get(entry.sourceModule);
      if (typeof source !== "string") {
        throw new Error(`Missing generated runtime script source: ${name}`);
      }
      return [[name, { fileName: entry.fileName, source }]];
    }),
  );
  const materializer = buildSync({
    absWorkingDir: rootDir,
    stdin: {
      contents: `import { materializeRuntimeProcessScriptFile } from "./src/infra/runtime-process-script-file.ts";
const scripts = ${JSON.stringify(materialized)};
export function createRuntimeProcessScriptFile(name, options) {
  return materializeRuntimeProcessScriptFile(scripts[name], options);
}
`,
      resolveDir: rootDir,
      sourcefile: "runtime-process-scripts.ts",
    },
    bundle: true,
    format: "esm",
    legalComments: "none",
    minifyWhitespace: true,
    logLevel: "silent",
    metafile: true,
    platform: "node",
    target: "es2022",
    write: false,
  });
  const materializerOutput = materializer.outputFiles?.[0];
  if (
    !materializerOutput ||
    materializer.outputFiles.length !== 1 ||
    Object.values(materializer.metafile.outputs).some((file) =>
      file.imports.some((entry) => !isBuiltin(entry.path)),
    )
  ) {
    throw new Error("Runtime script materializer must be self-contained");
  }
  assets.push({
    outputPath: "runtime-process-scripts.generated.mjs",
    contents: `// Generated by scripts/generate-runtime-script-assets.mjs; do not edit.\n/* oxlint-disable no-var -- esbuild owns variable declarations in this generated bundle. */\n${materializerOutput.text}`,
  });
  assets.push({
    outputPath: "runtime-process-scripts.generated.d.mts",
    contents: `// Generated by scripts/generate-runtime-script-assets.mjs; do not edit.
export type RuntimeProcessScriptFileOptions = {
  /** An existing directory whose lifetime belongs to the caller. */
  parentDirectory?: string;
};
export type RuntimeProcessScriptFile = {
  url: URL;
  /** Call only after the launched process and retained cleanup have settled. */
  dispose(): void;
};
export declare function createRuntimeProcessScriptFile(
  name: ${Object.keys(materialized)
    .map((name) => JSON.stringify(name))
    .join(" | ")},
  options?: RuntimeProcessScriptFileOptions,
): RuntimeProcessScriptFile;
`,
  });
  for (const [action, program] of Object.entries(localWorkspaceQuiescenceScripts)) {
    const entrypoint =
      action === "acquire"
        ? runtimeProcessEntrypoints.workspaceQuiescenceAcquire
        : action === "renew"
          ? runtimeProcessEntrypoints.workspaceQuiescenceRenew
          : runtimeProcessEntrypoints.workspaceQuiescenceRelease;
    const outputPath = entrypoint.sourceModulePath;
    const structuralRules = ["curly", "no-shadow"];
    if (action !== "acquire") {
      structuralRules.push("no-unused-vars", "prefer-const");
    }
    assets.push({
      outputPath,
      contents: `// Generated by scripts/generate-runtime-script-assets.mjs; do not edit.
/* oxlint-disable ${structuralRules.join(", ")} -- Preserve shared remote program fragments in generated entries. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Match node -e indexing after the file launcher supplies its entry path.
process.argv.splice(1, 1);
${program}
`,
    });
  }
  for (const { entry, program, structuralRules } of [
    {
      entry: runtimeProcessEntrypoints.repositoryPublicationRestore,
      program: RESTORE_PUBLICATION_INDEX_JS,
      structuralRules: ["curly"],
    },
    {
      entry: runtimeProcessEntrypoints.nodeWorkspacePublicationSnapshot,
      program: REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
      structuralRules: ["curly"],
    },
    {
      entry: runtimeProcessEntrypoints.nodeWorkspaceManifest,
      program: REMOTE_WORKSPACE_MANIFEST_JS,
      structuralRules: ["curly", "no-shadow", "no-unused-vars"],
    },
    {
      entry: runtimeProcessEntrypoints.nodeWorkspaceGitHistory,
      program: NODE_WORKSPACE_GIT_HISTORY_SCRIPT,
      structuralRules: ["curly"],
    },
  ]) {
    assets.push({
      outputPath: entry.sourceModulePath,
      contents: `// Generated by scripts/generate-runtime-script-assets.mjs; do not edit.
/* oxlint-disable ${structuralRules.join(", ")} -- Preserve shared remote program fragments in generated entries. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Match node -e indexing after the file launcher supplies its entry path.
process.argv.splice(1, 1);
${program}
`,
    });
  }
  assets.push({
    outputPath: "src/gateway/worker-environments/workspace-manifest-script.generated.mjs",
    contents: `// Generated by scripts/generate-runtime-script-assets.mjs; do not edit.
/* oxlint-disable curly, no-unused-vars -- Preserve the shared remote program inside each invocation. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export async function runWorkspaceManifestProgram(
  process,
  readManifestInput,
  assertManifestCurrent,
  readManifestGit,
  MAX_WORKSPACE_HASH_MEMO_BYTES,
) {
${WORKSPACE_MANIFEST_PROGRAM}
  return main();
}
`,
  });
  assets.push({
    outputPath: "src/gateway/worker-environments/workspace-manifest-script.generated.d.mts",
    contents: `// Generated by scripts/generate-runtime-script-assets.mjs; do not edit.
import type { WorkspaceManifestProgram } from "./workspace-manifest-script-bindings.js";
export declare const runWorkspaceManifestProgram: WorkspaceManifestProgram;
`,
  });
  const dependencyDirectoryEntrypoints = Object.fromEntries(
    Object.entries(runtimeProcessDependencyEntrypoints).flatMap(([name, entry]) =>
      "relativePath" in entry ? [[name, path.basename(entry.relativePath)]] : [],
    ),
  );
  assets.push({
    outputPath: "runtime-process-bootstrap.generated.mjs",
    contents: `// Generated by scripts/generate-runtime-script-assets.mjs; do not edit.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const dependencyDirectoryEntrypoints = ${JSON.stringify(dependencyDirectoryEntrypoints)};
const externalEntrypoints = ${JSON.stringify(runtimeProcessExternalPackageEntrypoints)};
const toolingEntrypoints = ${JSON.stringify(runtimeProcessToolingEntrypoints)};
const distRoot = resolveRuntimeProcessDistRoot(fileURLToPath(import.meta.url));
/** @param {string} currentPath */
export function resolveRuntimeProcessDistRoot(currentPath) {
  const normalized = currentPath.replaceAll(path.sep, "/");
  const marker = "/dist/";
  const index = normalized.lastIndexOf(marker);
  return index >= 0 ? currentPath.slice(0, index + marker.length) : undefined;
}
/** @param {string} modulePath */
function resolveRootEntrypointUrl(modulePath) {
  return distRoot === undefined
    ? new URL(modulePath, import.meta.url)
    : pathToFileURL(path.resolve(distRoot, "..", modulePath));
}
/** @param {keyof typeof externalEntrypoints} name */
export function resolveRuntimeBootstrapExternalEntrypointUrl(name) {
  return resolveRootEntrypointUrl(externalEntrypoints[name]);
}
/** @param {keyof typeof toolingEntrypoints} name */
export function resolveRuntimeBootstrapToolingEntrypointUrl(name) {
  return resolveRootEntrypointUrl(toolingEntrypoints[name]);
}
/**
 * Resolve a selected dependency entry without substituting the host package tree.
 * @param {keyof typeof dependencyDirectoryEntrypoints} name
 * @param {string} directory
 */
export function resolveRuntimeDependencyEntrypointUrlFromDirectory(name, directory) {
  return pathToFileURL(path.join(directory, dependencyDirectoryEntrypoints[name]));
}
`,
  });
  const entryNames = (entries) =>
    Object.keys(entries)
      .map((name) => JSON.stringify(name))
      .join(" | ");
  assets.push({
    outputPath: "runtime-process-bootstrap.generated.d.mts",
    contents: `// Generated by scripts/generate-runtime-script-assets.mjs; do not edit.
export declare function resolveRuntimeProcessDistRoot(currentPath: string): string | undefined;
export declare function resolveRuntimeBootstrapExternalEntrypointUrl(name: ${entryNames(runtimeProcessExternalPackageEntrypoints)}): URL;
export declare function resolveRuntimeBootstrapToolingEntrypointUrl(name: ${entryNames(runtimeProcessToolingEntrypoints)}): URL;
export declare function resolveRuntimeDependencyEntrypointUrlFromDirectory(name: ${entryNames(dependencyDirectoryEntrypoints)}, directory: string): URL;
`,
  });
  return Promise.all(
    assets.map(async ({ outputPath, contents }) => {
      const formatted = await format(outputPath, contents, FORMAT_OPTIONS);
      if (formatted.errors.length > 0) {
        throw new Error(`Cannot format ${outputPath}: ${JSON.stringify(formatted.errors)}`);
      }
      return { outputPath, contents: formatted.code };
    }),
  );
}

export async function writeRuntimeScriptAssets({ rootDir = ROOT, check = false } = {}) {
  /** @type {string[]} */
  const stale = [];
  for (const { outputPath, contents } of await generateRuntimeScriptAssets(rootDir)) {
    const filename = path.join(rootDir, outputPath);
    const current = fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : undefined;
    if (current === contents) {
      continue;
    }
    stale.push(outputPath);
    if (!check) {
      fs.writeFileSync(filename, contents);
    }
  }
  if (check && stale.length > 0) {
    throw new Error(
      `Runtime script assets are stale; run pnpm runtime:scripts:gen: ${stale.join(", ")}`,
    );
  }
  return stale;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await writeRuntimeScriptAssets({ check: process.argv.includes("--check") });
}
