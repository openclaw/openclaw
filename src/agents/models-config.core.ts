/**
 * Ensures agent-local models.json and the SQLite-backed plugin model catalog
 * match runtime config, discovered providers, auth-profile state, and
 * generated catalog ownership.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import type { CapturedRuntimeConfigRead } from "../config/runtime-config-capture-state.js";
import {
  getRuntimeConfigSourceSnapshot,
  hashRuntimeConfigValue,
} from "../config/runtime-snapshot.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { privateFileStore } from "../infra/private-file-store.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import type { PreparedProviderStaticCatalog } from "../plugins/provider-discovery.js";
import {
  resolveAgentWorkspaceDir,
  resolveAmbientOwnerAgentId,
  resolveDefaultAgentDir,
} from "./agent-scope.js";
import { resolveAuthProfileDatabasePath } from "./auth-profiles/sqlite.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { MODELS_JSON_STATE, publishModelsJsonCostSource } from "./models-config-state.js";
import { planOpenClawModelsJson, type PreparedModelsConfigContext } from "./models-config.plan.js";
import {
  capturePluginModelCatalogAuth,
  withPluginModelCatalogAuthObservations,
} from "./plugin-model-catalog-auth.js";
import { loadPersistedPluginModelCatalogs } from "./plugin-model-catalog-execution.js";
import { repairPluginModelCatalogTransportMetadata } from "./plugin-model-catalog-repair.js";
import {
  decodePluginModelCatalogRelativePathPluginId,
  replacePersistedPluginModelCatalogs,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.js";

type ModelsConfigInput = OpenClawConfig | (() => Promise<CapturedRuntimeConfigRead>);

type EnsureOpenClawModelsJsonOptions = {
  env?: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  workspaceDir?: string;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
  onProviderCatalogOutcome?: (outcome: ProviderCatalogOutcome) => void;
};

type PlanOpenClawModelsJsonSourceOptions = EnsureOpenClawModelsJsonOptions & {
  authStore?: AuthProfileStore;
};

type PlannedOpenClawModelsJsonSource = Readonly<{
  agentDir: string;
  modelsJsonContents: string | null;
  pluginCatalogs: readonly PersistedPluginModelCatalog[];
}>;

const MODELS_JSON_READY_CACHE_LIMIT = 128;

async function readFileMtimeMs(pathname: string): Promise<number | null> {
  try {
    const stat = await fs.stat(pathname);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

async function buildModelsJsonFingerprint(
  context: PreparedModelsConfigContext,
  publishedCatalogs?: readonly PersistedPluginModelCatalog[],
): Promise<string> {
  const authProfilesSqlitePath = resolveAuthProfileDatabasePath(context.agentDir);
  const authProfilesMtimeMs = await readFileMtimeMs(authProfilesSqlitePath);
  const authProfilesWalMtimeMs = await readFileMtimeMs(`${authProfilesSqlitePath}-wal`);
  const modelsFileMtimeMs = await readFileMtimeMs(path.join(context.agentDir, "models.json"));
  const pluginCatalogFingerprint = createHash("sha256")
    .update(
      stableStringify(
        publishedCatalogs ??
          (await loadPersistedPluginModelCatalogs(context.agentDir, undefined, context.env)),
      ),
    )
    .digest("base64url");
  const pluginMetadataSnapshotIndexFingerprint = context.pluginMetadataSnapshot
    ? resolveInstalledManifestRegistryIndexFingerprint(context.pluginMetadataSnapshot.index)
    : undefined;
  return stableStringify({
    config: context.cfg,
    discoveryAuthConfigHash: hashRuntimeConfigValue(context.discoveryAuthConfig),
    sourceConfigForSecrets: context.sourceConfigForSecrets,
    envShape: context.envFingerprint,
    authProfilesMtimeMs,
    authProfilesWalMtimeMs,
    modelsFileMtimeMs,
    pluginCatalogFingerprint,
    workspaceDir: context.workspaceDir,
    pluginMetadataSnapshotIndexFingerprint,
    pluginMetadataSnapshotPluginIds:
      context.pluginMetadataSnapshot?.pluginIds === undefined
        ? null
        : context.pluginMetadataSnapshot.pluginIds.toSorted(),
    providerDiscoveryProviderIds: context.providerDiscoveryProviderIds,
    providerDiscoveryTimeoutMs: context.providerDiscoveryTimeoutMs,
    providerDiscoveryEntriesOnly: context.providerDiscoveryEntriesOnly === true,
  });
}

function modelsJsonReadyCacheKey(targetPath: string, fingerprint: string): string {
  // Keep the full identity without retaining serialized configurations and env values.
  return createHash("sha256")
    .update(targetPath)
    .update("\0")
    .update(fingerprint)
    .digest("base64url");
}

async function readExistingModelsFile(pathname: string): Promise<{
  raw: string;
  parsed: unknown;
}> {
  const raw = await privateFileStore(path.dirname(pathname)).readTextIfExists(
    path.basename(pathname),
  );
  try {
    return {
      raw: raw ?? "",
      parsed: raw === null ? null : (JSON.parse(raw) as unknown),
    };
  } catch {
    // Malformed JSON cannot supply usable providers; rebuild it from config.
    return {
      raw: "",
      parsed: null,
    };
  }
}

/** Best-effort chmod for the user-visible generated models.json file. */
async function ensureModelsFileModeForModelsJson(pathname: string): Promise<void> {
  await fs.chmod(pathname, 0o600).catch(() => {});
}

function materializePlannedPluginCatalogs(
  pluginCatalogWrites: Readonly<Record<string, string>>,
): PersistedPluginModelCatalog[] {
  return Object.entries(pluginCatalogWrites)
    .map(([relativePath, contents]) => {
      const pluginId = decodePluginModelCatalogRelativePathPluginId(relativePath);
      if (!pluginId) {
        throw new Error(`Invalid generated plugin model catalog key: ${relativePath}`);
      }
      return {
        pluginId,
        contents: repairPluginModelCatalogTransportMetadata(contents).contents,
      };
    })
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function resolveModelsConfigInput(config: OpenClawConfig): {
  config: OpenClawConfig;
  discoveryAuthConfig: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
} {
  const runtimeSource = getRuntimeConfigSourceSnapshot();
  const projected = runtimeSource ? projectConfigOntoRuntimeSourceSnapshot(config) : config;
  return {
    config: projected,
    discoveryAuthConfig: config,
    // If projection is skipped (for example incompatible top-level shape),
    // keep managed secret persistence anchored to the active source snapshot.
    sourceConfigForSecrets: projected === config ? (runtimeSource ?? config) : projected,
  };
}

async function prepareModelsConfigContext(
  config: ModelsConfigInput,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions = {},
): Promise<PreparedModelsConfigContext> {
  let ambientEnv = process.env;
  let resolved: ReturnType<typeof resolveModelsConfigInput>;
  if (typeof config !== "function") {
    resolved = resolveModelsConfigInput(config);
  } else {
    const captured = await config();
    ambientEnv = captured.env;
    const source = projectConfigOntoRuntimeSourceSnapshot(captured.config);
    resolved = {
      config: source,
      discoveryAuthConfig: captured.config,
      sourceConfigForSecrets: source,
    };
  }
  const cfg = resolved.config;
  const agentDir = agentDirOverride?.trim()
    ? agentDirOverride.trim()
    : resolveDefaultAgentDir(cfg, ambientEnv);
  const workspaceDir =
    options.workspaceDir ??
    (agentDirOverride?.trim()
      ? undefined
      : // Same ambient owner resolveDefaultAgentDir just used for agentDir; resolving it
        // on the deprecated chain here rejected explicit fleets owned by a system agent.
        resolveAgentWorkspaceDir(cfg, resolveAmbientOwnerAgentId(cfg), ambientEnv));
  const fingerprintEnv = createConfigRuntimeEnv(cfg, options.env ?? {});
  const env = options.env ? fingerprintEnv : createConfigRuntimeEnv(cfg, ambientEnv);
  const providerScopedDiscovery = Boolean(options.providerDiscoveryProviderIds?.length);
  const pluginMetadataSnapshot =
    options.pluginMetadataSnapshot ??
    resolvePluginMetadataSnapshot({
      config: cfg,
      env,
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(providerScopedDiscovery ? { preferPersisted: false } : {}),
    });
  return {
    cfg,
    discoveryAuthConfig: resolved.discoveryAuthConfig,
    // Native readiness belongs to the captured auth inputs, not the catalog's env clone.
    discoveryAuthEnv: options.env ?? ambientEnv,
    sourceConfigForSecrets: resolved.sourceConfigForSecrets,
    agentDir,
    env,
    envFingerprint: options.env ? hashRuntimeConfigValue(fingerprintEnv) : fingerprintEnv,
    workspaceDir: workspaceDir || undefined,
    pluginMetadataSnapshot,
    preparedStaticProviderCatalog: options.preparedStaticProviderCatalog,
    providerDiscoveryProviderIds: options.providerDiscoveryProviderIds,
    providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs,
    providerDiscoveryEntriesOnly: options.providerDiscoveryEntriesOnly === true,
    onProviderCatalogOutcome: options.onProviderCatalogOutcome,
  };
}

/** Ensures models.json and the agent SQLite catalog cache are current. */
export async function ensureOpenClawModelsJsonWithInput(
  config: ModelsConfigInput,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions = {},
): Promise<{ publishedSource?: Omit<PlannedOpenClawModelsJsonSource, "agentDir"> }> {
  const context = await prepareModelsConfigContext(config, agentDirOverride, options);
  const { agentDir } = context;
  const targetPath = path.join(agentDir, "models.json");
  const readyCache = MODELS_JSON_STATE.readyCache;
  // In-place updates retain the shared Map. Old full-string keys cannot match
  // compact keys, so release them even when live refreshes bypass cache admission.
  for (const key of readyCache.keys()) {
    if (key.includes("\0")) {
      readyCache.delete(key);
    }
  }
  pruneMapToMaxSize(readyCache, MODELS_JSON_READY_CACHE_LIMIT);
  // Live refreshes need their own outcomes, so they cannot consume readiness hits.
  // Do not fingerprint or retain those configurations for a cache they bypass.
  const cacheKey = context.onProviderCatalogOutcome
    ? undefined
    : modelsJsonReadyCacheKey(targetPath, await buildModelsJsonFingerprint(context));
  if (cacheKey) {
    const cached = readyCache.get(cacheKey);
    if (cached) {
      readyCache.delete(cacheKey);
      readyCache.set(cacheKey, cached);
      await cached;
      await ensureModelsFileModeForModelsJson(targetPath);
      return {};
    }
  }

  // Keep publication payloads local; ready-cache promises retain only completion.
  let publishedSource: Omit<PlannedOpenClawModelsJsonSource, "agentDir"> | undefined;
  const pending = MODELS_JSON_STATE.writeQueue.enqueue(targetPath, async () => {
    const existingModelsFile = await readExistingModelsFile(targetPath);
    const authSnapshot = await capturePluginModelCatalogAuth(agentDir, context.env);
    const plan = await withPluginModelCatalogAuthObservations(authSnapshot, async () =>
      planOpenClawModelsJson({
        context,
        existingRaw: existingModelsFile.raw,
        existingParsed: existingModelsFile.parsed,
        pluginCatalogs: await loadPersistedPluginModelCatalogs(agentDir, undefined, context.env),
      }),
    );

    if (plan.action === "write") {
      await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
      if (existingModelsFile.raw !== plan.contents) {
        await privateFileStore(path.dirname(targetPath)).writeText("models.json", plan.contents);
      }
    }
    publishModelsJsonCostSource(
      agentDir,
      plan.action === "write" ? plan.contents : existingModelsFile.raw || null,
    );
    if (plan.action === "write") {
      await ensureModelsFileModeForModelsJson(targetPath);
    }
    const publication = plan.pluginCatalogWrites
      ? await replacePersistedPluginModelCatalogs({
          agentDir,
          pluginCatalogWrites: plan.pluginCatalogWrites,
          authSnapshot,
          env: context.env,
        })
      : undefined;
    if (publication) {
      publishedSource = {
        modelsJsonContents:
          plan.action === "write" ? plan.contents : existingModelsFile.raw || null,
        pluginCatalogs: publication.catalogs,
      };
    }
    if (plan.action === "noop") {
      await ensureModelsFileModeForModelsJson(targetPath);
    }
  });
  if (cacheKey) {
    readyCache.set(cacheKey, pending);
    // Keep alternating configurations warm without retaining every past generation.
    // Evicted pending work still finishes through the directory's write queue.
    pruneMapToMaxSize(readyCache, MODELS_JSON_READY_CACHE_LIMIT);
  }
  try {
    await pending;
    if (cacheKey && readyCache.get(cacheKey) === pending) {
      const refreshedFingerprint = await buildModelsJsonFingerprint(
        context,
        publishedSource?.pluginCatalogs,
      );
      const refreshedCacheKey = modelsJsonReadyCacheKey(targetPath, refreshedFingerprint);
      // Fingerprinting yields: an evicted request must not replace a newer waiter.
      if (readyCache.get(cacheKey) === pending && refreshedCacheKey !== cacheKey) {
        readyCache.delete(cacheKey);
        if (!readyCache.has(refreshedCacheKey)) {
          readyCache.set(refreshedCacheKey, Promise.resolve());
          pruneMapToMaxSize(readyCache, MODELS_JSON_READY_CACHE_LIMIT);
        }
      }
    }
    return publishedSource ? { publishedSource } : {};
  } catch (error) {
    if (cacheKey && readyCache.get(cacheKey) === pending) {
      readyCache.delete(cacheKey);
    }
    throw error;
  }
}

/**
 * Plans the complete root/plugin catalog generation without mutating agent-owned state.
 * Control-plane inventory reads use this when their lifecycle generation may be superseded.
 */
export async function planOpenClawModelsJsonSourceWithInput(
  config: ModelsConfigInput,
  agentDirOverride?: string,
  options: PlanOpenClawModelsJsonSourceOptions = {},
): Promise<PlannedOpenClawModelsJsonSource> {
  const { authStore } = options;
  const context = await prepareModelsConfigContext(config, agentDirOverride, options);
  const { agentDir } = context;
  const existingModelsFile = await readExistingModelsFile(path.join(agentDir, "models.json"));
  const existingPluginCatalogs = await loadPersistedPluginModelCatalogs(
    agentDir,
    undefined,
    context.env,
  );
  const plan = await planOpenClawModelsJson({
    context,
    ...(authStore ? { authStore } : {}),
    existingRaw: existingModelsFile.raw,
    existingParsed: existingModelsFile.parsed,
    pluginCatalogs: existingPluginCatalogs,
  });
  return {
    agentDir,
    modelsJsonContents: plan.action === "write" ? plan.contents : existingModelsFile.raw || null,
    // Planned writes share the writer's complete-replacement contract, including intentional
    // stale-catalog deletion. Only a non-authoritative plan omits this field.
    pluginCatalogs:
      plan.pluginCatalogWrites === undefined
        ? existingPluginCatalogs
        : materializePlannedPluginCatalogs(plan.pluginCatalogWrites),
  };
}
