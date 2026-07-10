// Memory Core plugin module implements session search visibility behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { resolveSessionAgentId } from "openclaw/plugin-sdk/memory-host-core";
import {
  extractTranscriptIdentityFromSessionsMemoryHit,
  loadCombinedSessionStoreForGateway,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
  resolveTranscriptStemToSessionKeys,
} from "openclaw/plugin-sdk/session-transcript-hit";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
} from "openclaw/plugin-sdk/session-visibility";
import { readQmdSessionArtifactIdentity } from "./qmd-session-artifacts.js";

function normalizeAgentIdForCompare(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase() || undefined;
}

function isGlobalSessionKeyForSharedScope(cfg: OpenClawConfig, key: string): boolean {
  return cfg.session?.scope === "global" && key.trim().toLowerCase() === "global";
}

function filterSessionKeysByScopedAgent(params: {
  cfg: OpenClawConfig;
  keys: string[];
  scopedAgentId: string | undefined;
}): string[] {
  const scopedAgentId = normalizeAgentIdForCompare(params.scopedAgentId);
  if (!scopedAgentId) {
    return params.keys;
  }
  return params.keys.filter((key) => {
    if (isGlobalSessionKeyForSharedScope(params.cfg, key)) {
      return true;
    }
    const ownerAgentId = resolveSessionAgentId({
      sessionKey: key,
      config: params.cfg,
    });
    return normalizeAgentIdForCompare(ownerAgentId) === scopedAgentId;
  });
}

export async function filterMemorySearchHitsBySessionVisibility(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  requesterSessionKey: string | undefined;
  sandboxed: boolean;
  hits: MemorySearchResult[];
}): Promise<MemorySearchResult[]> {
  const visibility = resolveEffectiveSessionToolsVisibility({
    cfg: params.cfg,
    sandboxed: params.sandboxed,
  });
  const a2aPolicy = createAgentToAgentPolicy(params.cfg);
  const requesterAgentId = params.requesterSessionKey
    ? resolveSessionAgentId({
        sessionKey: params.requesterSessionKey,
        config: params.cfg,
      })
    : undefined;
  const scopedAgentId = params.agentId?.trim() || requesterAgentId;
  const guard = params.requesterSessionKey
    ? await createSessionVisibilityGuard({
        action: "history",
        requesterSessionKey: params.requesterSessionKey,
        visibility,
        a2aPolicy,
      })
    : null;

  const { store: combinedSessionStore } = loadCombinedSessionStoreForGateway(
    params.cfg,
    scopedAgentId ? { agentId: scopedAgentId } : {},
  );

  const next: MemorySearchResult[] = [];
  for (const hit of params.hits) {
    if (hit.source !== "sessions") {
      next.push(hit);
      continue;
    }
    if (!params.requesterSessionKey || !guard) {
      continue;
    }
    const artifactIdentity = readQmdSessionArtifactIdentity(hit);
    if (artifactIdentity) {
      const normalizedScopedAgentId = normalizeAgentIdForCompare(scopedAgentId);
      const normalizedOwnerAgentId = normalizeAgentIdForCompare(artifactIdentity.agentId);
      if (
        normalizedScopedAgentId &&
        normalizedOwnerAgentId &&
        normalizedOwnerAgentId !== normalizedScopedAgentId
      ) {
        continue;
      }
      const keys = filterSessionKeysByScopedAgent({
        cfg: params.cfg,
        scopedAgentId,
        keys: resolveSessionTranscriptMemoryHitKeyToSessionKeys({
          store: combinedSessionStore,
          key: artifactIdentity.memoryKey,
          includeSyntheticFallback: artifactIdentity.archived,
        }),
      });
      if (keys.length === 0) {
        continue;
      }
      if (
        !isMemoryRecallAllowed({ keys, guard, sandboxed: params.sandboxed, authoritative: true })
      ) {
        continue;
      }
      next.push(hit);
      continue;
    }
    // Deprecated migration compatibility for older QMD/session rows that were
    // indexed before memory-core stored artifact-to-transcript identity.
    const identity = extractTranscriptIdentityFromSessionsMemoryHit(hit.path);
    if (!identity) {
      continue;
    }
    const isQmdSessionHit = hit.path.replace(/\\/g, "/").startsWith("qmd/");
    const normalizedScopedAgentId = normalizeAgentIdForCompare(scopedAgentId);
    const normalizedOwnerAgentId = normalizeAgentIdForCompare(identity.ownerAgentId);
    if (
      normalizedScopedAgentId &&
      normalizedOwnerAgentId &&
      normalizedOwnerAgentId !== normalizedScopedAgentId
    ) {
      continue;
    }
    const archivedOwnerMatchesScope = Boolean(
      identity.archived &&
      ((identity.ownerAgentId &&
        (!scopedAgentId ||
          normalizeAgentIdForCompare(identity.ownerAgentId) ===
            normalizeAgentIdForCompare(scopedAgentId))) ||
        (isQmdSessionHit && scopedAgentId)),
    );
    const archivedOwnerAgentId = archivedOwnerMatchesScope
      ? (identity.ownerAgentId ?? scopedAgentId)
      : undefined;
    const liveKeys = identity.liveStem
      ? resolveTranscriptStemToSessionKeys({
          store: combinedSessionStore,
          stem: identity.liveStem,
          allowQmdSlugFallback: false,
        })
      : [];
    const keys = filterSessionKeysByScopedAgent({
      cfg: params.cfg,
      scopedAgentId,
      keys:
        liveKeys.length > 0
          ? liveKeys
          : resolveTranscriptStemToSessionKeys({
              store: combinedSessionStore,
              stem: identity.stem,
              allowQmdSlugFallback: isQmdSessionHit && !identity.archived,
              ...(archivedOwnerAgentId ? { archivedOwnerAgentId } : {}),
            }),
    });
    if (keys.length === 0) {
      continue;
    }
    // Slug-fallback key resolution is lossy: a QMD slug can map to the wrong
    // transcript, so those hits must still pass the strict visibility guard.
    const authoritative = liveKeys.length > 0 || !isQmdSessionHit;
    if (!isMemoryRecallAllowed({ keys, guard, sandboxed: params.sandboxed, authoritative })) {
      continue;
    }
    next.push(hit);
  }
  return next;
}

// Memory recall over the requester's own agent transcripts must not be gated
// by cross-session "tree" history visibility: every key reaching this check is
// already scoped to the requester's agent (filterSessionKeysByScopedAgent),
// and the tree default forbids all non-descendant sessions, which returned 0
// hits for corpus=sessions (#103732). Sandboxed runs keep the strict guard so
// the spawned-subtree clamp still holds.
function isMemoryRecallAllowed(params: {
  keys: string[];
  guard: { check: (key: string) => { allowed: boolean } };
  sandboxed: boolean;
  authoritative: boolean;
}): boolean {
  if (!params.sandboxed && params.authoritative) {
    return params.keys.length > 0;
  }
  return params.keys.some((key) => params.guard.check(key).allowed);
}
