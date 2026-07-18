/**
 * Canonical requester-scoped policy resolution for external and delegated runs.
 * Sender-dependent policy resolves once at trusted ingress; verified descendants
 * consume the persisted effective parent projection instead of guessing identity.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import {
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "./agent-tools.policy.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import { resolveSenderToolPolicy } from "./sender-tool-policy.js";
import {
  isSubagentEnvelopeSession,
  resolvePersistedSubagentToolPolicyEnvelope,
  resolveSubagentCapabilityStore,
  type SessionCapabilityStore,
} from "./subagent-capabilities.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

const MAX_DELEGATION_LINEAGE_DEPTH = 32;

export type RequesterToolPolicyResolution = {
  delegated: boolean;
  groupPolicy?: SandboxToolPolicy;
  senderPolicy?: SandboxToolPolicy;
  subagentPolicy?: SandboxToolPolicy;
  inheritedToolPolicy?: SandboxToolPolicy;
  subagentStore?: SessionCapabilityStore;
};

type SenderPolicyMode = "always" | "when-sender-id" | "never";

type RequesterToolPolicyParams = {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  subagentSessionKey?: string;
  spawnedBy?: string | null;
  messageProvider?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  inputProvenance?: InputProvenance;
  trustedInternalHandoff?: boolean;
  senderPolicyMode?: SenderPolicyMode;
};

function policyFromEnvelope(
  envelope: ReturnType<typeof resolvePersistedSubagentToolPolicyEnvelope>,
): SandboxToolPolicy | undefined {
  if (!envelope) {
    return undefined;
  }
  return envelope.inheritedToolAllow.length > 0 || envelope.inheritedToolDeny.length > 0
    ? {
        ...(envelope.inheritedToolAllow.length > 0 ? { allow: envelope.inheritedToolAllow } : {}),
        ...(envelope.inheritedToolDeny.length > 0 ? { deny: envelope.inheritedToolDeny } : {}),
      }
    : undefined;
}

function resolveDelegatedPolicy(
  params: RequesterToolPolicyParams,
  subagentStore: SessionCapabilityStore | undefined,
): {
  delegated: boolean;
  policy?: SandboxToolPolicy;
} {
  const provenance = normalizeInputProvenance(params.inputProvenance);
  const hasExternalRequester =
    provenance?.kind === "external_user" ||
    Boolean(params.senderId || params.senderName || params.senderUsername || params.senderE164);
  if (!hasExternalRequester) {
    const ownEnvelope = resolvePersistedSubagentToolPolicyEnvelope(params.subagentSessionKey, {
      cfg: params.config,
      store: subagentStore,
    });
    if (ownEnvelope) {
      return { delegated: true, policy: policyFromEnvelope(ownEnvelope) };
    }
  }
  if (!params.trustedInternalHandoff) {
    return { delegated: false };
  }
  if (
    provenance?.kind !== "inter_session" ||
    normalizeOptionalLowercaseString(provenance.sourceTool) !== "subagent_announce" ||
    !provenance.sourceSessionKey ||
    !params.sessionKey
  ) {
    return { delegated: false };
  }
  const targetSessionKey = resolveRequesterStoreKey(params.config, params.sessionKey);
  let currentSessionKey = resolveRequesterStoreKey(params.config, provenance.sourceSessionKey);
  const visited = new Set<string>();
  for (let depth = 0; depth < MAX_DELEGATION_LINEAGE_DEPTH; depth += 1) {
    if (visited.has(currentSessionKey)) {
      return { delegated: false };
    }
    visited.add(currentSessionKey);
    const envelope = resolvePersistedSubagentToolPolicyEnvelope(currentSessionKey, {
      cfg: params.config,
    });
    if (!envelope) {
      return { delegated: false };
    }
    const parentSessionKey = resolveRequesterStoreKey(params.config, envelope.spawnedBy);
    if (parentSessionKey === targetSessionKey) {
      return { delegated: true, policy: policyFromEnvelope(envelope) };
    }
    currentSessionKey = parentSessionKey;
  }
  return { delegated: false };
}

/** Resolve sender/group policy or a verified inherited projection, never both. */
export function resolveRequesterToolPolicies(
  params: RequesterToolPolicyParams,
): RequesterToolPolicyResolution {
  const subagentSessionKey = params.subagentSessionKey ?? params.sessionKey;
  const subagentStore = resolveSubagentCapabilityStore(subagentSessionKey, {
    cfg: params.config,
  });
  const delegatedPolicy = resolveDelegatedPolicy({ ...params, subagentSessionKey }, subagentStore);
  const subagentPolicy =
    subagentSessionKey &&
    isSubagentEnvelopeSession(subagentSessionKey, {
      cfg: params.config,
      store: subagentStore,
    })
      ? resolveSubagentToolPolicyForSession(params.config, subagentSessionKey, {
          store: subagentStore,
        })
      : undefined;
  if (delegatedPolicy.delegated) {
    // The persisted projection already includes both global and group sender policy.
    // Re-resolving either without external identity would incorrectly select its wildcard.
    return {
      delegated: true,
      subagentPolicy,
      inheritedToolPolicy: delegatedPolicy.policy,
      subagentStore,
    };
  }
  const senderPolicyMode = params.senderPolicyMode ?? "always";
  const shouldResolveSenderPolicy =
    senderPolicyMode === "always" ||
    (senderPolicyMode === "when-sender-id" && Boolean(params.senderId));
  return {
    delegated: false,
    groupPolicy: resolveGroupToolPolicy({
      config: params.config,
      sessionKey: params.sessionKey,
      spawnedBy: params.spawnedBy,
      messageProvider: params.messageProvider ?? undefined,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      accountId: params.accountId,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    }),
    senderPolicy: shouldResolveSenderPolicy
      ? resolveSenderToolPolicy({
          config: params.config,
          agentId: params.agentId,
          messageProvider: params.messageProvider,
          senderId: params.senderId,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
        })
      : undefined,
    subagentPolicy,
    inheritedToolPolicy: resolveInheritedToolPolicyForSession(params.config, subagentSessionKey, {
      store: subagentStore,
    }),
    subagentStore,
  };
}
