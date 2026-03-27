import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { collectBundledPluginSources } from "./lib/bundled-plugin-source-utils.mjs";
import { formatGeneratedModule } from "./lib/format-generated-module.mjs";
import { writeGeneratedOutput } from "./lib/generated-output-utils.mjs";

const GENERATED_BY = "scripts/generate-bundled-plugin-metadata.mjs";
const DEFAULT_OUTPUT_PATH = "src/plugins/bundled-plugin-metadata.generated.ts";
const DEFAULT_ENTRIES_OUTPUT_PATH = "src/generated/bundled-plugin-entries.generated.ts";
const MANIFEST_KEY = "openclaw";
const FORMATTER_CWD = path.resolve(import.meta.dirname, "..");

function rewriteEntryToBuiltPath(entry) {
  if (typeof entry !== "string" || entry.trim().length === 0) {
    return undefined;
  }
  const normalized = entry.replace(/^\.\//u, "");
  return normalized.replace(/\.[^.]+$/u, ".js");
}

function deriveIdHint({ filePath, manifestId, packageName, hasMultipleExtensions }) {
  const base = path.basename(filePath, path.extname(filePath));
  const normalizedManifestId = manifestId?.trim();
  if (normalizedManifestId) {
    return hasMultipleExtensions ? `${normalizedManifestId}/${base}` : normalizedManifestId;
  }
  const rawPackageName = packageName?.trim();
  if (!rawPackageName) {
    return base;
  }

  const unscoped = rawPackageName.includes("/")
    ? (rawPackageName.split("/").pop() ?? rawPackageName)
    : rawPackageName;
  const normalizedPackageId =
    unscoped.endsWith("-provider") && unscoped.length > "-provider".length
      ? unscoped.slice(0, -"-provider".length)
      : unscoped;

  if (!hasMultipleExtensions) {
    return normalizedPackageId;
  }
  return `${normalizedPackageId}/${base}`;
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const normalized = values.map((value) => String(value).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeManifestContracts(raw) {
  const contracts = normalizeObject(raw);
  if (!contracts) {
    return undefined;
  }
  const speechProviders = normalizeStringList(contracts.speechProviders);
  const mediaUnderstandingProviders = normalizeStringList(contracts.mediaUnderstandingProviders);
  const imageGenerationProviders = normalizeStringList(contracts.imageGenerationProviders);
  const webSearchProviders = normalizeStringList(contracts.webSearchProviders);
  const tools = normalizeStringList(contracts.tools);
  const normalized = {
    ...(speechProviders?.length ? { speechProviders } : {}),
    ...(mediaUnderstandingProviders?.length ? { mediaUnderstandingProviders } : {}),
    ...(imageGenerationProviders?.length ? { imageGenerationProviders } : {}),
    ...(webSearchProviders?.length ? { webSearchProviders } : {}),
    ...(tools?.length ? { tools } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function normalizePackageManifest(raw) {
  const packageManifest = normalizeObject(raw?.[MANIFEST_KEY]);
  if (!packageManifest) {
    return undefined;
  }
  const normalized = {
    ...(Array.isArray(packageManifest.extensions)
      ? { extensions: packageManifest.extensions.map((entry) => String(entry).trim()) }
      : {}),
    ...(typeof packageManifest.setupEntry === "string"
      ? { setupEntry: packageManifest.setupEntry.trim() }
      : {}),
    ...(normalizeObject(packageManifest.channel) ? { channel: packageManifest.channel } : {}),
    ...(normalizeObject(packageManifest.install) ? { install: packageManifest.install } : {}),
    ...(normalizeObject(packageManifest.startup) ? { startup: packageManifest.startup } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizePluginManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  if (typeof raw.id !== "string" || !raw.id.trim()) {
    return null;
  }
  if (
    !raw.configSchema ||
    typeof raw.configSchema !== "object" ||
    Array.isArray(raw.configSchema)
  ) {
    return null;
  }

  return {
    id: raw.id.trim(),
    configSchema: raw.configSchema,
    ...(raw.enabledByDefault === true ? { enabledByDefault: true } : {}),
    ...(typeof raw.kind === "string" ? { kind: raw.kind.trim() } : {}),
    ...(normalizeStringList(raw.channels) ? { channels: normalizeStringList(raw.channels) } : {}),
    ...(normalizeStringList(raw.providers)
      ? { providers: normalizeStringList(raw.providers) }
      : {}),
    ...(normalizeStringList(raw.cliBackends)
      ? { cliBackends: normalizeStringList(raw.cliBackends) }
      : {}),
    ...(normalizeObject(raw.providerAuthEnvVars)
      ? { providerAuthEnvVars: raw.providerAuthEnvVars }
      : {}),
    ...(Array.isArray(raw.providerAuthChoices)
      ? { providerAuthChoices: raw.providerAuthChoices }
      : {}),
    ...(normalizeStringList(raw.skills) ? { skills: normalizeStringList(raw.skills) } : {}),
    ...(typeof raw.name === "string" ? { name: raw.name.trim() } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description.trim() } : {}),
    ...(typeof raw.version === "string" ? { version: raw.version.trim() } : {}),
    ...(normalizeObject(raw.uiHints) ? { uiHints: raw.uiHints } : {}),
    ...(normalizeObject(raw.channelConfigs) ? { channelConfigs: raw.channelConfigs } : {}),
    ...(normalizeManifestContracts(raw.contracts)
      ? { contracts: normalizeManifestContracts(raw.contracts) }
      : {}),
  };
}

function resolvePackageChannelMeta(packageJson) {
  const openclawMeta =
    packageJson &&
    typeof packageJson === "object" &&
    !Array.isArray(packageJson) &&
    "openclaw" in packageJson
      ? packageJson.openclaw
      : undefined;
  if (!openclawMeta || typeof openclawMeta !== "object" || Array.isArray(openclawMeta)) {
    return undefined;
  }
  const channelMeta = openclawMeta.channel;
  if (!channelMeta || typeof channelMeta !== "object" || Array.isArray(channelMeta)) {
    return undefined;
  }
  return channelMeta;
}

function resolveChannelConfigSchemaModulePath(rootDir) {
  const candidates = [
    path.join(rootDir, "src", "config-schema.ts"),
    path.join(rootDir, "src", "config-schema.js"),
    path.join(rootDir, "src", "config-schema.mts"),
    path.join(rootDir, "src", "config-schema.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveRootLabel(source, channelId) {
  const channelMeta = resolvePackageChannelMeta(source.packageJson);
  if (channelMeta?.id === channelId && typeof channelMeta.label === "string") {
    return channelMeta.label.trim();
  }
  if (typeof source.manifest?.name === "string" && source.manifest.name.trim()) {
    return source.manifest.name.trim();
  }
  return undefined;
}

function resolveRootDescription(source, channelId) {
  const channelMeta = resolvePackageChannelMeta(source.packageJson);
  if (channelMeta?.id === channelId && typeof channelMeta.blurb === "string") {
    return channelMeta.blurb.trim();
  }
  if (typeof source.manifest?.description === "string" && source.manifest.description.trim()) {
    return source.manifest.description.trim();
  }
  return undefined;
}

function resolveRootPreferOver(source, channelId) {
  const channelMeta = resolvePackageChannelMeta(source.packageJson);
  if (channelMeta?.id !== channelId || !Array.isArray(channelMeta.preferOver)) {
    return undefined;
  }
  const preferOver = channelMeta.preferOver
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return preferOver.length > 0 ? preferOver : undefined;
}

async function collectBundledChannelConfigsForSource({ source, manifest }) {
  const channelIds = Array.isArray(manifest.channels)
    ? manifest.channels.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  const existingChannelConfigs = normalizeObject(manifest.channelConfigs)
    ? { ...manifest.channelConfigs }
    : {};
  if (channelIds.length === 0) {
    return Object.keys(existingChannelConfigs).length > 0 ? existingChannelConfigs : undefined;
  }

  const modulePath = resolveChannelConfigSchemaModulePath(source.pluginDir);
  if (!modulePath || !fs.existsSync(modulePath)) {
    return Object.keys(existingChannelConfigs).length > 0 ? existingChannelConfigs : undefined;
  }

  const surfaceJson = execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/load-channel-config-surface.ts", modulePath],
    {
      // Run from the host repo so the generator always resolves its own loader/tooling,
      // even when inspecting a temporary or alternate repo root.
      cwd: FORMATTER_CWD,
      encoding: "utf8",
    },
  );
  const surface = JSON.parse(surfaceJson);
  if (!surface?.schema) {
    return Object.keys(existingChannelConfigs).length > 0 ? existingChannelConfigs : undefined;
  }

  for (const channelId of channelIds) {
    const existing =
      existingChannelConfigs[channelId] &&
      typeof existingChannelConfigs[channelId] === "object" &&
      !Array.isArray(existingChannelConfigs[channelId])
        ? existingChannelConfigs[channelId]
        : undefined;
    const label = existing?.label ?? resolveRootLabel(source, channelId);
    const description = existing?.description ?? resolveRootDescription(source, channelId);
    const preferOver = existing?.preferOver ?? resolveRootPreferOver(source, channelId);
    const uiHints =
      surface.uiHints || existing?.uiHints
        ? {
            ...(surface.uiHints && Object.keys(surface.uiHints).length > 0
              ? { ...surface.uiHints }
              : {}),
            ...(existing?.uiHints && Object.keys(existing.uiHints).length > 0
              ? { ...existing.uiHints }
              : {}),
          }
        : undefined;

    existingChannelConfigs[channelId] = {
      schema: surface.schema,
      ...(uiHints && Object.keys(uiHints).length > 0 ? { uiHints } : {}),
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
      ...(preferOver?.length ? { preferOver } : {}),
    };
  }

  return Object.keys(existingChannelConfigs).length > 0 ? existingChannelConfigs : undefined;
}

function formatTypeScriptModule(source, { outputPath }) {
  return formatGeneratedModule(source, {
    repoRoot: FORMATTER_CWD,
    outputPath,
    errorLabel: "bundled plugin metadata",
  });
}

function toIdentifier(dirName) {
  const cleaned = String(dirName)
    .replace(/[^a-zA-Z0-9]+(.)/g, (_match, next) => next.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, "")
    .replace(/^[^a-zA-Z]+/g, "");
  const base = cleaned || "plugin";
  return `${base[0].toLowerCase()}${base.slice(1)}Plugin`;
}

function normalizeGeneratedImportPath(dirName, builtPath) {
  return `../../extensions/${dirName}/${String(builtPath).replace(/^\.\//u, "")}`;
}

export async function collectBundledPluginMetadata(params = {}) {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const entries = [];
  for (const source of collectBundledPluginSources({ repoRoot, requirePackageJson: true })) {
    const manifest = normalizePluginManifest(source.manifest);
    if (!manifest) {
      continue;
    }

    const packageJson = source.packageJson;
    const packageManifest = normalizePackageManifest(packageJson);
    const extensions = Array.isArray(packageManifest?.extensions)
      ? packageManifest.extensions.filter((entry) => typeof entry === "string" && entry.trim())
      : [];
    if (extensions.length === 0) {
      continue;
    }

    const sourceEntry = extensions[0];
    const builtEntry = rewriteEntryToBuiltPath(sourceEntry);
    if (!builtEntry) {
      continue;
    }
    const setupEntry =
      typeof packageManifest?.setupEntry === "string" &&
      packageManifest.setupEntry.trim().length > 0
        ? {
            source: packageManifest.setupEntry.trim(),
            built: rewriteEntryToBuiltPath(packageManifest.setupEntry.trim()),
          }
        : undefined;
    const channelConfigs = await collectBundledChannelConfigsForSource({ source, manifest });
    if (channelConfigs) {
      manifest.channelConfigs = channelConfigs;
    }

    entries.push({
      dirName: source.dirName,
      idHint: deriveIdHint({
        filePath: sourceEntry,
        manifestId: manifest.id,
        packageName: typeof packageJson.name === "string" ? packageJson.name : undefined,
        hasMultipleExtensions: extensions.length > 1,
      }),
      source: {
        source: sourceEntry,
        built: builtEntry,
      },
      ...(setupEntry?.built
        ? { setupSource: { source: setupEntry.source, built: setupEntry.built } }
        : {}),
      ...(typeof packageJson.name === "string" ? { packageName: packageJson.name.trim() } : {}),
      ...(typeof packageJson.version === "string"
        ? { packageVersion: packageJson.version.trim() }
        : {}),
      ...(typeof packageJson.description === "string"
        ? { packageDescription: packageJson.description.trim() }
        : {}),
      ...(packageManifest ? { packageManifest } : {}),
      manifest,
    });
  }

  return entries.toSorted((left, right) => left.dirName.localeCompare(right.dirName));
}

export function renderBundledPluginMetadataModule(entries) {
  return `// Auto-generated by ${GENERATED_BY}. Do not edit directly.

export const GENERATED_BUNDLED_PLUGIN_METADATA = ${JSON.stringify(entries, null, 2)} as const;
`;
}

export function renderBundledPluginEntriesModule(entries) {
  const imports = entries
    .map((entry) => {
      const importPath = normalizeGeneratedImportPath(entry.dirName, entry.source.built);
      return `  import("${importPath}")`;
    })
    .join(",\n");
  const bindings = entries
    .map((entry) => {
      const identifier = toIdentifier(entry.dirName);
      return `${identifier}Module`;
    })
    .join(",\n    ");
  const identifiers = entries
    .map((entry) => {
      const identifier = toIdentifier(entry.dirName);
      return `${identifier}Module.default`;
    })
    .join(",\n    ");
  return `// Auto-generated by ${GENERATED_BY}. Do not edit directly.

export async function loadGeneratedBundledPluginEntries() {
  const [
    ${bindings}
  ] = await Promise.all([
${imports}
  ]);
  return [
    ${identifiers}
  ] as const;
}
`;
}

export async function writeBundledPluginMetadataModule(params = {}) {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const entries = await collectBundledPluginMetadata({ repoRoot });
  const outputPath = path.resolve(repoRoot, params.outputPath ?? DEFAULT_OUTPUT_PATH);
  const entriesOutputPath = path.resolve(
    repoRoot,
    params.entriesOutputPath ?? DEFAULT_ENTRIES_OUTPUT_PATH,
  );
  const metadataNext = formatTypeScriptModule(renderBundledPluginMetadataModule(entries), {
    outputPath,
  });
  const registryNext = formatTypeScriptModule(renderBundledPluginEntriesModule(entries), {
    outputPath: entriesOutputPath,
  });
  const metadataResult = writeGeneratedOutput({
    repoRoot,
    outputPath: params.outputPath ?? DEFAULT_OUTPUT_PATH,
    next: metadataNext,
    check: params.check,
  });
  const entriesResult = writeGeneratedOutput({
    repoRoot,
    outputPath: params.entriesOutputPath ?? DEFAULT_ENTRIES_OUTPUT_PATH,
    next: registryNext,
    check: params.check,
  });
  return {
    changed: metadataResult.changed || entriesResult.changed,
    wrote: metadataResult.wrote || entriesResult.wrote,
    outputPaths: [metadataResult.outputPath, entriesResult.outputPath],
  };
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const check = process.argv.includes("--check");
  const result = await writeBundledPluginMetadataModule({ check });
  if (!result.changed) {
    process.exitCode = 0;
  } else if (check) {
    for (const outputPath of result.outputPaths) {
      const relativeOutputPath = path.relative(process.cwd(), outputPath);
      console.error(`[bundled-plugin-metadata] stale generated output at ${relativeOutputPath}`);
    }
    process.exitCode = 1;
  } else {
    for (const outputPath of result.outputPaths) {
      const relativeOutputPath = path.relative(process.cwd(), outputPath);
      console.log(`[bundled-plugin-metadata] wrote ${relativeOutputPath}`);
    }
  }
}
