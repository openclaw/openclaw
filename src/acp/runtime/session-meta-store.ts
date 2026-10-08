/** Store binding for ACP session metadata: resolves which session-store row owns a key. */
import {
  AgentSelectionRequiredError,
  listAgentIds,
  tryResolveAgentOperationAgentId,
} from "../../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../../config/config.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { rethrowIncognitoSessionError } from "../../state/incognito-session-error.js";

export type { AcpSessionStoreEntry } from "./session-meta-read.types.js";

/** Resolves the session store path that owns an ACP session key. */
export function resolveSessionStorePathForAcp(params: {
  sessionKey: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): { cfg: OpenClawConfig; agentId: string; storePath: string; storeSessionKey: string } {
  const cfg = params.cfg ?? getRuntimeConfig();
  const sessionKey = normalizeStoreSessionKey(params.sessionKey);
  const parsed = parseAgentSessionKey(sessionKey);
  const requestedAgentId = params.agentId?.trim() ? normalizeAgentId(params.agentId) : undefined;
  const parsedAgentId = parsed?.agentId ? normalizeAgentId(parsed.agentId) : undefined;
  const parsedRest = parsed?.rest?.toLowerCase() ?? "";
  // Free ACP harness keys name an execution target, not a configured owner
  // (#146365). A configured requested agent is admitted as owner while storage
  // keeps resolving from the harness id below, so existing harness transcripts
  // stay targeted and no content migrates stores.
  const freeHarnessOwner =
    requestedAgentId &&
    parsedAgentId &&
    requestedAgentId !== parsedAgentId &&
    parsedRest.startsWith("acp:") &&
    !parsedRest.startsWith("acp:binding:") &&
    !listAgentIds(cfg).includes(parsedAgentId) &&
    listAgentIds(cfg).includes(requestedAgentId)
      ? requestedAgentId
      : undefined;
  if (
    requestedAgentId &&
    parsedAgentId &&
    requestedAgentId !== parsedAgentId &&
    !freeHarnessOwner
  ) {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: `ACP session key "${params.sessionKey}"`,
      hint: `Agent "${requestedAgentId}" does not own agent-scoped session key "${params.sessionKey}".`,
    });
  }
  const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey);
  const agentId = requestedAgentId ?? parsedAgentId;
  if (
    requestedAgentId &&
    persistedStoreOwner.kind === "configured" &&
    requestedAgentId !== persistedStoreOwner.agentId
  ) {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: `ACP session key "${params.sessionKey}"`,
      hint: `The shared fixed-store row belongs to agent "${persistedStoreOwner.agentId}", not agent "${requestedAgentId}".`,
    });
  }
  if (persistedStoreOwner.kind === "retired") {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: `ACP session key "${params.sessionKey}"`,
      hint: `The shared fixed-store row belongs to retired agent "${persistedStoreOwner.agentId}".`,
    });
  }
  const resolvedAgentId =
    agentId ??
    (persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined) ??
    tryResolveAgentOperationAgentId(cfg);
  if (!resolvedAgentId) {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: `ACP session key "${params.sessionKey}"`,
      hint: "Pass an explicit agent owner for this ACP session.",
    });
  }
  const storeSessionKey = resolveSqliteSessionKey(
    canonicalizeMainSessionAlias({ cfg, sessionKey, agentId: resolvedAgentId }),
    resolvedAgentId,
  );
  const canonicalOwner = resolvePersistedSessionStoreOwnerForKey(cfg, storeSessionKey);
  if (
    canonicalOwner.kind === "retired" ||
    (canonicalOwner.kind === "configured" && canonicalOwner.agentId !== resolvedAgentId)
  ) {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: `ACP session key "${storeSessionKey}"`,
      hint: "The canonical fixed-store session has a different or retired owner. Select its recorded owner.",
    });
  }
  // Storage follows the harness namespace even when a configured owner is
  // admitted above; existing harness transcripts stay targeted and no content
  // migrates stores. Identity (agentId) carries the owner for config-gated
  // downstream use.
  const storeAgentId = freeHarnessOwner && parsedAgentId ? parsedAgentId : resolvedAgentId;
  return {
    cfg,
    storeSessionKey,
    agentId: resolvedAgentId,
    storePath: resolveSessionStorePathCore(cfg.session?.store, {
      agentId: storeAgentId,
      env: params.env,
    }),
  };
}

/** Reads the canonical session binding while retaining ACP's logical key. */
export function readSessionEntryFromStore(params: {
  sessionKey: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  clone?: boolean;
}): {
  cfg: OpenClawConfig;
  agentId: string;
  storePath: string;
  storeSessionKey: string;
  entry?: SessionEntry;
  storeReadFailed?: boolean;
} {
  const { cfg, agentId, storePath, storeSessionKey } = resolveSessionStorePathForAcp(params);
  try {
    const entry = storeSessionKey
      ? loadSessionEntryReadOnly({
          agentId,
          storePath,
          sessionKey: storeSessionKey,
          ...(params.clone === false ? { clone: false } : {}),
        })
      : undefined;
    return { cfg, agentId, storePath, storeSessionKey, entry };
  } catch (error) {
    rethrowIncognitoSessionError(error);
    return {
      cfg,
      agentId,
      storePath,
      storeSessionKey,
      storeReadFailed: true,
    };
  }
}
