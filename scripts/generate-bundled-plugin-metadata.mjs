import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatGeneratedModule } from "./lib/format-generated-module.mjs";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";

const GENERATED_BY = "scripts/generate-bundled-plugin-metadata.mjs";
const DEFAULT_OUTPUT_PATH = "src/plugins/bundled-plugin-metadata.generated.ts";
const MANIFEST_KEY = "openclaw";
const FORMATTER_CWD = path.resolve(import.meta.dirname, "..");
const CANONICAL_PACKAGE_ID_ALIASES = {
  "elevenlabs-speech": "elevenlabs",
  "microsoft-speech": "microsoft",
  "ollama-provider": "ollama",
  "sglang-provider": "sglang",
  "vllm-provider": "vllm",
};

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function rewriteEntryToBuiltPath(entry) {
  if (typeof entry !== "string" || entry.trim().length === 0) {
    return undefined;
  }
  const normalized = entry.replace(/^\.\//u, "");
  return normalized.replace(/\.[^.]+$/u, ".js");
}

function deriveIdHint({ filePath, packageName, hasMultipleExtensions }) {
  const base = path.basename(filePath, path.extname(filePath));
  const rawPackageName = packageName?.trim();
  if (!rawPackageName) {
    return base;
  }

  const unscoped = rawPackageName.includes("/")
    ? (rawPackageName.split("/").pop() ?? rawPackageName)
    : rawPackageName;
  const canonicalPackageId = CANONICAL_PACKAGE_ID_ALIASES[unscoped] ?? unscoped;
  const normalizedPackageId =
    canonicalPackageId.endsWith("-provider") && canonicalPackageId.length > "-provider".length
      ? canonicalPackageId.slice(0, -"-provider".length)
      : canonicalPackageId;

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
  };
}

function formatTypeScriptModule(source, { outputPath }) {
  return formatGeneratedModule(source, {
    repoRoot: FORMATTER_CWD,
    outputPath,
    errorLabel: "bundled plugin metadata",
  });
}

export function collectBundledPluginMetadata(params = {}) {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const extensionsRoot = path.join(repoRoot, "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return [];
  }

  const entries = [];
  for (const dirent of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const pluginDir = path.join(extensionsRoot, dirent.name);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const packageJsonPath = path.join(pluginDir, "package.json");
    if (!fs.existsSync(manifestPath) || !fs.existsSync(packageJsonPath)) {
      continue;
    }

    const manifest = normalizePluginManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    if (!manifest) {
      continue;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
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

    entries.push({
      dirName: dirent.name,
      idHint: deriveIdHint({
        filePath: sourceEntry,
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

export function writeBundledPluginMetadataModule(params = {}) {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputPath = path.resolve(repoRoot, params.outputPath ?? DEFAULT_OUTPUT_PATH);
  const next = formatTypeScriptModule(
    renderBundledPluginMetadataModule(collectBundledPluginMetadata({ repoRoot })),
    { outputPath },
  );
  const current = readIfExists(outputPath);
  const changed = current !== next;

  if (params.check) {
    return {
      changed,
      wrote: false,
      outputPath,
    };
  }

  return {
    changed,
    wrote: writeTextFileIfChanged(outputPath, next),
    outputPath,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = writeBundledPluginMetadataModule({
    check: process.argv.includes("--check"),
  });

  if (result.changed) {
    if (process.argv.includes("--check")) {
      console.error(
        `[bundled-plugin-metadata] stale generated output at ${path.relative(process.cwd(), result.outputPath)}`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `[bundled-plugin-metadata] wrote ${path.relative(process.cwd(), result.outputPath)}`,
      );
    }
  }
}
