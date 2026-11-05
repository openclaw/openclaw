import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  readSessionResetRecallCutoff,
  loadArchivedSessionsAsync,
  loadMemorySearchSessionStore,
  parseUsageCountedSessionIdFromFileName,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  resolveCanonicalMainSessionKey,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { sessionDeliveryOrigin } from "openclaw/plugin-sdk/session-store-runtime";
import {
  extractTranscriptIdentityFromSessionsMemoryHit,
  resolveTranscriptStemToSessionKeys,
} from "openclaw/plugin-sdk/session-transcript-hit";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxSessionToolsVisibility,
} from "openclaw/plugin-sdk/session-visibility";
import { normalizeOptionalLowercaseString as normalizeAgentIdForCompare } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isActiveMemoryRecallSessionKey } from "./active-memory-recall-session.js";
import {
  readSessionArchiveReasonFromHitPath,
  type SessionResetRecallCutoff,
} from "./session-reset-recall-metadata.js";

function isGlobalSessionKeyForSharedScope(cfg: OpenClawConfig, key: string): boolean {
  return cfg.session?.scope === "global" && key.trim().toLowerCase() === "global";
}

type ConversationRecallContext = NonNullable<OpenClawPluginToolContext["conversationRecall"]>;

type SessionStore = Awaited<ReturnType<typeof loadMemorySearchSessionStore>>["store"];

function isSameStoredTranscript(
  anchor: SessionStore[string] | undefined,
  candidate: SessionStore[string] | undefined,
): boolean {
  const anchorSessionId = anchor?.sessionId.trim();
  return Boolean(anchorSessionId && candidate?.sessionId.trim() === anchorSessionId);
}

function isPrivateConversation(params: {
  agentId: string;
  entry: SessionStore[string] | undefined;
  key: string;
}): boolean {
  if (!params.entry) {
    return false;
  }
  const key = params.key.trim().toLowerCase();
  const chatTypes = [params.entry.chatType, sessionDeliveryOrigin(params.entry)?.chatType].filter(
    (chatType): chatType is NonNullable<typeof chatType> => chatType !== undefined,
  );
  if (
    chatTypes.some((chatType) => chatType === "group" || chatType === "channel") ||
    isActiveMemoryRecallSessionKey(key)
  ) {
    return false;
  }
  const prefix = `agent:${params.agentId.trim().toLowerCase()}:`;
  // Shared global sessions (session.scope="global") are one identity for every
  // sender; direct chat metadata does not make them private conversations.
  if (key === "global" || key === `${prefix}global`) {
    return false;
  }
  if (key.startsWith(`${prefix}explicit:`)) {
    // Gateway UI turns persist direct metadata before prompt hooks run. Requiring
    // it distinguishes private UI sessions from headless/model-run explicit keys.
    return chatTypes.length > 0 && chatTypes.every((chatType) => chatType === "direct");
  }
  if (
    key.includes(":group:") ||
    key.includes(":channel:") ||
    /:(?:active-memory|cron|heartbeat|hook|node|subagent)(?::|$)/.test(key)
  ) {
    return false;
  }
  if (chatTypes.length > 0) {
    return chatTypes.every((chatType) => chatType === "direct");
  }
  return key.includes(":direct:") || key.includes(":dm:");
}

function anchorAliasesArePrivate(params: {
  store: SessionStore;
  agentId: string;
  anchorSessionKey: string;
  anchorEntry: SessionStore[string] | undefined;
}): boolean {
  // The anchor/destination must satisfy the same all-alias fail-closed policy as
  // candidate sources: a direct key whose transcript identity also lives under a
  // group/channel alias would leak recalled private context into a shared surface.
  return Object.entries(params.store).every(
    ([key, entry]) =>
      key === params.anchorSessionKey ||
      !isSameStoredTranscript(params.anchorEntry, entry) ||
      isPrivateConversation({ agentId: params.agentId, entry, key }),
  );
}

function isTrustedRecallRequester(params: {
  anchorSessionKey: string;
  requesterSessionKey: string | undefined;
}): boolean {
  const requesterSessionKey = params.requesterSessionKey?.trim();
  if (!requesterSessionKey || !requesterSessionKey.startsWith(params.anchorSessionKey)) {
    return false;
  }
  const recallSuffix = requesterSessionKey.slice(params.anchorSessionKey.length);
  return recallSuffix.length === 0 || /^:active-memory:[a-f0-9]{12}$/i.test(recallSuffix);
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
    const ownerAgentId = resolveSessionAgentIdStrict({
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
  conversationRecall?: ConversationRecallContext;
  /** Trusted control-plane calls may authorize only hits already scoped to this agent. */
  trustedAgentScope?: boolean;
}): Promise<MemorySearchResult[]> {
  // Session visibility owns transcript hits only. Loading the catalog here for
  // memory-only results decodes every saved session prompt on the Gateway loop.
  if (!params.hits.some((hit) => hit.source === "sessions")) {
    return params.conversationRecall?.corpus === "sessions" ? [] : params.hits;
  }
  const visibility = resolveEffectiveSessionToolsVisibility({
    cfg: params.cfg,
    sandboxed: params.sandboxed,
  });
  const a2aPolicy = createAgentToAgentPolicy(params.cfg);
  const requesterAgentId = params.requesterSessionKey
    ? resolveSessionAgentIdStrict({
        sessionKey: params.requesterSessionKey,
        config: params.cfg,
        agentId: params.agentId,
      })
    : undefined;
  const scopedAgentId = params.agentId?.trim() || requesterAgentId;

  const identities = new Map(
    params.hits
      .filter((hit) => hit.source === "sessions")
      .map((hit) => [hit.path, extractTranscriptIdentityFromSessionsMemoryHit(hit.path)] as const),
  );
  const archiveNames = [
    ...new Set(
      params.hits.flatMap((hit) => {
        const name = identities.get(hit.path)?.archived
          ? hit.path.replace(/\\/g, "/").split("/").at(-1)
          : undefined;
        return name ? [name] : [];
      }),
    ),
  ];
  const archives = archiveNames.length
    ? await loadArchivedSessionsAsync({
        agentId: scopedAgentId,
        archiveNames,
        storePath: resolveStorePath(params.cfg.session?.store, { agentId: scopedAgentId }),
      })
    : [];
  const archivedSessionsByName = new Map(archives.map((archive) => [archive.archiveName, archive]));
  const guard = params.requesterSessionKey
    ? await createSessionVisibilityGuard({
        action: "history",
        requesterSessionKey: params.requesterSessionKey,
        requesterAgentId,
        mainSessionKey:
          requesterAgentId &&
          (!params.sandboxed || resolveSandboxSessionToolsVisibility(params.cfg) === "all")
            ? resolveCanonicalMainSessionKey({
                agentId: requesterAgentId,
                mainKey: params.cfg.session?.mainKey,
                sessionScope: params.cfg.session?.scope,
              })
            : undefined,
        visibility,
        a2aPolicy,
      })
    : null;

  const conversationRecall = params.conversationRecall;
  const trustedAgentScope = Boolean(
    params.trustedAgentScope && scopedAgentId && !params.requesterSessionKey && !conversationRecall,
  );
  if (!params.requesterSessionKey && !trustedAgentScope) {
    return conversationRecall?.corpus === "sessions"
      ? []
      : params.hits.filter((hit) => hit.source !== "sessions");
  }
  const anchorSessionKey = conversationRecall?.anchorSessionKey.trim();
  const sessionKeys = new Set(archives.map((archive) => archive.sessionKey));
  if (anchorSessionKey) {
    sessionKeys.add(anchorSessionKey);
  }
  const sessionIds = new Set<string>();
  for (const [path, identity] of identities) {
    if (!identity) {
      continue;
    }
    const archive = identity.archived
      ? archivedSessionsByName.get(path.replace(/\\/g, "/").split("/").at(-1) ?? "")
      : undefined;
    if (archive?.sessionKey) {
      continue;
    }
    if (identity.archived && identity.ownerAgentId) {
      sessionKeys.add(`agent:${identity.ownerAgentId}:${identity.stem}`);
    }
    const stem = archive?.sessionId ?? identity.stem;
    sessionIds.add(stem);
    const parsedId = parseUsageCountedSessionIdFromFileName(
      stem.endsWith(".jsonl") ? stem : `${stem}.jsonl`,
    );
    if (parsedId) {
      sessionIds.add(parsedId);
    }
  }
  const { store: combinedSessionStore, storePath } = await loadMemorySearchSessionStore(
    params.cfg,
    {
      agentId: scopedAgentId,
      sessionKeys: [...sessionKeys],
      sessionIds: [...sessionIds],
    },
  );
  const recallAgentId = anchorSessionKey
    ? resolveSessionAgentIdStrict({ sessionKey: anchorSessionKey, config: params.cfg })
    : undefined;
  const anchorEntry = anchorSessionKey ? combinedSessionStore[anchorSessionKey] : undefined;
  let anchorResetCutoffPromise: Promise<SessionResetRecallCutoff> | undefined;
  const resolveAnchorResetCutoff = () => {
    if (anchorResetCutoffPromise) {
      return anchorResetCutoffPromise;
    }
    const sessionId = anchorEntry?.sessionId?.trim();
    if (!recallAgentId || !sessionId || !anchorSessionKey) {
      return Promise.resolve<SessionResetRecallCutoff>({ state: "invalid" });
    }
    anchorResetCutoffPromise = readSessionResetRecallCutoff({
      agentId: recallAgentId,
      sessionId,
      sessionKey: anchorSessionKey,
      storePath,
    }).catch(() => ({ state: "invalid" }));
    return anchorResetCutoffPromise;
  };
  const recallAuthorized = Boolean(
    conversationRecall &&
    !params.sandboxed &&
    conversationRecall.scope === "same-agent-private" &&
    (conversationRecall.corpus === "sessions" || conversationRecall.corpus === "configured") &&
    anchorSessionKey &&
    isTrustedRecallRequester({
      anchorSessionKey,
      requesterSessionKey: params.requesterSessionKey,
    }) &&
    normalizeAgentIdForCompare(recallAgentId) === normalizeAgentIdForCompare(scopedAgentId) &&
    recallAgentId &&
    isPrivateConversation({
      agentId: recallAgentId,
      entry: anchorEntry,
      key: anchorSessionKey,
    }) &&
    anchorAliasesArePrivate({
      store: combinedSessionStore,
      agentId: recallAgentId,
      anchorSessionKey,
      anchorEntry,
    }),
  );
  if (conversationRecall && !recallAuthorized) {
    return conversationRecall.corpus === "configured"
      ? params.hits.filter((hit) => hit.source !== "sessions")
      : [];
  }

  const isSessionKeyAllowed = (key: string, allowAnchorTranscript = false): boolean => {
    if (!conversationRecall || !anchorSessionKey || !recallAgentId) {
      // A bare global key is local to the selected agent store. Reattach that
      // owner before applying visibility or non-default agents look cross-agent.
      const visibilityKey =
        scopedAgentId && isGlobalSessionKeyForSharedScope(params.cfg, key)
          ? `agent:${scopedAgentId}:global`
          : key;
      return trustedAgentScope || guard?.check(visibilityKey).allowed === true;
    }
    const candidateEntry = combinedSessionStore[key];
    // Canonical and legacy alias keys can identify one transcript. Exclude the
    // live anchor, but let prior archived generations pass the privacy checks below.
    if (
      !allowAnchorTranscript &&
      (key === anchorSessionKey || isSameStoredTranscript(anchorEntry, candidateEntry))
    ) {
      return false;
    }
    const candidateAgentId = resolveSessionAgentIdStrict({ sessionKey: key, config: params.cfg });
    if (
      normalizeAgentIdForCompare(candidateAgentId) !== normalizeAgentIdForCompare(recallAgentId)
    ) {
      return false;
    }
    return isPrivateConversation({
      agentId: recallAgentId,
      entry: candidateEntry,
      key,
    });
  };

  const areSessionKeysAllowed = (keys: string[], allowAnchorTranscript = false): boolean => {
    // Product recall fails closed when aliases disagree about privacy. Ordinary
    // session-tool visibility keeps its existing any-visible-alias behavior.
    if (!conversationRecall) {
      return keys.some((key) => isSessionKeyAllowed(key));
    }
    return (
      keys.every((key) => isSessionKeyAllowed(key, allowAnchorTranscript)) &&
      Object.entries(combinedSessionStore).every(
        ([key, candidate]) =>
          !keys.some((source) => isSameStoredTranscript(combinedSessionStore[source], candidate)) ||
          isSessionKeyAllowed(key, allowAnchorTranscript),
      )
    );
  };

  const next: MemorySearchResult[] = [];
  for (const hit of params.hits) {
    if (hit.source !== "sessions") {
      if (!conversationRecall || conversationRecall.corpus === "configured") {
        next.push(hit);
      }
      continue;
    }
    const identity = identities.get(hit.path);
    if (!identity) {
      continue;
    }
    const archiveReason = readSessionArchiveReasonFromHitPath(hit.path);
    if (conversationRecall && archiveReason === "deleted") {
      continue;
    }
    const normalizedScopedAgentId = normalizeAgentIdForCompare(scopedAgentId);
    const normalizedOwnerAgentId = normalizeAgentIdForCompare(identity.ownerAgentId);
    if (
      normalizedScopedAgentId &&
      normalizedOwnerAgentId &&
      normalizedOwnerAgentId !== normalizedScopedAgentId
    ) {
      continue;
    }
    const sameAgentLiveOwnerId =
      !identity.archived &&
      normalizedScopedAgentId &&
      normalizedOwnerAgentId === normalizedScopedAgentId
        ? normalizedOwnerAgentId
        : undefined;
    const archivedOwnerMatchesScope = Boolean(
      identity.archived &&
      identity.ownerAgentId &&
      (!scopedAgentId ||
        normalizeAgentIdForCompare(identity.ownerAgentId) ===
          normalizeAgentIdForCompare(scopedAgentId)),
    );
    const archivedOwnerAgentId = archivedOwnerMatchesScope
      ? (identity.ownerAgentId ?? scopedAgentId)
      : undefined;
    const canonicalArchive = identity.archived
      ? archivedSessionsByName.get(hit.path.replace(/\\/g, "/").split("/").at(-1) ?? "")
      : undefined;
    const resolvedKeys = canonicalArchive?.sessionKey
      ? [canonicalArchive.sessionKey]
      : resolveTranscriptStemToSessionKeys({
          store: combinedSessionStore,
          stem: canonicalArchive?.sessionId ?? identity.stem,
          ...(archivedOwnerAgentId ? { archivedOwnerAgentId } : {}),
        });
    const keys = filterSessionKeysByScopedAgent({
      cfg: params.cfg,
      scopedAgentId,
      keys: resolvedKeys,
    });
    if (keys.length === 0) {
      const agentWideVisibility = visibility === "agent" || visibility === "all";
      if (sameAgentLiveOwnerId && agentWideVisibility && !conversationRecall) {
        next.push(hit);
      }
      continue;
    }
    let allowResetAnchor = false;
    const anchorSessionId = anchorEntry?.sessionId?.trim();
    if (
      conversationRecall &&
      !identity.archived &&
      recallAgentId &&
      anchorSessionId &&
      identity.stem === anchorSessionId &&
      normalizedOwnerAgentId === normalizeAgentIdForCompare(recallAgentId)
    ) {
      const cutoff = await resolveAnchorResetCutoff();
      allowResetAnchor = cutoff?.state === "valid" && hit.endLine < cutoff.cutoffLine;
    }
    const allowed = areSessionKeysAllowed(keys, archiveReason === "reset" || allowResetAnchor);
    if (!allowed) {
      continue;
    }
    next.push(hit);
  }
  return next;
}
