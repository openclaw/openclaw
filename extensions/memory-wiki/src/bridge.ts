import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import {
  getMemoryCapabilityRegistration,
  listActiveMemoryPublicArtifacts,
  type MemoryPluginPublicArtifact,
} from "openclaw/plugin-sdk/memory-host-core";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "../api.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { createWikiPageFilename, slugifyWikiSegment } from "./markdown.js";
import {
  emptySourceImportResult,
  syncImportedSourcePages,
  type BridgeMemoryWikiResult,
} from "./source-import.js";
import { renderImportedSourcePage, writeImportedSourcePage } from "./source-page-shared.js";
import { resolveArtifactKey } from "./source-path-shared.js";
import { assertMemoryWikiSourceSyncStateCapacity } from "./source-sync-state.js";

type BridgeArtifact = {
  syncKey: string;
  artifactType: "markdown" | "memory-events";
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
};

export function resolveMemoryWikiVaultAgentId(
  config: Pick<ResolvedMemoryWikiConfig, "agentId" | "vault">,
): string | null {
  if (config.vault.scope === "global") {
    return null;
  }
  const agentId = config.agentId?.trim();
  if (!agentId) {
    throw new Error("Memory Wiki agent-scoped vault requires a resolved agent id");
  }
  return normalizeAgentId(agentId);
}

export function filterMemoryWikiBridgeArtifacts(params: {
  config: Pick<ResolvedMemoryWikiConfig, "agentId" | "vault">;
  artifacts: MemoryPluginPublicArtifact[];
  callerAgentId?: string;
}): MemoryPluginPublicArtifact[] {
  const vaultAgentId = resolveMemoryWikiVaultAgentId(params.config);
  const callerAgentId = params.callerAgentId?.trim();
  // Agent-scoped vault ownership is authoritative. Global vaults remain shared,
  // but agent tools still scope diagnostic metadata to their calling agent.
  const agentId = vaultAgentId ?? (callerAgentId ? normalizeAgentId(callerAgentId) : null);
  if (!agentId) {
    return params.artifacts;
  }
  // Ownership metadata is mandatory only in agent scope. Global scope keeps
  // accepting legacy providers that omit agentIds.
  return params.artifacts.filter((artifact) => {
    const artifactAgentIds = Array.isArray(artifact.agentIds) ? artifact.agentIds : [];
    return artifactAgentIds.some(
      (artifactAgentId) =>
        typeof artifactAgentId === "string" &&
        artifactAgentId.trim().length > 0 &&
        normalizeAgentId(artifactAgentId) === agentId,
    );
  });
}

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

async function collectBridgeArtifacts(
  bridgeConfig: ResolvedMemoryWikiConfig["bridge"],
  vaultRoot: string,
  artifacts: MemoryPluginPublicArtifact[],
): Promise<BridgeArtifact[]> {
  const collected = new Map<string, BridgeArtifact>();
  const vaultRootKey = await resolveArtifactKey(vaultRoot);
  for (const artifact of artifacts) {
    if (!shouldImportArtifact(artifact, bridgeConfig)) {
      continue;
    }
    const syncKey = await resolveArtifactKey(artifact.absolutePath);
    if (isPathInside(vaultRootKey, syncKey)) {
      continue;
    }
    collected.set(syncKey, {
      syncKey,
      artifactType: artifact.kind === "event-log" ? "memory-events" : "markdown",
      workspaceDir: artifact.workspaceDir,
      relativePath: artifact.relativePath,
      absolutePath: artifact.absolutePath,
    });
  }
  return [...collected.values()];
}

function resolveBridgeTitle(artifact: BridgeArtifact, agentIds: string[]): string {
  const base =
    artifact.artifactType === "memory-events"
      ? "event journal"
      : artifact.relativePath
          .replace(/\.md$/i, "")
          .replace(/^memory\//, "")
          .replace(/\//g, " / ");
  const agentSuffix = agentIds.length > 0 ? ` (${agentIds.join(", ")})` : "";
  return `Memory Bridge${agentSuffix}: ${base}`;
}

function resolveBridgePagePath(params: { workspaceDir: string; relativePath: string }): {
  pageId: string;
  pagePath: string;
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
  };
}

export async function syncMemoryWikiBridgeSources(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<BridgeMemoryWikiResult> {
  resolveMemoryWikiVaultAgentId(params.config);
  if (
    params.config.vaultMode !== "bridge" ||
    !params.config.bridge.enabled ||
    !params.config.bridge.readMemoryArtifacts ||
    !params.appConfig
  ) {
    return emptySourceImportResult();
  }

  // Filter before building active keys so each vault's pruning state tracks
  // only artifacts that are visible to its resolved agent.
  const publicArtifacts = filterMemoryWikiBridgeArtifacts({
    config: params.config,
    artifacts: await listActiveMemoryPublicArtifacts({ cfg: params.appConfig }),
  });
  const artifacts = await collectBridgeArtifacts(
    params.config.bridge,
    params.config.vault.path,
    publicArtifacts,
  );
  const workspaces = new Set(publicArtifacts.map((artifact) => artifact.workspaceDir)).size;
  return await syncImportedSourcePages({
    config: params.config,
    group: "bridge",
    signal: params.signal,
    writeSources: async ({ state, prepareWrite }) => {
      assertMemoryWikiSourceSyncStateCapacity({
        state,
        group: "bridge",
        incomingCount: artifacts.length,
      });
      const agentIdsByWorkspace = new Map<string, string[]>();
      for (const artifact of publicArtifacts) {
        agentIdsByWorkspace.set(artifact.workspaceDir, artifact.agentIds);
      }
      const results: Array<{ pagePath: string; changed: boolean; created: boolean }> = [];
      const activeKeys = new Set<string>();
      for (const artifact of artifacts) {
        const stats = await fs.stat(artifact.absolutePath);
        activeKeys.add(artifact.syncKey);
        const agentIds = agentIdsByWorkspace.get(artifact.workspaceDir) ?? [];
        const { pageId, pagePath } = resolveBridgePagePath({
          workspaceDir: artifact.workspaceDir,
          relativePath: artifact.relativePath,
        });
        const title = resolveBridgeTitle(artifact, agentIds);
        const renderFingerprint = createHash("sha1")
          .update(
            JSON.stringify({
              artifactType: artifact.artifactType,
              workspaceDir: artifact.workspaceDir,
              relativePath: artifact.relativePath,
              agentIds,
            }),
          )
          .digest("hex");
        results.push(
          await writeImportedSourcePage({
            vaultRoot: params.config.vault.path,
            syncKey: artifact.syncKey,
            sourcePath: artifact.absolutePath,
            sourceUpdatedAtMs: stats.mtimeMs,
            sourceSize: stats.size,
            renderFingerprint,
            pagePath,
            group: "bridge",
            state,
            prepareWrite,
            buildRendered: (raw, updatedAt) => {
              const contentLanguage =
                artifact.artifactType === "memory-events" ? "json" : "markdown";
              return renderImportedSourcePage({
                frontmatter: {
                  pageType: "source",
                  id: pageId,
                  title,
                  sourceType:
                    artifact.artifactType === "memory-events"
                      ? "memory-bridge-events"
                      : "memory-bridge",
                  sourcePath: artifact.absolutePath,
                  bridgeRelativePath: artifact.relativePath,
                  bridgeWorkspaceDir: artifact.workspaceDir,
                  bridgeAgentIds: agentIds,
                  status: "active",
                  updatedAt,
                },
                sourceHeading: "Bridge Source",
                sourceDetails: [
                  `- Workspace: \`${artifact.workspaceDir}\``,
                  `- Relative path: \`${artifact.relativePath}\``,
                  `- Kind: \`${artifact.artifactType}\``,
                  `- Agents: ${agentIds.length > 0 ? agentIds.join(", ") : "unknown"}`,
                  `- Updated: ${updatedAt}`,
                ],
                content: raw,
                language: contentLanguage,
              });
            },
          }),
        );
      }
      return {
        results,
        activeKeys,
        artifactCount: artifacts.length,
        workspaces,
      };
    },
    // CLI imports can lack the memory capability; absence cannot authorize pruning. See #68373.
    canPrune: () => Boolean(getMemoryCapabilityRegistration()),
    logDetails: { workspaces },
  });
}
