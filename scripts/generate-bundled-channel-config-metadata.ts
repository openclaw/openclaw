#!/usr/bin/env node
// Generate Bundled Channel Config Metadata script supports OpenClaw repository automation.
import fs from "node:fs";
import path from "node:path";
import { asFiniteNumber } from "../packages/normalization-core/src/number-coercion.ts";
import { asOptionalRecord } from "../packages/normalization-core/src/record-coerce.ts";
import {
  normalizeTrimmedStringList,
  normalizeUniqueTrimmedStringList,
  uniqueStrings,
} from "../packages/normalization-core/src/string-normalization.ts";
import { loadBundledPluginPublicArtifactModuleSync } from "../src/plugins/public-surface-loader.js";
import { collectBundledPluginSources } from "./lib/bundled-plugin-source-utils.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { formatGeneratedModule } from "./lib/format-generated-module.mts";
import { writeGeneratedOutput } from "./lib/generated-output-utils.mts";
import { loadChannelConfigSurfaceModule } from "./load-channel-config-surface.ts";

const GENERATED_BY = "scripts/generate-bundled-channel-config-metadata.ts";
const DEFAULT_OUTPUT_PATH = "src/config/bundled-channel-config-metadata.generated.ts";
const IDS_OUTPUT_PATH = "src/channels/bundled-channel-ids.generated.ts";
const GENERATED_JSON_CHUNK_SIZE = 16 * 1024;

type BundledPluginSource = ReturnType<typeof collectBundledPluginSources>[number];

type BundledChannelSecuritySurface = {
  unsupportedSecretRefSurfacePatterns?: readonly string[];
};

function resolveChannelConfigSchemaModulePath(rootDir: string): string | null {
  const candidates = [
    path.join(rootDir, "src", "config-schema.ts"),
    path.join(rootDir, "src", "config-schema.js"),
    path.join(rootDir, "src", "config-schema.mts"),
    path.join(rootDir, "src", "config-schema.mjs"),
    path.join(rootDir, "src", "config-surface.ts"),
    path.join(rootDir, "src", "config-surface.js"),
    path.join(rootDir, "src", "config-surface.mts"),
    path.join(rootDir, "src", "config-surface.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolvePackageChannelMeta(source: BundledPluginSource) {
  return asOptionalRecord(
    asOptionalRecord(asOptionalRecord(source.packageJson)?.openclaw)?.channel,
  );
}

function resolveRootText(channelValue: unknown, manifestValue: unknown): string | undefined {
  if (typeof channelValue === "string") {
    return channelValue.trim();
  }
  return typeof manifestValue === "string" && manifestValue.trim()
    ? manifestValue.trim()
    : undefined;
}

type PackageChannelMeta = ReturnType<typeof resolvePackageChannelMeta>;

function resolveRootAliases(channelMeta: PackageChannelMeta): string[] {
  return uniqueStrings(
    normalizeTrimmedStringList(channelMeta?.aliases).map((alias) => alias.toLowerCase()),
  ).toSorted((left, right) => left.localeCompare(right));
}

function resolveRootChannelEnvVars(channelMeta: PackageChannelMeta): string[] {
  const env = asOptionalRecord(asOptionalRecord(channelMeta?.configuredState)?.env);
  if (!env) {
    return [];
  }
  const values = [env.allOf, env.anyOf].flatMap((value) => (Array.isArray(value) ? value : []));
  return normalizeUniqueTrimmedStringList(values).toSorted((left, right) =>
    left.localeCompare(right),
  );
}

function formatTypeScriptModule(source: string, outputPath: string, repoRoot: string): string {
  return formatGeneratedModule(source, {
    repoRoot,
    outputPath,
    errorLabel: "bundled channel config metadata",
  });
}

function formatJsonStringChunks(value: unknown): string {
  const json = JSON.stringify(value);
  const chunks: string[] = [];
  for (let index = 0; index < json.length; index += GENERATED_JSON_CHUNK_SIZE) {
    chunks.push(JSON.stringify(json.slice(index, index + GENERATED_JSON_CHUNK_SIZE)));
  }
  return chunks.join(",\n  ");
}

function resolveChannelUnsupportedSecretRefSurfacePatterns(
  source: BundledPluginSource,
  channelId: string,
): string[] {
  try {
    const surface = loadBundledPluginPublicArtifactModuleSync<BundledChannelSecuritySurface>({
      dirName: source.dirName,
      artifactBasename: "security-contract-api.js",
    });
    const prefix = `channels.${channelId}.`;
    return [
      ...new Set(
        (surface.unsupportedSecretRefSurfacePatterns ?? []).filter(
          (pattern): pattern is string => typeof pattern === "string" && pattern.startsWith(prefix),
        ),
      ),
    ].toSorted((left, right) => left.localeCompare(right));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Unable to resolve bundled plugin public surface ")
    ) {
      return [];
    }
    throw error;
  }
}

async function collectBundledChannelConfigMetadata(repoRoot: string) {
  const sources = collectBundledPluginSources({ repoRoot, requirePackageJson: true });
  const entries = [];

  for (const source of sources) {
    const manifest = asOptionalRecord(source.manifest);
    const channelIds = Array.isArray(manifest?.channels)
      ? manifest.channels.filter(
          (entry: unknown): entry is string => typeof entry === "string" && entry.trim().length > 0,
        )
      : [];
    if (channelIds.length === 0) {
      continue;
    }
    const modulePath = resolveChannelConfigSchemaModulePath(source.pluginDir);
    if (!modulePath) {
      continue;
    }
    const surface = await loadChannelConfigSurfaceModule(modulePath);
    if (!surface?.schema) {
      continue;
    }
    const packageChannel = resolvePackageChannelMeta(source);
    for (const channelId of channelIds) {
      const channelMeta = packageChannel?.id === channelId ? packageChannel : undefined;
      const aliases = resolveRootAliases(channelMeta);
      const order = asFiniteNumber(channelMeta?.order);
      const configurable = asOptionalRecord(channelMeta?.exposure)?.configured !== false;
      const channelEnvVars = resolveRootChannelEnvVars(channelMeta);
      const label = resolveRootText(channelMeta?.label, manifest?.name);
      const description = resolveRootText(channelMeta?.blurb, manifest?.description);
      const unsupportedSecretRefSurfacePatterns = resolveChannelUnsupportedSecretRefSurfacePatterns(
        source,
        channelId,
      );
      entries.push({
        pluginId: manifest?.id,
        channelId,
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(order === undefined ? {} : { order }),
        ...(configurable ? {} : { configurable }),
        ...(channelEnvVars.length > 0 ? { channelEnvVars } : {}),
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        schema: surface.schema,
        ...(Object.keys(surface.uiHints ?? {}).length > 0 ? { uiHints: surface.uiHints } : {}),
        ...(unsupportedSecretRefSurfacePatterns.length > 0
          ? { unsupportedSecretRefSurfacePatterns }
          : {}),
      });
    }
  }

  return entries.toSorted((left, right) => left.channelId.localeCompare(right.channelId));
}

async function writeBundledChannelConfigMetadataModule(check: boolean) {
  const repoRoot = process.cwd();
  const outputPath = DEFAULT_OUTPUT_PATH;
  const entries = await collectBundledChannelConfigMetadata(repoRoot);
  const chunks = formatJsonStringChunks(entries);
  const next = formatTypeScriptModule(
    `// Auto-generated by ${GENERATED_BY}. Do not edit directly.

type BundledChannelConfigMetadata = {
  pluginId: string;
  channelId: string;
  aliases?: readonly string[];
  order?: number;
  configurable?: boolean;
  channelEnvVars?: readonly string[];
  label?: string;
  description?: string;
  schema: Record<string, unknown>;
  uiHints?: Record<string, unknown>;
  unsupportedSecretRefSurfacePatterns?: readonly string[];
};

const RAW_BUNDLED_CHANNEL_CONFIG_METADATA = [
  ${chunks},
].join("");

export const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA = JSON.parse(
  RAW_BUNDLED_CHANNEL_CONFIG_METADATA,
) as readonly BundledChannelConfigMetadata[];
`,
    outputPath,
    repoRoot,
  );
  const ids = entries.map(({ channelId, aliases, order, configurable, label }) => ({
    channelId,
    aliases,
    order,
    configurable,
    label,
  }));
  const idsModule = formatTypeScriptModule(
    `// Auto-generated by ${GENERATED_BY}. Do not edit directly.

type BundledChannelIdMetadata = {
  channelId: string;
  aliases?: readonly string[];
  order?: number;
  configurable?: boolean;
  label?: string;
};

export const GENERATED_BUNDLED_CHANNEL_IDS: readonly BundledChannelIdMetadata[] = ${JSON.stringify(ids, null, 2)};
`,
    IDS_OUTPUT_PATH,
    repoRoot,
  );
  return [
    writeGeneratedOutput({ repoRoot, outputPath, next, check }),
    writeGeneratedOutput({
      repoRoot,
      outputPath: IDS_OUTPUT_PATH,
      next: idsModule,
      check,
    }),
  ];
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const check = process.argv.includes("--check");
  const results = await writeBundledChannelConfigMetadataModule(check);
  for (const result of results) {
    if (!result.changed) {
      continue;
    }
    if (check) {
      console.error(
        `[bundled-channel-config-metadata] stale generated output at ${path.relative(process.cwd(), result.outputPath)}; run "pnpm config:channels:gen" and commit the result`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `[bundled-channel-config-metadata] wrote ${path.relative(process.cwd(), result.outputPath)}`,
      );
    }
  }
}
