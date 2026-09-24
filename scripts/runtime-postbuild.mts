// Generates postbuild runtime artifacts: plugin metadata, SDK aliases, stable
// runtime aliases, static assets, and compatibility chunks for live upgrades.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import {
  readRuntimeDependencyOwnership,
  RUNTIME_DEPENDENCY_OWNERSHIP_RELATIVE_PATH,
  type RuntimeDependencyOwnership,
} from "../src/infra/runtime-dependency-ownership.ts";
import { verifyBuiltPluginControlPlaneModules } from "./check-built-plugin-control-plane-modules.mts";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mts";
import { copyHookMetadata, listHookMetadataOutputs } from "./copy-hook-metadata.ts";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  copyStaticExtensionAssets,
  copyStaticExtensionAssetsToRuntimeOverlay,
  discoverStaticExtensionAssets,
  shouldCopyStaticExtensionAssets,
} from "./lib/static-extension-assets.mts";
import {
  isUpdateCompatibilityChunk,
  listUpdateCompatibilityChunkPaths,
  readUpdateCompatibilityInventory,
  UPDATE_COMPATIBILITY_INVENTORY_FILE,
  writeUpdateCompatibilityChunks,
} from "./lib/update-compat-chunks.mts";
import { buildUpdateConfigRuntimeAlias } from "./lib/update-config-runtime-compat.mts";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mts";
import { writeBuildInfo } from "./write-build-info.ts";
import { writeOfficialChannelCatalog } from "./write-official-channel-catalog.mts";

type RuntimePostBuildParams = {
  rootDir?: string;
  repoRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fs?: typeof fs;
  timings?: boolean | "verbose";
  warn?: (message: string) => void;
};
type RuntimeFsParams = Pick<RuntimePostBuildParams, "rootDir" | "fs">;
type RuntimeAliasCandidate = { candidate: string; source: string };

const LEGACY_UPDATE_NODE_RUNNER_COMPAT_CHUNK = [
  'import path from "node:path";',
  "export function resolveNodeRunner() {",
  "  const base = path.basename(process.execPath).trim().toLowerCase();",
  '  return base === "node" || base === "node.exe" ? process.execPath : "node";',
  "}",
  "",
].join("\n");

const ROOT = resolveRepoRoot(import.meta.url);
const UPDATE_COMPATIBILITY_INVENTORY = path.join(ROOT, "scripts/lib/update-compat-inventory.json");
const ROOT_RUNTIME_ALIAS_PATTERN = /^(?<base>.+\.(?:runtime|contract))-[A-Za-z0-9_-]+\.m?js$/u;
const ROOT_STABLE_RUNTIME_ALIAS_PATTERN = /^.+\.(?:runtime|contract)\.js$/u;
const ROOT_RUNTIME_IMPORT_SPECIFIER_PATTERN =
  /(["'])\.\/([^"']+\.(?:runtime|contract)-[A-Za-z0-9_-]+\.m?js)\1/gu;
const OFFICIAL_CHANNEL_CATALOG_OUTPUT = "dist/channel-catalog.json";
const EXPORT_HTML_SOURCE_DIR = "src/auto-reply/reply/export-html";
const EXPORT_HTML_OUTPUT_DIR = "dist/export-html";
const EXPORT_HTML_OUTPUTS = [
  `${EXPORT_HTML_OUTPUT_DIR}/template.css`,
  `${EXPORT_HTML_OUTPUT_DIR}/template.html`,
  `${EXPORT_HTML_OUTPUT_DIR}/template.js`,
  `${EXPORT_HTML_OUTPUT_DIR}/vendor/highlight.min.js`,
  `${EXPORT_HTML_OUTPUT_DIR}/vendor/marked.min.js`,
];
const EXPORT_HTML_VENDOR_ENTRYPOINTS = [
  {
    fileName: "marked.min.js",
    packageEntry: "marked",
    packageName: "marked",
    globalName: "marked",
    licenseFile: "LICENSE",
  },
  {
    fileName: "highlight.min.js",
    packageEntry: "highlight.js/lib/common",
    packageName: "highlight.js",
    globalName: "hljs",
    footer: "hljs = hljs.default || hljs;",
    licenseFile: "LICENSE",
  },
];
const LEGACY_ROOT_RUNTIME_COMPAT_ALIASES: Array<readonly [string, string]> = [
  // v2026.6.8 text-transform runtime. The stable alias remains
  // for old chunks, but new chunks keep hashed imports because the alias export
  // set expanded in v2026.6.8 and may already be cached in a live gateway.
  ["text-transforms.runtime-sEqsN4pN.js", "text-transforms.runtime.js"],
];
const ROOT_RUNTIME_STABLE_IMPORT_SKIP_ALIASES = new Set(["text-transforms.runtime.js"]);
const PLUGIN_INSTALL_RUNTIME_ALIAS = {
  aliasFileName: "install.runtime.js",
  sourceIncludes: [
    "scanPackageInstallSource",
    "scanFileInstallSource",
    "scanInstalledPackageDependencyTree",
    "scanBundleInstallSource",
  ],
};
/** Compatibility chunks for old updater and CLI exit modules after package replacement. */
const LEGACY_CLI_EXIT_COMPAT_CHUNKS = [
  // v2026.8.2 and the exact d413210 and 0229a108 builds load these after replacing dist/.
  // Remove only after the source artifacts fall outside the supported upgrade window.
  {
    dest: "dist/shared-Y6bNiw2w.js",
    contents: LEGACY_UPDATE_NODE_RUNNER_COMPAT_CHUNK,
  },
  {
    dest: "dist/shared-DTaQo6Hi.js",
    contents: LEGACY_UPDATE_NODE_RUNNER_COMPAT_CHUNK,
  },
  {
    dest: "dist/shared-1Uyqkfns.js",
    contents: LEGACY_UPDATE_NODE_RUNNER_COMPAT_CHUNK,
  },
];

function collectStableRootRuntimeAliasCandidates(distDir: string, fsImpl: typeof fs) {
  const candidatesByAlias = new Map<string, RuntimeAliasCandidate[]>();
  const pluginInstallCandidates: RuntimeAliasCandidate[] = [];
  let entries;
  try {
    entries = fsImpl.readdirSync(distDir, { withFileTypes: true });
  } catch {
    return { entries: [], candidatesByAlias, pluginInstallCandidates };
  }

  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(ROOT_RUNTIME_ALIAS_PATTERN);
    if (!match?.groups?.base) {
      continue;
    }
    let source = "";
    try {
      source = fsImpl.readFileSync(path.join(distDir, entry.name), "utf8");
    } catch {
      // Unreadable candidates still participate in ambiguity detection below.
    }
    const aliasFileName = `${match.groups.base}.js`;
    const candidate = { candidate: entry.name, source };
    if (aliasFileName === PLUGIN_INSTALL_RUNTIME_ALIAS.aliasFileName) {
      // Marker disambiguation also inspects compatibility facades.
      pluginInstallCandidates.push(candidate);
    }
    if (isUpdateCompatibilityChunk(source)) {
      continue;
    }
    const candidates = candidatesByAlias.get(aliasFileName) ?? [];
    candidates.push(candidate);
    candidatesByAlias.set(aliasFileName, candidates);
  }
  // Importer rewrites retain directory order; only alias candidates are sorted.
  return { entries, candidatesByAlias, pluginInstallCandidates };
}

function resolveStableRootRuntimeAliasCandidate(
  aliasFileName: string,
  candidates: RuntimeAliasCandidate[],
  pluginInstallCandidates: RuntimeAliasCandidate[],
) {
  const implementationCandidates = candidates.filter(
    ({ source }) => !isRuntimeAliasSource(source, aliasFileName),
  );
  const candidateNames = implementationCandidates.map(({ candidate }) => candidate);
  if (candidateNames.length === 1) {
    return candidateNames[0] ?? null;
  }
  if (aliasFileName === PLUGIN_INSTALL_RUNTIME_ALIAS.aliasFileName) {
    const matches = pluginInstallCandidates.filter(({ source }) =>
      PLUGIN_INSTALL_RUNTIME_ALIAS.sourceIncludes.every((marker) => source.includes(marker)),
    );
    return matches.length === 1 ? (matches[0]?.candidate ?? null) : null;
  }
  const wrappers = implementationCandidates.filter(({ candidate, source }) =>
    candidateNames.some(
      (target) =>
        target !== candidate &&
        source.includes(`"./${target}"`) &&
        !source.includes("\n//#region "),
    ),
  );
  return wrappers.length === 1 ? (wrappers[0]?.candidate ?? null) : null;
}

/**
 * Lists stable aliases for hashed root runtime/contract chunks.
 */
function listStableRootRuntimeAliasOutputs(params: RuntimeFsParams = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  const { candidatesByAlias, pluginInstallCandidates } = collectStableRootRuntimeAliasCandidates(
    distDir,
    fsImpl,
  );
  return [...candidatesByAlias]
    .filter(([aliasFileName, candidates]) =>
      resolveStableRootRuntimeAliasCandidate(aliasFileName, candidates, pluginInstallCandidates),
    )
    .map(([aliasFileName]) => `dist/${aliasFileName}`)
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Lists legacy hashed runtime aliases that may be needed during live upgrades.
 */
function listLegacyRootRuntimeCompatOutputs(params: RuntimeFsParams = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  return LEGACY_ROOT_RUNTIME_COMPAT_ALIASES.filter(([, aliasFileName]) =>
    fsImpl.existsSync(path.join(distDir, aliasFileName)),
  )
    .map(([legacyFileName]) => `dist/${legacyFileName}`)
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Lists all core runtime postbuild outputs expected after a build.
 */
export function listCoreRuntimePostBuildOutputs(params: RuntimeFsParams = {}) {
  return [
    "dist/build-info.json",
    ...listHookMetadataOutputs(params),
    OFFICIAL_CHANNEL_CATALOG_OUTPUT,
    ...listExportHtmlTemplateOutputs(params),
    ...listStableRootRuntimeAliasOutputs(params),
    ...listLegacyRootRuntimeCompatOutputs(params),
    ...LEGACY_CLI_EXIT_COMPAT_CHUNKS.map(({ dest }) => dest),
    `dist/${UPDATE_COMPATIBILITY_INVENTORY_FILE}`,
    ...listUpdateCompatibilityChunkPaths(
      readUpdateCompatibilityInventory(UPDATE_COMPATIBILITY_INVENTORY),
    ).map((fileName) => `dist/${fileName}`),
  ].toSorted((left, right) => left.localeCompare(right));
}

/** Builds deterministic browser globals from the pinned workspace packages. */
export function generateExportHtmlVendorAssets(
  params: Pick<RuntimePostBuildParams, "rootDir"> = {},
): Readonly<Record<string, string>> {
  const rootDir = path.resolve(params.rootDir ?? ROOT);
  const resolveFromRoot = createRequire(path.join(rootDir, "package.json")).resolve;
  return Object.fromEntries(
    EXPORT_HTML_VENDOR_ENTRYPOINTS.map(
      ({ fileName, packageEntry, packageName, globalName, footer, licenseFile }) => {
        const result = buildSync({
          absWorkingDir: rootDir,
          bundle: true,
          entryPoints: [packageEntry],
          footer: footer ? { js: footer } : undefined,
          format: "iife",
          globalName,
          legalComments: "inline",
          logLevel: "silent",
          minify: true,
          platform: "browser",
          target: "es2018",
          write: false,
        });
        const output = result.outputFiles?.[0];
        if (!output || result.outputFiles?.length !== 1) {
          throw new Error(`Expected one generated export-html asset for ${packageEntry}`);
        }
        const packageRoot = path.dirname(resolveFromRoot(`${packageName}/package.json`));
        const license = fs.readFileSync(path.join(packageRoot, licenseFile), "utf8").trimEnd();
        if (license.includes("*/")) {
          throw new Error(`Cannot embed ${packageName} license in a JavaScript comment`);
        }
        return [fileName, `/*!\n${license}\n*/\n${output.text}`];
      },
    ),
  );
}

function listExportHtmlTemplateOutputs(params: RuntimeFsParams = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const fsImpl = params.fs ?? fs;
  const hasSource = fsImpl.existsSync(path.join(rootDir, EXPORT_HTML_SOURCE_DIR));
  const hasBuiltAssets = fsImpl.existsSync(path.join(rootDir, EXPORT_HTML_OUTPUT_DIR));
  return hasSource || hasBuiltAssets ? [...EXPORT_HTML_OUTPUTS] : [];
}

/** Copies authored templates and generates dependency-owned browser payloads. */
export function copyExportHtmlTemplates(params: RuntimeFsParams = {}) {
  const rootDir = path.resolve(params.rootDir ?? ROOT);
  const fsImpl = params.fs ?? fs;
  const sourceDir = path.join(rootDir, EXPORT_HTML_SOURCE_DIR);
  if (!fsImpl.existsSync(sourceDir)) {
    return;
  }
  const outputDir = path.join(rootDir, EXPORT_HTML_OUTPUT_DIR);
  assertRealOutputRoot(path.join(rootDir, "dist"), { fs: fsImpl });
  fsImpl.rmSync(outputDir, { recursive: true, force: true });
  fsImpl.mkdirSync(outputDir, { recursive: true });
  for (const entry of fsImpl.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith(".test.ts")) {
      continue;
    }
    fsImpl.copyFileSync(path.join(sourceDir, entry.name), path.join(outputDir, entry.name));
  }
  const vendorDir = path.join(outputDir, "vendor");
  fsImpl.mkdirSync(vendorDir, { recursive: true });
  for (const [fileName, contents] of Object.entries(generateExportHtmlVendorAssets({ rootDir }))) {
    fsImpl.writeFileSync(path.join(vendorDir, fileName), contents);
  }
}

const RUNTIME_CHUNK_DEFAULT_EXPORT_PATTERN =
  /(^|\n)\s*export\b\s*(?:default\b|\{[^}]*(?:\bas\s+default\b|\bdefault\b\s*(?=[,}]))[^}]*\})/u;

function formatRuntimeAliasSource(targetFileName: string, forwardDefault = false) {
  const specifier = JSON.stringify(`./${targetFileName}`);
  const starSource = `export * from ${specifier};\n`;
  return forwardDefault ? `${starSource}export { default } from ${specifier};\n` : starSource;
}

function isRuntimeAliasSource(source: string, targetFileName: string) {
  const normalizedSource = source.trim();
  return (
    normalizedSource === formatRuntimeAliasSource(targetFileName).trim() ||
    normalizedSource === formatRuntimeAliasSource(targetFileName, true).trim()
  );
}

/**
 * Builds alias module source for a runtime chunk target. `export * from`
 * never re-exports `default`, so when the target chunk has a default export
 * the alias must forward it explicitly — otherwise lazy `import()` consumers
 * that destructure `default` receive `undefined` (e.g. the post-compaction
 * count reconcile failed this way with "TypeError: reconcile is not a
 * function" on every compaction).
 */
function buildRuntimeAliasSource(targetFileName: string, distDir: string, fsImpl: typeof fs) {
  let targetSource;
  try {
    targetSource = fsImpl.readFileSync(path.join(distDir, targetFileName), "utf8");
  } catch {
    return formatRuntimeAliasSource(targetFileName);
  }
  return formatRuntimeAliasSource(
    targetFileName,
    RUNTIME_CHUNK_DEFAULT_EXPORT_PATTERN.test(targetSource),
  );
}

function writeRuntimeDependencyOwnership(
  rootDir: string,
  ownership: RuntimeDependencyOwnership | null,
  fsImpl: typeof fs,
) {
  if (ownership) {
    fsImpl.writeFileSync(
      path.join(rootDir, RUNTIME_DEPENDENCY_OWNERSHIP_RELATIVE_PATH),
      `${JSON.stringify({ chunks: Object.fromEntries(Object.entries(ownership.chunks).toSorted(([a], [b]) => a.localeCompare(b))) })}\n`,
    );
  }
}

/**
 * Writes stable aliases for current hashed runtime chunks.
 * @internal Directly tested script implementation detail.
 */
export function writeStableRootRuntimeAliases(params: RuntimeFsParams = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  // Alias rewrites delete files under dist; fail closed on a symlinked root
  // so a stale alias removal cannot land inside the link target.
  assertRealOutputRoot(distDir, { fs: fsImpl });
  const { candidatesByAlias, pluginInstallCandidates } = collectStableRootRuntimeAliasCandidates(
    distDir,
    fsImpl,
  );

  const ownership = readRuntimeDependencyOwnership(rootDir, fsImpl);
  for (const [aliasFileName, candidates] of candidatesByAlias) {
    const aliasPath = path.join(distDir, aliasFileName);
    const candidate = resolveStableRootRuntimeAliasCandidate(
      aliasFileName,
      candidates,
      pluginInstallCandidates,
    );
    if (!candidate) {
      fsImpl.rmSync?.(aliasPath, { force: true });
      if (ownership) {
        delete ownership.chunks[aliasFileName];
      }
      continue;
    }
    const source =
      aliasFileName === "io.runtime.js"
        ? buildUpdateConfigRuntimeAlias(
            candidate,
            fsImpl.readFileSync(path.join(distDir, candidate), "utf8"),
          )
        : buildRuntimeAliasSource(candidate, distDir, fsImpl);
    const owner = ownership?.chunks[candidate];
    if (ownership && owner) {
      const targetSource = fsImpl.readFileSync(path.join(distDir, candidate));
      if (createHash("sha256").update(targetSource).digest("hex") !== owner.sha256) {
        throw new Error(
          `runtime dependency ownership no longer matches ${candidate}; rebuild dist`,
        );
      }
      ownership.chunks[aliasFileName] = {
        extensions: owner.extensions,
        sha256: createHash("sha256").update(source).digest("hex"),
      };
    } else if (ownership) {
      delete ownership.chunks[aliasFileName];
    }
    writeTextFileIfChanged(aliasPath, source);
  }
  writeRuntimeDependencyOwnership(rootDir, ownership, fsImpl);
}

/**
 * Rewrites hashed runtime imports to stable aliases so live updates survive swaps.
 * @internal Directly tested script implementation detail.
 */
export function rewriteRootRuntimeImportsToStableAliases(params: RuntimeFsParams = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  const { entries, candidatesByAlias, pluginInstallCandidates } =
    collectStableRootRuntimeAliasCandidates(distDir, fsImpl);
  const runtimeAliasFiles = new Map<string, string>();
  for (const [aliasFileName, candidates] of candidatesByAlias) {
    const candidate = resolveStableRootRuntimeAliasCandidate(
      aliasFileName,
      candidates,
      pluginInstallCandidates,
    );
    if (candidate) {
      if (ROOT_RUNTIME_STABLE_IMPORT_SKIP_ALIASES.has(aliasFileName)) {
        continue;
      }
      runtimeAliasFiles.set(candidate, aliasFileName);
    }
  }
  if (runtimeAliasFiles.size === 0) {
    return;
  }

  const ownership = readRuntimeDependencyOwnership(rootDir, fsImpl);
  for (const entry of entries) {
    if (!entry.isFile() || !/\.m?js$/u.test(entry.name)) {
      continue;
    }
    if (ROOT_STABLE_RUNTIME_ALIAS_PATTERN.test(entry.name)) {
      continue;
    }
    const filePath = path.join(distDir, entry.name);
    let source;
    try {
      source = fsImpl.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const rewritten = source.replace(
      ROOT_RUNTIME_IMPORT_SPECIFIER_PATTERN,
      (specifier: string, quote: string, fileName: string) => {
        const aliasFileName = runtimeAliasFiles.get(fileName);
        return aliasFileName ? `${quote}./${aliasFileName}${quote}` : specifier;
      },
    );
    if (rewritten !== source) {
      const owner = ownership?.chunks[entry.name];
      // Carry the producer's proof through this exact transformation; never
      // rehash unknown or independently modified build outputs.
      if (owner) {
        if (createHash("sha256").update(source).digest("hex") !== owner.sha256) {
          throw new Error(
            `runtime dependency ownership no longer matches ${entry.name}; rebuild dist`,
          );
        }
        owner.sha256 = createHash("sha256").update(rewritten).digest("hex");
      }
      writeTextFileIfChanged(filePath, rewritten);
    }
  }
  writeRuntimeDependencyOwnership(rootDir, ownership, fsImpl);
}

/**
 * Writes compatibility aliases for shipped hashed runtime chunk names.
 * @internal Directly tested script implementation detail.
 */
export function writeLegacyRootRuntimeCompatAliases(params: RuntimeFsParams = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  for (const [legacyFileName, aliasFileName] of LEGACY_ROOT_RUNTIME_COMPAT_ALIASES) {
    const legacyPath = path.join(distDir, legacyFileName);
    if (fsImpl.existsSync(legacyPath)) {
      continue;
    }
    if (!fsImpl.existsSync(path.join(distDir, aliasFileName))) {
      continue;
    }
    writeTextFileIfChanged(legacyPath, buildRuntimeAliasSource(aliasFileName, distDir, fsImpl));
  }
}

/**
 * Writes small compatibility chunks for old CLI exit imports.
 * @internal Directly tested script implementation detail.
 */
export function writeLegacyCliExitCompatChunks(params: { rootDir?: string } = {}) {
  const rootDir = params.rootDir ?? ROOT;
  for (const { dest, contents } of LEGACY_CLI_EXIT_COMPAT_CHUNKS) {
    writeTextFileIfChanged(path.join(rootDir, dest), contents);
  }
}

/**
 * Runs every runtime postbuild phase after the main dist build.
 */
export function runRuntimePostBuild(params: RuntimePostBuildParams = {}) {
  const rootDir = path.resolve(params.rootDir ?? params.cwd ?? params.repoRoot ?? ROOT);
  const fsImpl = params.fs ?? fs;
  const phaseParams = { ...params, cwd: rootDir, repoRoot: rootDir, rootDir };
  // Postbuild phases share both roots. Validate the whole mutation set before
  // any phase runs so a later unsafe root cannot leave earlier output changed.
  assertRealOutputRoot(path.join(rootDir, "dist"), { fs: fsImpl });
  assertRealOutputRoot(path.join(rootDir, "dist-runtime"), { fs: fsImpl });
  const timingsSetting = params.timings ?? process.env.OPENCLAW_RUNTIME_POSTBUILD_TIMINGS;
  const timingsEnabled = timingsSetting !== "0" && timingsSetting !== false;
  // Per-phase lines are debug detail; default output is one summary line so a
  // routine rebuild does not print nine near-identical timing rows.
  const perPhaseEnabled = timingsSetting === "verbose" || timingsSetting === true;
  const phaseTimings: Array<{ label: string; durationMs: number }> = [];
  const runPhase = <T,>(label: string, action: () => T): T => {
    const startedAt = performance.now();
    try {
      return action();
    } finally {
      const durationMs = Math.round(performance.now() - startedAt);
      phaseTimings.push({ label, durationMs });
      if (perPhaseEnabled) {
        console.error(`runtime-postbuild: ${label} completed in ${durationMs}ms`);
      }
    }
  };
  const logSummary = () => {
    if (!timingsEnabled || perPhaseEnabled || phaseTimings.length === 0) {
      return;
    }
    const totalMs = phaseTimings.reduce((sum, phase) => sum + phase.durationMs, 0);
    const slowest = phaseTimings.reduce((max, phase) =>
      phase.durationMs > max.durationMs ? phase : max,
    );
    console.error(
      `runtime-postbuild: ${phaseTimings.length} phases completed in ${totalMs}ms (slowest: ${slowest.label} ${slowest.durationMs}ms)`,
    );
  };
  runPhase("bundled plugin metadata", () => copyBundledPluginMetadata(phaseParams));
  runPhase("bundled hook metadata", () => copyHookMetadata(phaseParams));
  runPhase("official channel catalog", () => writeOfficialChannelCatalog(phaseParams));
  runPhase("export HTML assets", () => copyExportHtmlTemplates(phaseParams));
  runPhase("bundled plugin runtime overlay", () => stageBundledPluginRuntime(phaseParams));
  runPhase("static extension assets", () => {
    if (!shouldCopyStaticExtensionAssets(phaseParams)) {
      return;
    }
    const assetParams = {
      ...phaseParams,
      assets: discoverStaticExtensionAssets(phaseParams),
    };
    copyStaticExtensionAssets(assetParams);
    copyStaticExtensionAssetsToRuntimeOverlay(assetParams);
  });
  runPhase("stable root runtime imports", () =>
    rewriteRootRuntimeImportsToStableAliases(phaseParams),
  );
  runPhase("stable root runtime aliases", () => writeStableRootRuntimeAliases(phaseParams));
  runPhase("legacy root runtime compat aliases", () =>
    writeLegacyRootRuntimeCompatAliases(phaseParams),
  );
  runPhase("legacy CLI exit compat chunks", () => writeLegacyCliExitCompatChunks(phaseParams));
  runPhase("previous release update compat chunks", () =>
    writeUpdateCompatibilityChunks({
      distDir: path.join(rootDir, "dist"),
      sourceDir: rootDir,
      inventory: readUpdateCompatibilityInventory(UPDATE_COMPATIBILITY_INVENTORY),
    }),
  );
  runPhase("built plugin control-plane loads", () =>
    verifyBuiltPluginControlPlaneModules(phaseParams),
  );
  // Source runners launch directly after postbuild, without the full UI build's
  // final metadata step. Publish identity only after the runtime is complete.
  runPhase("build provenance", () => writeBuildInfo({ rootDir, env: params.env }));
  logSummary();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await withDistArtifactOwnership(process.cwd(), async () => {
    runRuntimePostBuild();
  });
}
