#!/usr/bin/env node
// Generates the compact official-external plugin projection used by Gateway startup.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const GENERATED_BY = "scripts/generate-official-external-plugin-startup-metadata.ts";
const DEFAULT_OUTPUT_PATH = "src/plugins/official-external-plugin-startup-metadata.generated.ts";
const GENERATED_JSON_CHUNK_SIZE = 16 * 1024;
const CATALOG_PATHS = [
  "scripts/lib/official-external-channel-catalog.json",
  "scripts/lib/official-external-provider-catalog.json",
  "scripts/lib/official-external-plugin-catalog.json",
] as const;
const CONTRACT_KEYS = [
  "embeddedExtensionFactories",
  "agentToolResultMiddleware",
  "trustedToolPolicies",
  "externalAuthProviders",
  "embeddingProviders",
  "memoryEmbeddingProviders",
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "transcriptSourceProviders",
  "documentExtractors",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webContentExtractors",
  "webFetchProviders",
  "webSearchProviders",
  "workerProviders",
  "usageProviders",
  "migrationProviders",
  "gatewayMethodDispatch",
  "tools",
] as const;

type StartupProvider = {
  id: string;
  aliases?: string[];
  envVars?: string[];
};

type StartupWebProvider = {
  id: string;
  envVars?: string[];
};

type StartupChannel = {
  id: string;
  aliases?: string[];
  envVars?: string[];
};

type StartupProviderEndpoint = {
  endpointClass: string;
  hosts?: string[];
  hostSuffixes?: string[];
  baseUrls?: string[];
  googleVertexRegion?: string;
  googleVertexRegionHostSuffix?: string;
};

export type OfficialExternalPluginStartupMetadata = {
  pluginId: string;
  packageName: string;
  source: string;
  install?: {
    preferredSpec?: string;
    npmSpec?: string;
  };
  catalog?: {
    featured?: boolean;
    order?: number;
  };
  contracts?: Record<string, string[]>;
  channelConfigs?: Record<string, Record<string, unknown>>;
  providers?: StartupProvider[];
  webSearchProviders?: StartupWebProvider[];
  channels?: StartupChannel[];
  providerEndpoints?: StartupProviderEndpoint[];
};

const { formatGeneratedModule } = (await import(
  new URL("./lib/format-generated-module.mjs", import.meta.url).href
)) as {
  formatGeneratedModule: (
    source: string,
    options: { repoRoot: string; outputPath: string; errorLabel: string },
  ) => string;
};

const { writeGeneratedOutput } = (await import(
  new URL("./lib/generated-output-utils.mjs", import.meta.url).href
)) as {
  writeGeneratedOutput: (params: {
    repoRoot: string;
    outputPath: string;
    next: string;
    check?: boolean;
  }) => { changed: boolean; wrote: boolean; outputPath: string };
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeStringList(value: unknown, lowercase = false): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const resolved = new Map<string, string>();
  for (const entry of value) {
    const normalized = normalizeString(entry);
    if (!normalized) {
      continue;
    }
    const output = lowercase ? normalized.toLowerCase() : normalized;
    resolved.set(output.toLowerCase(), output);
  }
  return [...resolved.values()].toSorted(compareStrings);
}

function normalizeOrderedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const resolved = new Set<string>();
  const values: string[] = [];
  for (const entry of value) {
    const normalized = normalizeString(entry);
    if (!normalized || resolved.has(normalized)) {
      continue;
    }
    resolved.add(normalized);
    values.push(normalized);
  }
  return values;
}

function mergeStringLists(left: readonly string[] = [], right: readonly string[] = []): string[] {
  return normalizeStringList([...left, ...right]);
}

function mergeOrderedStringLists(
  left: readonly string[] = [],
  right: readonly string[] = [],
): string[] {
  return normalizeOrderedStringList([...left, ...right]);
}

function resolveManifest(entry: Record<string, unknown>): Record<string, unknown> {
  return isRecord(entry.openclaw) ? entry.openclaw : {};
}

function resolvePluginId(
  entry: Record<string, unknown>,
  manifest: Record<string, unknown>,
): string | undefined {
  const plugin = isRecord(manifest.plugin) ? manifest.plugin : undefined;
  const channel = isRecord(manifest.channel) ? manifest.channel : undefined;
  const providers = Array.isArray(manifest.providers) ? manifest.providers.filter(isRecord) : [];
  return (
    normalizeString(plugin?.id) ??
    normalizeString(channel?.id) ??
    normalizeString(providers[0]?.id) ??
    normalizeString(entry.id)
  );
}

function collectProviders(manifest: Record<string, unknown>): StartupProvider[] {
  const providers = Array.isArray(manifest.providers) ? manifest.providers.filter(isRecord) : [];
  return providers.flatMap((provider) => {
    const id = normalizeString(provider.id)?.toLowerCase();
    if (!id) {
      return [];
    }
    const aliases = normalizeStringList(provider.aliases, true).filter((alias) => alias !== id);
    const envVars = normalizeStringList(provider.envVars);
    return [
      {
        id,
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(envVars.length > 0 ? { envVars } : {}),
      },
    ];
  });
}

function collectWebSearchProviders(manifest: Record<string, unknown>): StartupWebProvider[] {
  const providers = Array.isArray(manifest.webSearchProviders)
    ? manifest.webSearchProviders.filter(isRecord)
    : [];
  return providers.flatMap((provider) => {
    const id = normalizeString(provider.id)?.toLowerCase();
    if (!id) {
      return [];
    }
    const envVars = normalizeStringList(provider.envVars);
    return [{ id, ...(envVars.length > 0 ? { envVars } : {}) }];
  });
}

function collectChannels(manifest: Record<string, unknown>): StartupChannel[] {
  const channel = isRecord(manifest.channel) ? manifest.channel : undefined;
  const id = normalizeString(channel?.id)?.toLowerCase();
  if (!id) {
    return [];
  }
  const aliases = normalizeStringList(channel?.aliases, true).filter((alias) => alias !== id);
  const envVars = normalizeStringList(channel?.envVars);
  return [
    {
      id,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(envVars.length > 0 ? { envVars } : {}),
    },
  ];
}

function collectCatalog(manifest: Record<string, unknown>) {
  const catalog = isRecord(manifest.catalog) ? manifest.catalog : undefined;
  const featured = typeof catalog?.featured === "boolean" ? catalog.featured : undefined;
  const order =
    typeof catalog?.order === "number" && Number.isFinite(catalog.order)
      ? catalog.order
      : undefined;
  return featured === undefined && order === undefined
    ? undefined
    : {
        ...(featured !== undefined ? { featured } : {}),
        ...(order !== undefined ? { order } : {}),
      };
}

function collectContracts(manifest: Record<string, unknown>): Record<string, string[]> | undefined {
  const rawContracts = isRecord(manifest.contracts) ? manifest.contracts : undefined;
  if (!rawContracts) {
    return undefined;
  }
  const contracts: Record<string, string[]> = {};
  for (const key of CONTRACT_KEYS) {
    const values = normalizeOrderedStringList(rawContracts[key]);
    if (values.length > 0) {
      contracts[key] = values;
    }
  }
  return Object.keys(contracts).length > 0 ? contracts : undefined;
}

function collectChannelConfigs(
  manifest: Record<string, unknown>,
): Record<string, Record<string, unknown>> | undefined {
  if (!isRecord(manifest.channelConfigs)) {
    return undefined;
  }
  const channelConfigs = Object.fromEntries(
    Object.entries(manifest.channelConfigs)
      .filter(([, value]) => isRecord(value))
      .toSorted(([left], [right]) => compareStrings(left, right)),
  );
  return Object.keys(channelConfigs).length > 0 ? channelConfigs : undefined;
}

function collectProviderEndpoints(manifest: Record<string, unknown>): StartupProviderEndpoint[] {
  const endpoints = Array.isArray(manifest.providerEndpoints)
    ? manifest.providerEndpoints.filter(isRecord)
    : [];
  return endpoints
    .flatMap((endpoint) => {
      const endpointClass = normalizeString(endpoint.endpointClass);
      if (!endpointClass) {
        return [];
      }
      const hosts = normalizeStringList(endpoint.hosts, true);
      const hostSuffixes = normalizeStringList(endpoint.hostSuffixes, true);
      const baseUrls = normalizeStringList(endpoint.baseUrls, true).map((value) =>
        value.replace(/\/+$/u, ""),
      );
      const googleVertexRegion = normalizeString(endpoint.googleVertexRegion);
      const googleVertexRegionHostSuffix = normalizeString(
        endpoint.googleVertexRegionHostSuffix,
      )?.toLowerCase();
      return [
        {
          endpointClass,
          ...(hosts.length > 0 ? { hosts } : {}),
          ...(hostSuffixes.length > 0 ? { hostSuffixes } : {}),
          ...(baseUrls.length > 0 ? { baseUrls } : {}),
          ...(googleVertexRegion ? { googleVertexRegion } : {}),
          ...(googleVertexRegionHostSuffix ? { googleVertexRegionHostSuffix } : {}),
        },
      ];
    })
    .toSorted((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)));
}

function collectInstallMetadata(
  entry: Record<string, unknown>,
  manifest: Record<string, unknown>,
  packageName: string,
): OfficialExternalPluginStartupMetadata["install"] {
  const install = isRecord(manifest.install) ? manifest.install : undefined;
  const npmSpec = normalizeString(install?.npmSpec) ?? (!install ? packageName : undefined);
  const clawhubSpec = normalizeString(install?.clawhubSpec);
  const defaultChoice = normalizeString(install?.defaultChoice);
  const preferredSpec =
    defaultChoice === "clawhub" ? (clawhubSpec ?? npmSpec) : (npmSpec ?? clawhubSpec);
  if (!preferredSpec && !npmSpec) {
    return undefined;
  }
  return {
    ...(preferredSpec ? { preferredSpec } : {}),
    ...(npmSpec ? { npmSpec } : {}),
  };
}

function assertCompatibleScalar(params: {
  field: string;
  pluginId: string;
  left: string | undefined;
  right: string | undefined;
}): string | undefined {
  if (params.left && params.right && params.left !== params.right) {
    throw new Error(
      `official external startup metadata conflict for ${params.pluginId}: ${params.field} is ${JSON.stringify(params.left)} and ${JSON.stringify(params.right)}`,
    );
  }
  return params.left ?? params.right;
}

function mergeProviders(
  left: readonly StartupProvider[] = [],
  right: readonly StartupProvider[] = [],
): StartupProvider[] {
  const byId = new Map<string, StartupProvider>();
  for (const provider of [...left, ...right]) {
    const current = byId.get(provider.id);
    byId.set(provider.id, {
      id: provider.id,
      ...(current?.aliases?.length || provider.aliases?.length
        ? { aliases: mergeStringLists(current?.aliases, provider.aliases) }
        : {}),
      ...(current?.envVars?.length || provider.envVars?.length
        ? { envVars: mergeStringLists(current?.envVars, provider.envVars) }
        : {}),
    });
  }
  return [...byId.values()].toSorted((left, right) => compareStrings(left.id, right.id));
}

function mergeWebProviders(
  left: readonly StartupWebProvider[] = [],
  right: readonly StartupWebProvider[] = [],
): StartupWebProvider[] {
  const byId = new Map<string, StartupWebProvider>();
  for (const provider of [...left, ...right]) {
    const current = byId.get(provider.id);
    const envVars = mergeStringLists(current?.envVars, provider.envVars);
    byId.set(provider.id, { id: provider.id, ...(envVars.length > 0 ? { envVars } : {}) });
  }
  return [...byId.values()].toSorted((left, right) => compareStrings(left.id, right.id));
}

function mergeChannels(
  left: readonly StartupChannel[] = [],
  right: readonly StartupChannel[] = [],
): StartupChannel[] {
  const byId = new Map<string, StartupChannel>();
  for (const channel of [...left, ...right]) {
    const current = byId.get(channel.id);
    const aliases = mergeStringLists(current?.aliases, channel.aliases);
    const envVars = mergeStringLists(current?.envVars, channel.envVars);
    byId.set(channel.id, {
      id: channel.id,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(envVars.length > 0 ? { envVars } : {}),
    });
  }
  return [...byId.values()].toSorted((left, right) => compareStrings(left.id, right.id));
}

function mergeContracts(
  left: Record<string, string[]> | undefined,
  right: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  const contracts: Record<string, string[]> = {};
  for (const key of CONTRACT_KEYS) {
    const values = mergeOrderedStringLists(left?.[key], right?.[key]);
    if (values.length > 0) {
      contracts[key] = values;
    }
  }
  return Object.keys(contracts).length > 0 ? contracts : undefined;
}

function mergeCatalog(
  pluginId: string,
  left: OfficialExternalPluginStartupMetadata["catalog"],
  right: OfficialExternalPluginStartupMetadata["catalog"],
): OfficialExternalPluginStartupMetadata["catalog"] {
  const featured = assertCompatibleScalarValue({
    field: "catalog.featured",
    pluginId,
    left: left?.featured,
    right: right?.featured,
  });
  const order = assertCompatibleScalarValue({
    field: "catalog.order",
    pluginId,
    left: left?.order,
    right: right?.order,
  });
  return featured === undefined && order === undefined
    ? undefined
    : {
        ...(featured !== undefined ? { featured } : {}),
        ...(order !== undefined ? { order } : {}),
      };
}

function assertCompatibleScalarValue<T extends string | number | boolean>(params: {
  field: string;
  pluginId: string;
  left: T | undefined;
  right: T | undefined;
}): T | undefined {
  if (params.left !== undefined && params.right !== undefined && params.left !== params.right) {
    throw new Error(
      `official external startup metadata conflict for ${params.pluginId}: ${params.field} is ${JSON.stringify(params.left)} and ${JSON.stringify(params.right)}`,
    );
  }
  return params.left ?? params.right;
}

function mergeChannelConfigs(
  pluginId: string,
  left: Record<string, Record<string, unknown>> | undefined,
  right: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  const merged = { ...left };
  for (const [channelId, channelConfig] of Object.entries(right ?? {})) {
    const current = merged[channelId];
    if (current && !isDeepStrictEqual(current, channelConfig)) {
      throw new Error(
        `official external startup metadata conflict for ${pluginId}: channelConfigs.${channelId} differs across catalogs`,
      );
    }
    merged[channelId] = channelConfig;
  }
  return Object.keys(merged).length > 0
    ? Object.fromEntries(Object.entries(merged).toSorted(([a], [b]) => compareStrings(a, b)))
    : undefined;
}

function mergeEndpoints(
  left: readonly StartupProviderEndpoint[] = [],
  right: readonly StartupProviderEndpoint[] = [],
): StartupProviderEndpoint[] {
  const byValue = new Map<string, StartupProviderEndpoint>();
  for (const endpoint of [...left, ...right]) {
    byValue.set(JSON.stringify(endpoint), endpoint);
  }
  return [...byValue.values()].toSorted((a, b) =>
    compareStrings(JSON.stringify(a), JSON.stringify(b)),
  );
}

function mergeMetadata(
  left: OfficialExternalPluginStartupMetadata,
  right: OfficialExternalPluginStartupMetadata,
): OfficialExternalPluginStartupMetadata {
  const packageName = assertCompatibleScalar({
    field: "packageName",
    pluginId: left.pluginId,
    left: left.packageName,
    right: right.packageName,
  })!;
  const source = assertCompatibleScalar({
    field: "source",
    pluginId: left.pluginId,
    left: left.source,
    right: right.source,
  })!;
  const preferredSpec = assertCompatibleScalar({
    field: "install.preferredSpec",
    pluginId: left.pluginId,
    left: left.install?.preferredSpec,
    right: right.install?.preferredSpec,
  });
  const npmSpec = assertCompatibleScalar({
    field: "install.npmSpec",
    pluginId: left.pluginId,
    left: left.install?.npmSpec,
    right: right.install?.npmSpec,
  });
  const catalog = mergeCatalog(left.pluginId, left.catalog, right.catalog);
  const contracts = mergeContracts(left.contracts, right.contracts);
  const channelConfigs = mergeChannelConfigs(
    left.pluginId,
    left.channelConfigs,
    right.channelConfigs,
  );
  const providers = mergeProviders(left.providers, right.providers);
  const webSearchProviders = mergeWebProviders(left.webSearchProviders, right.webSearchProviders);
  const channels = mergeChannels(left.channels, right.channels);
  const providerEndpoints = mergeEndpoints(left.providerEndpoints, right.providerEndpoints);
  return {
    pluginId: left.pluginId,
    packageName,
    source,
    ...(preferredSpec || npmSpec
      ? {
          install: { ...(preferredSpec ? { preferredSpec } : {}), ...(npmSpec ? { npmSpec } : {}) },
        }
      : {}),
    ...(catalog ? { catalog } : {}),
    ...(contracts ? { contracts } : {}),
    ...(channelConfigs ? { channelConfigs } : {}),
    ...(providers.length > 0 ? { providers } : {}),
    ...(webSearchProviders.length > 0 ? { webSearchProviders } : {}),
    ...(channels.length > 0 ? { channels } : {}),
    ...(providerEndpoints.length > 0 ? { providerEndpoints } : {}),
  };
}

function assertUniqueOwnership(entries: readonly OfficialExternalPluginStartupMetadata[]): void {
  const packageOwners = new Map<string, string>();
  const lookupOwners = new Map<string, string>();
  const endpointClasses = new Map<string, string>();
  const claim = (claims: Map<string, string>, key: string, owner: string, label: string) => {
    const current = claims.get(key);
    if (current && current !== owner) {
      throw new Error(
        `official external startup metadata conflict: ${label} ${JSON.stringify(key)} is owned by ${current} and ${owner}`,
      );
    }
    claims.set(key, owner);
  };
  for (const entry of entries) {
    claim(packageOwners, entry.packageName, entry.pluginId, "package");
    for (const lookupId of [
      entry.pluginId,
      ...(entry.providers ?? []).flatMap((provider) => [provider.id, ...(provider.aliases ?? [])]),
      ...(entry.channels ?? []).flatMap((channel) => [channel.id, ...(channel.aliases ?? [])]),
    ]) {
      claim(lookupOwners, lookupId.toLowerCase(), entry.pluginId, "lookup id");
    }
    for (const endpoint of entry.providerEndpoints ?? []) {
      for (const [kind, values] of [
        ["host", endpoint.hosts],
        ["hostSuffix", endpoint.hostSuffixes],
        ["baseUrl", endpoint.baseUrls],
      ] as const) {
        for (const value of values ?? []) {
          claim(
            endpointClasses,
            `${kind}:${value.toLowerCase()}`,
            endpoint.endpointClass,
            "endpoint",
          );
        }
      }
      if (endpoint.googleVertexRegion || endpoint.googleVertexRegionHostSuffix) {
        claim(
          endpointClasses,
          `googleVertex:${endpoint.googleVertexRegion ?? ""}:${endpoint.googleVertexRegionHostSuffix ?? ""}`,
          endpoint.endpointClass,
          "endpoint",
        );
      }
    }
  }
}

export function buildOfficialExternalPluginStartupMetadata(
  catalogs: readonly unknown[],
): OfficialExternalPluginStartupMetadata[] {
  const byPluginId = new Map<string, OfficialExternalPluginStartupMetadata>();
  for (const catalog of catalogs) {
    if (!isRecord(catalog) || !Array.isArray(catalog.entries)) {
      throw new Error("official external catalog must contain an entries array");
    }
    for (const rawEntry of catalog.entries) {
      if (!isRecord(rawEntry)) {
        throw new Error("official external catalog entry must be an object");
      }
      const manifest = resolveManifest(rawEntry);
      const pluginId = resolvePluginId(rawEntry, manifest)?.toLowerCase();
      const packageName = normalizeString(rawEntry.name);
      const source = normalizeString(rawEntry.source);
      if (!pluginId || !packageName || !source) {
        throw new Error(
          "official external catalog entry is missing plugin id, package name, or source",
        );
      }
      const catalog = collectCatalog(manifest);
      const contracts = collectContracts(manifest);
      const channelConfigs = collectChannelConfigs(manifest);
      const providers = collectProviders(manifest);
      const webSearchProviders = collectWebSearchProviders(manifest);
      const channels = collectChannels(manifest);
      const providerEndpoints = collectProviderEndpoints(manifest);
      const install = collectInstallMetadata(rawEntry, manifest, packageName);
      const entry: OfficialExternalPluginStartupMetadata = {
        pluginId,
        packageName,
        source,
        ...(install ? { install } : {}),
        ...(catalog ? { catalog } : {}),
        ...(contracts ? { contracts } : {}),
        ...(channelConfigs ? { channelConfigs } : {}),
        ...(providers.length > 0 ? { providers } : {}),
        ...(webSearchProviders.length > 0 ? { webSearchProviders } : {}),
        ...(channels.length > 0 ? { channels } : {}),
        ...(providerEndpoints.length > 0 ? { providerEndpoints } : {}),
      };
      const current = byPluginId.get(pluginId);
      byPluginId.set(pluginId, current ? mergeMetadata(current, entry) : entry);
    }
  }
  const entries = [...byPluginId.values()].toSorted((left, right) =>
    compareStrings(left.pluginId, right.pluginId),
  );
  assertUniqueOwnership(entries);
  return entries;
}

function formatJsonStringChunks(value: unknown): string {
  const json = JSON.stringify(value);
  const chunks: string[] = [];
  for (let index = 0; index < json.length; index += GENERATED_JSON_CHUNK_SIZE) {
    chunks.push(JSON.stringify(json.slice(index, index + GENERATED_JSON_CHUNK_SIZE)));
  }
  return chunks.join(",\n  ");
}

export async function writeOfficialExternalPluginStartupMetadataModule(params?: {
  repoRoot?: string;
  outputPath?: string;
  check?: boolean;
}) {
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const outputPath = params?.outputPath ?? DEFAULT_OUTPUT_PATH;
  const catalogs = CATALOG_PATHS.map((catalogPath) =>
    JSON.parse(fs.readFileSync(path.join(repoRoot, catalogPath), "utf8")),
  );
  const entries = buildOfficialExternalPluginStartupMetadata(catalogs);
  const chunks = formatJsonStringChunks(entries);
  const next = formatGeneratedModule(
    `// Auto-generated by ${GENERATED_BY}. Do not edit directly.

type OfficialExternalPluginStartupProvider = {
  id: string;
  aliases?: readonly string[];
  envVars?: readonly string[];
};

type OfficialExternalPluginStartupWebProvider = {
  id: string;
  envVars?: readonly string[];
};

type OfficialExternalPluginStartupChannel = {
  id: string;
  aliases?: readonly string[];
  envVars?: readonly string[];
};

type OfficialExternalPluginStartupProviderEndpoint = {
  endpointClass: string;
  hosts?: readonly string[];
  hostSuffixes?: readonly string[];
  baseUrls?: readonly string[];
  googleVertexRegion?: string;
  googleVertexRegionHostSuffix?: string;
};

export type OfficialExternalPluginStartupMetadata = {
  pluginId: string;
  packageName: string;
  source: string;
  install?: {
    preferredSpec?: string;
    npmSpec?: string;
  };
  catalog?: {
    featured?: boolean;
    order?: number;
  };
  contracts?: Readonly<Record<string, readonly string[]>>;
  channelConfigs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  providers?: readonly OfficialExternalPluginStartupProvider[];
  webSearchProviders?: readonly OfficialExternalPluginStartupWebProvider[];
  channels?: readonly OfficialExternalPluginStartupChannel[];
  providerEndpoints?: readonly OfficialExternalPluginStartupProviderEndpoint[];
};

const RAW_OFFICIAL_EXTERNAL_PLUGIN_STARTUP_METADATA = [
  ${chunks},
].join("");

export const GENERATED_OFFICIAL_EXTERNAL_PLUGIN_STARTUP_METADATA = JSON.parse(
  RAW_OFFICIAL_EXTERNAL_PLUGIN_STARTUP_METADATA,
) as readonly OfficialExternalPluginStartupMetadata[];
`,
    {
      repoRoot,
      outputPath,
      errorLabel: "official external plugin startup metadata",
    },
  );
  return writeGeneratedOutput({ repoRoot, outputPath, next, check: params?.check });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const check = process.argv.includes("--check");
  const result = await writeOfficialExternalPluginStartupMetadataModule({ check });
  if (!result.changed) {
    process.exitCode = 0;
  } else if (check) {
    console.error(
      `[official-external-plugin-startup-metadata] stale generated output at ${path.relative(process.cwd(), result.outputPath)}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `[official-external-plugin-startup-metadata] wrote ${path.relative(process.cwd(), result.outputPath)}`,
    );
  }
}
