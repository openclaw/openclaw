// Memory Wiki plugin module implements bridge behavior.
import { createHash } from "node:crypto";
import path from "node:path";
import {
  getMemoryCapabilityRegistration,
  listActiveMemoryPublicArtifacts,
  type MemoryPluginPublicArtifact,
} from "openclaw/plugin-sdk/memory-host-core";
import { openFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiConfigForAgent, type ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  createWikiPageFilename,
  renderMarkdownFence,
  renderWikiMarkdown,
  slugifyWikiSegment,
} from "./markdown.js";
import { writeImportedSourcePage } from "./source-page-shared.js";
import {
  assertMemoryWikiSourceSyncStateCapacity,
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";
import { initializeMemoryWikiVault } from "./vault.js";

type BridgeArtifact = {
  syncKey: string;
  artifactType: "markdown" | "memory-events";
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  agentIds: string[];
};

export type BridgeMemoryWikiResult = {
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  removedCount: number;
  artifactCount: number;
  workspaces: number;
  pagePaths: string[];
};

function shouldImportArtifact(
  artifact: MemoryPluginPublicArtifact,
  bridgeConfig: ResolvedMemoryWikiConfig["bridge"],
): boolean {
  switch (artifact.kind) {
    case "memory-root":
      return bridgeConfig.indexMemoryRoot;
    case "daily-note":
      return bridgeConfig.indexDailyNotes;
    case "dream-report":
      return bridgeConfig.indexDreamReports;
    case "event-log":
      return bridgeConfig.followMemoryEvents;
    default:
      return false;
  }
}

function collectBridgeArtifacts(artifacts: MemoryPluginPublicArtifact[]): BridgeArtifact[] {
  const collected: BridgeArtifact[] = [];
  for (const artifact of artifacts) {
    const absolutePath = path.resolve(artifact.workspaceDir, artifact.relativePath);
    const syncKey = absolutePath;
    collected.push({
      syncKey,
      artifactType: artifact.kind === "event-log" ? "memory-events" : "markdown",
      workspaceDir: artifact.workspaceDir,
      relativePath: artifact.relativePath,
      absolutePath,
      agentIds: artifact.agentIds ?? [],
    });
  }
  const deduped = new Map<string, BridgeArtifact>();
  for (const artifact of collected) {
    deduped.set(artifact.syncKey, artifact);
  }
  return [...deduped.values()];
}

function resolveSharedVaultBridgeConfigs(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig: OpenClawConfig;
}): ResolvedMemoryWikiConfig[] {
  const configs = [params.config];
  const vaultPath = path.resolve(params.config.vault.path);
  const knownAgentIds = new Set(params.config.agentId ? [params.config.agentId] : []);
  for (const agent of params.appConfig.agents?.list ?? []) {
    const config = resolveMemoryWikiConfigForAgent(params.appConfig, agent.id);
    const agentId = config.agentId ?? agent.id;
    if (
      knownAgentIds.has(agentId) ||
      path.resolve(config.vault.path) !== vaultPath ||
      config.vaultMode !== "bridge" ||
      !config.bridge.enabled ||
      !config.bridge.readMemoryArtifacts
    ) {
      continue;
    }
    knownAgentIds.add(agentId);
    configs.push(config);
  }
  return configs;
}

function isBridgeArtifactActiveForConfig(
  artifact: MemoryPluginPublicArtifact,
  config: ResolvedMemoryWikiConfig,
): boolean {
  return (
    shouldImportArtifact(artifact, config.bridge) &&
    (!config.agentId || artifact.agentIds.includes(config.agentId))
  );
}

function resolveBridgeTitle(artifact: BridgeArtifact, agentIds: string[]): string {
  if (artifact.artifactType === "memory-events") {
    if (agentIds.length === 0) {
      return "Memory Bridge: event journal";
    }
    return `Memory Bridge (${agentIds.join(", ")}): event journal`;
  }
  const base = artifact.relativePath
    .replace(/\.md$/i, "")
    .replace(/^memory\//, "")
    .replace(/\//g, " / ");
  if (agentIds.length === 0) {
    return `Memory Bridge: ${base}`;
  }
  return `Memory Bridge (${agentIds.join(", ")}): ${base}`;
}

function resolveBridgePagePath(params: { workspaceDir: string; relativePath: string }): {
  pageId: string;
  pagePath: string;
  workspaceSlug: string;
  artifactSlug: string;
} {
  const workspaceBaseSlug = slugifyWikiSegment(path.basename(params.workspaceDir));
  const workspaceHash = createHash("sha1").update(path.resolve(params.workspaceDir)).digest("hex");
  const artifactBaseSlug = slugifyWikiSegment(
    params.relativePath.replace(/\.md$/i, "").replace(/\//g, "-"),
  );
  const artifactHash = createHash("sha1").update(params.relativePath).digest("hex");
  const workspaceSlug = `${workspaceBaseSlug}-${workspaceHash.slice(0, 8)}`;
  const artifactSlug = `${artifactBaseSlug}-${artifactHash.slice(0, 8)}`;
  const fileName = createWikiPageFilename(`bridge-${workspaceSlug}-${artifactSlug}`);
  return {
    pageId: `source.bridge.${workspaceSlug}.${artifactSlug}`,
    pagePath: path.join("sources", fileName).replace(/\\/g, "/"),
    workspaceSlug,
    artifactSlug,
  };
}

async function writeBridgeSourcePage(params: {
  config: ResolvedMemoryWikiConfig;
  artifact: BridgeArtifact;
  sourceContent: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  state: Awaited<ReturnType<typeof readMemoryWikiSourceSyncState>>;
}): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
  const { pageId, pagePath } = resolveBridgePagePath({
    workspaceDir: params.artifact.workspaceDir,
    relativePath: params.artifact.relativePath,
  });
  const title = resolveBridgeTitle(params.artifact, params.artifact.agentIds);
  const renderFingerprint = createHash("sha1")
    .update(
      JSON.stringify({
        artifactType: params.artifact.artifactType,
        workspaceDir: params.artifact.workspaceDir,
        relativePath: params.artifact.relativePath,
        agentIds: params.artifact.agentIds,
      }),
    )
    .digest("hex");
  return writeImportedSourcePage({
    vaultRoot: params.config.vault.path,
    syncKey: params.artifact.syncKey,
    sourcePath: params.artifact.absolutePath,
    sourceContent: params.sourceContent,
    sourceUpdatedAtMs: params.sourceUpdatedAtMs,
    sourceSize: params.sourceSize,
    renderFingerprint,
    pagePath,
    group: "bridge",
    state: params.state,
    buildRendered: (raw, updatedAt) => {
      const contentLanguage =
        params.artifact.artifactType === "memory-events" ? "json" : "markdown";
      return renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: pageId,
          title,
          sourceType:
            params.artifact.artifactType === "memory-events"
              ? "memory-bridge-events"
              : "memory-bridge",
          sourcePath: params.artifact.absolutePath,
          bridgeRelativePath: params.artifact.relativePath,
          bridgeWorkspaceDir: params.artifact.workspaceDir,
          bridgeAgentIds: params.artifact.agentIds,
          status: "active",
          updatedAt,
        },
        body: [
          `# ${title}`,
          "",
          "## Bridge Source",
          `- Workspace: \`${params.artifact.workspaceDir}\``,
          `- Relative path: \`${params.artifact.relativePath}\``,
          `- Kind: \`${params.artifact.artifactType}\``,
          `- Agents: ${params.artifact.agentIds.length > 0 ? params.artifact.agentIds.join(", ") : "unknown"}`,
          `- Updated: ${updatedAt}`,
          "",
          "## Content",
          renderMarkdownFence(raw, contentLanguage),
          "",
          "## Notes",
          "<!-- openclaw:human:start -->",
          "<!-- openclaw:human:end -->",
          "",
        ].join("\n"),
      });
    },
  });
}

export async function syncMemoryWikiBridgeSources(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
}): Promise<BridgeMemoryWikiResult> {
  await initializeMemoryWikiVault(params.config);
  if (
    params.config.vaultMode !== "bridge" ||
    !params.config.bridge.enabled ||
    !params.config.bridge.readMemoryArtifacts ||
    !params.appConfig
  ) {
    return {
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
    };
  }

  const agentId = params.config.agentId;
  const publicArtifacts = await listActiveMemoryPublicArtifacts({
    cfg: params.appConfig,
    ...(agentId ? { agentId } : {}),
  });
  const allPublicArtifacts = agentId
    ? await listActiveMemoryPublicArtifacts({ cfg: params.appConfig })
    : publicArtifacts;
  const scopedArtifacts = agentId
    ? publicArtifacts.filter((artifact) => artifact.agentIds.includes(agentId))
    : publicArtifacts;
  const sharedVaultBridgeConfigs = resolveSharedVaultBridgeConfigs({
    config: params.config,
    appConfig: params.appConfig,
  });
  const results: Array<{ pagePath: string; changed: boolean; created: boolean }> = [];
  const artifacts = collectBridgeArtifacts(
    scopedArtifacts.filter((artifact) => shouldImportArtifact(artifact, params.config.bridge)),
  );
  const activeKeys = new Set(
    collectBridgeArtifacts(
      allPublicArtifacts.filter((artifact) =>
        sharedVaultBridgeConfigs.some((config) =>
          isBridgeArtifactActiveForConfig(artifact, config),
        ),
      ),
    ).map((artifact) => artifact.syncKey),
  );
  const state = await readMemoryWikiSourceSyncState(params.config.vault.path);
  assertMemoryWikiSourceSyncStateCapacity({
    state,
    group: "bridge",
    incomingCount: activeKeys.size,
  });
  const artifactCount = artifacts.length;
  for (const artifact of artifacts) {
    const source = await openFileWithinRoot({
      rootDir: artifact.workspaceDir,
      relativePath: artifact.relativePath,
    });
    try {
      const resolvedArtifact = { ...artifact, absolutePath: source.realPath };
      results.push(
        await writeBridgeSourcePage({
          config: params.config,
          artifact: resolvedArtifact,
          sourceContent: (await source.handle.readFile()).toString("utf8"),
          sourceUpdatedAtMs: source.stat.mtimeMs,
          sourceSize: source.stat.size,
          state,
        }),
      );
    } finally {
      await source.handle.close().catch(() => undefined);
    }
  }
  const workspaceCount = new Set(scopedArtifacts.map((artifact) => artifact.workspaceDir)).size;

  // Skip pruning when memory-core is not loaded (e.g. CLI context) to avoid
  // removing all bridge-imported entries. See #68373.
  const memoryCapability = getMemoryCapabilityRegistration();
  const removedCount = memoryCapability
    ? await pruneImportedSourceEntries({
        vaultRoot: params.config.vault.path,
        group: "bridge",
        activeKeys,
        state,
      })
    : 0;
  await writeMemoryWikiSourceSyncState(params.config.vault.path, state);
  const importedCount = results.filter((result) => result.changed && result.created).length;
  const updatedCount = results.filter((result) => result.changed && !result.created).length;
  const skippedCount = results.filter((result) => !result.changed).length;
  const pagePaths = results
    .map((result) => result.pagePath)
    .toSorted((left, right) => left.localeCompare(right));

  if (importedCount > 0 || updatedCount > 0 || removedCount > 0) {
    await appendMemoryWikiLog(params.config.vault.path, {
      type: "ingest",
      timestamp: new Date().toISOString(),
      details: {
        sourceType: "memory-bridge",
        workspaces: workspaceCount,
        artifactCount,
        importedCount,
        updatedCount,
        skippedCount,
        removedCount,
      },
    });
  }

  return {
    importedCount,
    updatedCount,
    skippedCount,
    removedCount,
    artifactCount,
    workspaces: workspaceCount,
    pagePaths,
  };
}
