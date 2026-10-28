import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readAcpResumeSessionOwner } from "./session-meta-resume.js";

type AcpResumeSessionOwnership = {
  cfg: OpenClawConfig;
  ownerAgentId: string;
  runtimeAgentId: string;
  backendId?: string;
  requesterSessionKey?: string;
  resumeSessionId?: string;
  assertCurrent?: () => void;
};

export async function withAcpResumeSessionAuthorization<T>(
  ownership: AcpResumeSessionOwnership,
  initialize: (revalidateResume?: () => Promise<() => void>) => Promise<T>,
): Promise<T> {
  if (!normalizeOptionalString(ownership.resumeSessionId)) {
    return initialize();
  }
  let current = true;
  const sources = new Map<string, Set<string>>();
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if (
      "sessionKey" in change &&
      !change.factsInvalidated &&
      (change.facts?.kind === "unchanged" ||
        change.facts?.kind === "participants" ||
        change.facts?.kind === "category")
    ) {
      return;
    }
    if (
      "all" in change ||
      (sources.has(change.sessionKey) &&
        (!change.agentId || sources.get(change.sessionKey)?.has(change.agentId)))
    ) {
      current = false;
    }
  });
  const assertCurrent = () => {
    ownership.assertCurrent?.();
    if (!current) {
      throw new Error("ACP resume source authority changed; retry from the current session.");
    }
  };
  try {
    return await initialize(async () => {
      assertCurrent();
      const result = await validateAcpResumeSessionOwnership(
        { ...ownership, assertCurrent },
        (agentId, sessionKey) => {
          const agents = sources.get(sessionKey) ?? new Set<string>();
          agents.add(agentId);
          sources.set(sessionKey, agents);
        },
      );
      if (!result.ok) {
        throw new Error(result.error);
      }
      return assertCurrent;
    });
  } finally {
    current = false;
    unsubscribe();
  }
}

export async function validateAcpResumeSessionOwnership(
  params: AcpResumeSessionOwnership,
  observeSource?: (agentId: string, sessionKey: string) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const resumeSessionId = normalizeOptionalString(params.resumeSessionId);
  if (!resumeSessionId) {
    return { ok: true };
  }
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  if (!requesterSessionKey) {
    return {
      ok: false,
      error: "sessions_spawn resumeSessionId requires an active requester session context.",
    };
  }

  // Released spawns stored canonical rows under the harness. Read that owner until Doctor migrates it.
  for (const agentId of new Set([params.ownerAgentId, params.runtimeAgentId])) {
    const owner = await readAcpResumeSessionOwner({
      ...params,
      agentId,
      resumeSessionId,
      onCandidate: (sessionKey) => observeSource?.(agentId, sessionKey),
    });
    params.assertCurrent?.();
    if (!owner) {
      continue;
    }
    if (
      owner.sessionKey === requesterSessionKey ||
      normalizeOptionalString(owner.entry.spawnedBy) === requesterSessionKey ||
      normalizeOptionalString(owner.entry.parentSessionKey) === requesterSessionKey
    ) {
      return { ok: true };
    }
    break;
  }
  return {
    ok: false,
    error:
      "sessions_spawn resumeSessionId is only allowed for ACP sessions previously recorded for this requester. Omit resumeSessionId to start a fresh ACP session.",
  };
}
