import path from "node:path";
import {
  listAgentIds,
  resolveSessionAgentIdsStrict,
} from "openclaw/plugin-sdk/agent-scope-runtime";
import { canonicalPathFromExistingAncestor } from "openclaw/plugin-sdk/file-access-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type {
  PluginDoctorStateMigration,
  Utf8InputError,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  readLegacySessionIndex,
  resolveLegacySessionFileLocator,
} from "./session-binding-legacy-index.js";

type MigrationEnvironment = Pick<
  Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0],
  "config" | "env"
>;

export type LegacyBindingOwner = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  transcriptPath: string;
  lifecycleRevision?: string;
  agentHarnessId?: string;
  updatedAt?: number;
};

type BindingOwnerCollection = {
  owners: Map<string, LegacyBindingOwner[]>;
  failures: Array<string | Utf8InputError>;
};

export async function collectBindingOwners(
  sources: ReadonlyArray<{ transcriptPath: string }>,
  surfaces: ReadonlyArray<{ storePaths: ReadonlySet<string>; agentIds: ReadonlySet<string> }>,
  params: MigrationEnvironment,
): Promise<BindingOwnerCollection> {
  const sourcePaths = new Set(
    await Promise.all(
      sources.map((source) => canonicalPathFromExistingAncestor(source.transcriptPath)),
    ),
  );
  const owners = new Map<string, Map<string, LegacyBindingOwner>>();
  const storeAgentIds = new Map<string, Set<string>>();
  for (const surface of surfaces) {
    for (const storePath of surface.storePaths) {
      const agents = storeAgentIds.get(storePath) ?? new Set<string>();
      for (const agentId of surface.agentIds) {
        agents.add(agentId);
      }
      storeAgentIds.set(storePath, agents);
    }
  }
  const failures: BindingOwnerCollection["failures"] = [];
  for (const [storePath, agentIds] of storeAgentIds) {
    const canonicalStorePath = await canonicalPathFromExistingAncestor(storePath);
    const index = await readLegacySessionIndex(storePath);
    if ("failure" in index) {
      failures.push(index.failure);
      continue;
    }
    const sessionsDir = path.dirname(storePath);
    for (const { sessionKey, entry } of index.entries) {
      const sessionId = entry.sessionId;
      const agentId = tryResolveLegacyBindingOwnerAgentId({
        sessionKey,
        config: params.config,
        storeAgentIds: agentIds,
      });
      if (!agentId) {
        failures.push(`session index ${storePath} has an ambiguous owner for ${sessionKey}`);
        continue;
      }
      let legacyTranscriptPath: string;
      let canonicalLegacyTranscriptPath: string;
      try {
        legacyTranscriptPath = await resolveLegacySessionFileLocator(sessionsDir, entry, sessionId);
        canonicalLegacyTranscriptPath =
          await canonicalPathFromExistingAncestor(legacyTranscriptPath);
      } catch {
        failures.push(`session index ${storePath} has an invalid locator for ${sessionKey}`);
        continue;
      }
      if (!sourcePaths.has(canonicalLegacyTranscriptPath)) {
        continue;
      }
      const owner: LegacyBindingOwner = {
        agentId,
        sessionId,
        sessionKey,
        storePath,
        transcriptPath: legacyTranscriptPath,
        ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
        agentHarnessId: entry.agentHarnessId?.trim(),
        ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
      };
      const candidates =
        owners.get(canonicalLegacyTranscriptPath) ?? new Map<string, LegacyBindingOwner>();
      const ownerKey = `${agentId}\0${sessionId}\0${sessionKey}\0${canonicalStorePath}`;
      const configuredStorePath = resolveStorePath(params.config.session?.store, {
        agentId,
        env: params.env,
      });
      // The same physical store can appear through a configured symlink and a
      // discovered real path. Mutate through the path the runtime itself owns.
      if (!candidates.has(ownerKey) || storePath === configuredStorePath) {
        candidates.set(ownerKey, owner);
      }
      owners.set(canonicalLegacyTranscriptPath, candidates);
    }
  }
  return {
    owners: new Map([...owners].map(([key, values]) => [key, [...values.values()]])),
    failures,
  };
}

export function tryResolveLegacyBindingOwnerAgentId(params: {
  sessionKey: string;
  config: MigrationEnvironment["config"];
  storeAgentIds?: Set<string>;
}): string | undefined {
  if (params.sessionKey.trim().toLowerCase().startsWith("agent:")) {
    return resolveSessionAgentIdsStrict({
      sessionKey: params.sessionKey,
      config: params.config,
    }).sessionAgentId;
  }
  const storeAgentId = params.storeAgentIds?.size === 1 ? [...params.storeAgentIds][0] : undefined;
  const configuredAgentId = params.config.agents?.defaults?.systemAgent?.agentId?.trim();
  const systemAgentId =
    !storeAgentId && configuredAgentId ? normalizeAgentId(configuredAgentId) : undefined;
  const fallbackAgentIds =
    systemAgentId && listAgentIds(params.config).includes(systemAgentId)
      ? [undefined, systemAgentId]
      : [undefined];
  for (const fallbackAgentId of fallbackAgentIds) {
    try {
      return resolveSessionAgentIdsStrict({
        sessionKey: params.sessionKey,
        config: params.config,
        ...(storeAgentId ? { agentId: storeAgentId } : fallbackAgentId ? { fallbackAgentId } : {}),
      }).sessionAgentId;
    } catch (error) {
      if (!isRecord(error) || error.code !== "AGENT_SELECTION_REQUIRED") {
        throw error;
      }
    }
  }
  return undefined;
}
