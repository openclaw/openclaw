import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";

type MigrationParams = Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0];
const CODEX_AGENT_HARNESS_ID = "codex";

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

export async function recordSessionOwner(
  owner: LegacyBindingOwner,
  env: NodeJS.ProcessEnv,
  options: {
    canCreateOwner: boolean;
    readEvidence: MigrationParams["context"]["readSessionIdentityEvidenceBatch"];
  },
): Promise<string | { deleted: true } | undefined> {
  const { prepareSessionEntryPatch } = await import("openclaw/plugin-sdk/session-store-runtime");
  // Legacy indexes are offline inputs; only the canonical session can change ownership now.
  let ownershipRefusal: string | undefined;
  let observedCanonicalEntry = false;
  const updated = await prepareSessionEntryPatch({
    agentId: owner.agentId,
    env,
    ...(options.canCreateOwner
      ? {
          fallbackEntry: {
            sessionId: owner.sessionId,
            updatedAt: owner.updatedAt ?? 0,
            ...(owner.lifecycleRevision ? { lifecycleRevision: owner.lifecycleRevision } : {}),
          },
        }
      : {}),
    preserveActivity: true,
    requireWriteSuccess: true,
    skipMaintenance: true,
    storePath: owner.storePath,
    sessionKey: owner.sessionKey,
    prepare: (entry, { existingEntry }) => {
      observedCanonicalEntry = existingEntry !== undefined;
      if (
        entry.sessionId.trim() !== owner.sessionId ||
        entry.lifecycleRevision !== owner.lifecycleRevision
      ) {
        ownershipRefusal = "its session owner changed before Codex ownership could be recorded";
        return null;
      }
      const harnessId =
        typeof entry.agentHarnessId === "string" ? entry.agentHarnessId.trim() : undefined;
      if (entry.agentHarnessId !== undefined && !harnessId) {
        ownershipRefusal = "Codex harness ownership could not be recorded on its session";
        return null;
      }
      if (harnessId && harnessId !== CODEX_AGENT_HARNESS_ID) {
        ownershipRefusal = `its session is owned by agent harness ${harnessId}`;
        return null;
      }
      return { agentHarnessId: CODEX_AGENT_HARNESS_ID };
    },
  });
  // A declined patch can return the unchanged row, not only null.
  if (!updated || ownershipRefusal) {
    if (!options.canCreateOwner && !observedCanonicalEntry && options.readEvidence) {
      const current = (
        await options.readEvidence([{ agentId: owner.agentId, sessionId: owner.sessionId }])
      )[0];
      if (current?.state === "absent") {
        return { deleted: true };
      }
    }
    return ownershipRefusal ?? "its session owner changed before Codex ownership could be recorded";
  }
  return undefined;
}
