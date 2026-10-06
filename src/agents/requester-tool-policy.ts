/**
 * Canonical requester-scoped policy resolution for external and delegated runs.
 * Sender-dependent policy resolves once at trusted ingress; verified descendants
 * consume the persisted effective parent projection instead of guessing identity.
 */
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
  isTrustedSubagentCompletionHandoffForRun,
  type TrustedSubagentCompletionHandoff,
} from "./subagents/announce/subagent-announce-handoff.js";
import { resolveRequesterStoreKey } from "./subagents/announce/subagent-requester-store-key.js";
import {
  isSubagentEnvelopeSession,
  resolvePersistedSubagentToolPolicyEnvelope,
  resolveSubagentCapabilityStore,
  type PreparedSessionCapabilityEntry,
  type SessionCapabilityStore,
} from "./subagents/spawn/subagent-capabilities.js";
import { toolPolicyRestrictsTools } from "./tool-policy.js";

export const MAX_DELEGATION_LINEAGE_DEPTH = 32;

type RequesterToolPolicySource = "current-request" | "persisted-child" | "completion-handoff";

type RequesterToolPolicyResolution = {
  delegated: boolean;
  /** Diagnostic fact identifying whether policy came from live ingress or delegated state. */
  requesterPolicySource: RequesterToolPolicySource;
  groupPolicy?: SandboxToolPolicy;
  senderPolicy?: SandboxToolPolicy;
  subagentPolicy?: SandboxToolPolicy;
  inheritedToolPolicy?: SandboxToolPolicy;
  inheritedToolPolicySource?: "sender";
  subagentStore?: SessionCapabilityStore;
};

type SenderPolicyMode = "always" | "when-sender-id" | "never";

type RequesterToolPolicyParams = {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  subagentSessionKey?: string;
  preparedSessionEntry?: PreparedSessionCapabilityEntry;
  preparedSessionCapabilityStore?: SessionCapabilityStore;
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
  trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
  sessionId?: string;
  modelProvider?: string;
  modelId?: string;
  senderPolicyMode?: SenderPolicyMode;
  /** Group session selected by a trusted scheduled authority envelope. */
  groupPolicySessionKey?: string;
  /** Fail closed when scheduled authority names a removed non-default account. */
  requireConfiguredGroupAccount?: boolean;
  /** Policy prepared by the trusted channel ingress owner for this conversation. */
  conversationPolicy?: SandboxToolPolicy;
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
):
  | { delegated: false }
  | {
      delegated: true;
      source: Exclude<RequesterToolPolicySource, "current-request">;
      policy?: SandboxToolPolicy;
      inheritedToolPolicySource?: "sender";
    } {
  const provenance = normalizeInputProvenance(params.inputProvenance);
  const hasExternalRequester =
    provenance?.kind === "external_user" ||
    Boolean(params.senderId || params.senderName || params.senderUsername || params.senderE164);
  const isTrustedCompletionHandoff = isTrustedSubagentCompletionHandoffForRun({
    handoff: params.trustedInternalHandoff,
    inputProvenance: provenance,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    provider: params.modelProvider,
    model: params.modelId,
  });
  if (isTrustedCompletionHandoff) {
    if (!provenance?.sourceSessionKey || !params.sessionKey) {
      return { delegated: false };
    }
    if (!params.config) {
      throw new Error("Trusted internal handoff policy resolution requires configuration.");
    }
    const config = params.config;
    const targetSessionKey = resolveRequesterStoreKey(config, params.sessionKey);
    const settleBatch = params.trustedInternalHandoff?.settleBatch;
    const sourceSessionKeys = settleBatch?.sourceSessionKeys ?? [provenance.sourceSessionKey];
    const envelopes = sourceSessionKeys.map((sourceSessionKey) => {
      let currentSessionKey = resolveRequesterStoreKey(config, sourceSessionKey);
      const visited = new Set<string>();
      for (let depth = 0; depth < MAX_DELEGATION_LINEAGE_DEPTH; depth += 1) {
        if (visited.has(currentSessionKey)) {
          return undefined;
        }
        visited.add(currentSessionKey);
        // The private capability admits dashboard children; persisted envelopes
        // still prove each source's lineage to this requester.
        const completionStore = resolveSubagentCapabilityStore(currentSessionKey, {
          cfg: config,
          store: params.preparedSessionCapabilityStore,
        });
        const envelope = resolvePersistedSubagentToolPolicyEnvelope(currentSessionKey, {
          cfg: config,
          store: completionStore,
        });
        if (!envelope) {
          return undefined;
        }
        const parentSessionKey = resolveRequesterStoreKey(config, envelope.spawnedBy);
        const completionOwnerSessionKey = envelope.completionOwnerSessionKey
          ? resolveRequesterStoreKey(config, envelope.completionOwnerSessionKey)
          : undefined;
        if ((completionOwnerSessionKey ?? parentSessionKey) === targetSessionKey) {
          return envelope;
        }
        currentSessionKey = parentSessionKey;
      }
      return undefined;
    });
    const envelope = envelopes[0];
    if (settleBatch) {
      // A batch must carry one exact requester policy, never whichever child's
      // policy happens to sort first or the union of sibling capabilities.
      const policyKey = (entry: NonNullable<typeof envelope>) =>
        JSON.stringify([
          entry.inheritedToolAllow.toSorted(),
          entry.inheritedToolDeny.toSorted(),
          entry.inheritedToolPolicySource,
        ]);
      if (
        !envelope ||
        envelopes.some((entry) => !entry || policyKey(entry) !== policyKey(envelope))
      ) {
        return { delegated: false };
      }
    }
    return envelope
      ? {
          delegated: true,
          source: "completion-handoff",
          policy: policyFromEnvelope(envelope),
          inheritedToolPolicySource: envelope.inheritedToolPolicySource,
        }
      : { delegated: false };
  }
  if (!hasExternalRequester) {
    const ownEnvelope = resolvePersistedSubagentToolPolicyEnvelope(params.subagentSessionKey, {
      cfg: params.config,
      store: subagentStore,
    });
    if (ownEnvelope) {
      // Senderless child and trusted-operator resumes keep the spawn-time requester snapshot.
      // Later toolsBySender edits are non-retroactive; current non-sender restrictions layer later.
      return {
        delegated: true,
        source: "persisted-child",
        policy: policyFromEnvelope(ownEnvelope),
        inheritedToolPolicySource: ownEnvelope.inheritedToolPolicySource,
      };
    }
  }
  return { delegated: false };
}

/** Confirms that an exact consumed completion capability also owns persisted requester lineage. */
export function hasVerifiedRequesterCompletionHandoff(
  params: Pick<
    RequesterToolPolicyParams,
    | "config"
    | "sessionKey"
    | "inputProvenance"
    | "trustedInternalHandoff"
    | "sessionId"
    | "modelProvider"
    | "modelId"
    | "preparedSessionCapabilityStore"
  >,
): boolean {
  const delegatedPolicy = resolveDelegatedPolicy(params, undefined);
  return delegatedPolicy.delegated && delegatedPolicy.source === "completion-handoff";
}

/** Resolve sender/group policy or a verified inherited projection, never both. */
export function resolveRequesterToolPolicies(
  params: RequesterToolPolicyParams,
): RequesterToolPolicyResolution {
  const subagentSessionKey = params.subagentSessionKey ?? params.sessionKey;
  const subagentStore = resolveSubagentCapabilityStore(subagentSessionKey, {
    cfg: params.config,
    preparedSessionEntry: params.preparedSessionEntry,
    store: params.preparedSessionCapabilityStore,
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
      requesterPolicySource: delegatedPolicy.source,
      subagentPolicy,
      inheritedToolPolicy: delegatedPolicy.policy,
      inheritedToolPolicySource: delegatedPolicy.inheritedToolPolicySource,
      subagentStore,
    };
  }
  const senderPolicyMode = params.senderPolicyMode ?? "always";
  const shouldResolveSenderPolicy =
    senderPolicyMode === "always" ||
    (senderPolicyMode === "when-sender-id" && Boolean(params.senderId));
  const groupPolicy =
    params.conversationPolicy ??
    resolveGroupToolPolicy({
      config: params.config,
      sessionKey: params.groupPolicySessionKey ?? params.sessionKey,
      spawnedBy: params.spawnedBy,
      messageProvider: params.messageProvider ?? undefined,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      accountId: params.accountId,
      requireConfiguredAccount: params.requireConfiguredGroupAccount,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      senderPolicyMode: senderPolicyMode === "never" ? "never" : "always",
    });
  const senderPolicy = shouldResolveSenderPolicy
    ? resolveSenderToolPolicy({
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        messageProvider: params.messageProvider,
        senderId: params.senderId,
        senderName: params.senderName,
        senderUsername: params.senderUsername,
        senderE164: params.senderE164,
      })
    : undefined;
  const inheritedEnvelope = resolvePersistedSubagentToolPolicyEnvelope(subagentSessionKey, {
    cfg: params.config,
    store: subagentStore,
  });
  return {
    delegated: false,
    requesterPolicySource: "current-request",
    groupPolicy,
    senderPolicy,
    inheritedToolPolicySource:
      inheritedEnvelope?.inheritedToolPolicySource === "sender" ||
      toolPolicyRestrictsTools(groupPolicy) ||
      toolPolicyRestrictsTools(senderPolicy)
        ? "sender"
        : undefined,
    subagentPolicy,
    inheritedToolPolicy: resolveInheritedToolPolicyForSession(params.config, subagentSessionKey, {
      store: subagentStore,
    }),
    subagentStore,
  };
}
