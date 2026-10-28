/**
 * Canonical requester-scoped policy resolution for external and delegated runs.
 * Native admissions resolve current configuration for preserved requester facts.
 * Spawned-child envelopes keep their separate inherited-authority contract.
 */
import { normalizeChatType } from "../channels/chat-type.js";
import { resolveLegacyConversationToolPolicy } from "../channels/inbound-event/legacy-tool-policy.js";
import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import {
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "./agent-tools.policy.js";
import {
  resolveDelegatedExecutionToolPolicy,
  type DelegatedToolPolicy,
} from "./delegated-tool-policy.js";
import type { RequesterOrigin } from "./requester-origin.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
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
  /** The requester's own ceiling, excluding a completion's replayed authority. */
  sessionInheritedToolPolicy?: SandboxToolPolicy;
  /** Full ancestor ceiling retained by descendants and completion, even when execution differs. */
  inheritedToolPolicyForSpawn?: SandboxToolPolicy;
  delegatedToolPolicy?: DelegatedToolPolicy;
  inheritedToolPolicySource?: "sender";
};

type SenderPolicyMode = "always" | "when-sender-id" | "never";

/** Current owner authority may accompany an internal origin without a provider. */
export function isInternalOwnerRequester(params: {
  requesterOrigin?: RequesterOrigin;
  messageProvider?: string | null;
  messageChannel?: string | null;
  senderIsOwner?: boolean;
}): boolean {
  // An inherited origin cannot be reclassified by the destination's route.
  const requesterMessageProvider = normalizeMessageChannel(
    params.requesterOrigin
      ? params.requesterOrigin.messageProvider
      : (params.messageProvider ?? params.messageChannel),
  );
  return (
    params.senderIsOwner === true &&
    (requesterMessageProvider === INTERNAL_MESSAGE_CHANNEL ||
      (params.requesterOrigin !== undefined && !requesterMessageProvider))
  );
}

type RequesterToolPolicyParams = {
  requesterOrigin?: RequesterOrigin;
  conversationId?: string | null;
  chatType?: string;
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
  completion = false,
): SandboxToolPolicy | undefined {
  if (!envelope) {
    return undefined;
  }
  const deny = completion
    ? (envelope.delegatedToolPolicy?.requesterDeny ?? envelope.inheritedToolDeny)
    : envelope.inheritedToolDeny;
  return envelope.inheritedToolAllow.length > 0 || deny.length > 0
    ? {
        ...(envelope.inheritedToolAllow.length > 0 ? { allow: envelope.inheritedToolAllow } : {}),
        ...(deny.length > 0 ? { deny } : {}),
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
      sessionPolicy?: SandboxToolPolicy;
      policyForSpawn?: SandboxToolPolicy;
      delegatedToolPolicy?: DelegatedToolPolicy;
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
          entry.delegatedToolPolicy?.requesterDeny.toSorted(),
        ]);
      if (
        !envelope ||
        envelopes.some((entry) => !entry || policyKey(entry) !== policyKey(envelope))
      ) {
        return { delegated: false };
      }
    }
    const targetEnvelope = resolvePersistedSubagentToolPolicyEnvelope(params.sessionKey, {
      cfg: config,
      store: subagentStore,
    });
    const targetExecutionPolicy = targetEnvelope
      ? resolveDelegatedExecutionToolPolicy({ config, ...targetEnvelope })
      : undefined;
    const completionPolicy = policyFromEnvelope(envelope, true);
    const targetFloor = targetEnvelope?.delegatedToolPolicy
      ? (targetExecutionPolicy ?? policyFromEnvelope(targetEnvelope))
      : undefined;
    const completionDeny = [...(completionPolicy?.deny ?? []), ...(targetFloor?.deny ?? [])];
    return envelope
      ? {
          delegated: true,
          source: "completion-handoff",
          sessionPolicy: targetExecutionPolicy ?? policyFromEnvelope(targetEnvelope),
          policy: completionDeny.length
            ? { ...completionPolicy, deny: completionDeny }
            : completionPolicy,
          ...(targetEnvelope?.delegatedToolPolicy
            ? {
                policyForSpawn: {
                  ...completionPolicy,
                  deny: [...(completionPolicy?.deny ?? []), ...targetEnvelope.inheritedToolDeny],
                },
                delegatedToolPolicy: targetExecutionPolicy
                  ? targetEnvelope.delegatedToolPolicy
                  : undefined,
              }
            : {}),
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
      // The child keeps its persisted execution ceiling. An origin-bearing
      // admission also resolves current requester permissions below.
      const executionPolicy = resolveDelegatedExecutionToolPolicy({
        config: params.config,
        ...ownEnvelope,
      });
      return {
        delegated: true,
        source: "persisted-child",
        policy: executionPolicy ?? policyFromEnvelope(ownEnvelope),
        delegatedToolPolicy: executionPolicy ? ownEnvelope.delegatedToolPolicy : undefined,
        policyForSpawn: policyFromEnvelope(ownEnvelope),
        inheritedToolPolicySource: ownEnvelope.inheritedToolPolicySource,
      };
    }
  }
  return { delegated: false };
}

/** Resolve conversation configuration for one admission without acquiring child lineage. */
export function resolveRequesterConversationToolPolicy(
  params: RequesterToolPolicyParams,
): SandboxToolPolicy | undefined {
  const requester = params.requesterOrigin ?? params;
  const senderPolicyMode = params.senderPolicyMode ?? "always";
  const channel = normalizeMessageChannel(requester.messageProvider);
  const direct = normalizeChatType(requester.chatType) === "direct";
  const configuredDirectPolicy =
    direct && channel && params.config && requester.conversationId
      ? getLoadedChannelPlugin(channel)?.security?.resolveDirectToolPolicy?.({
          cfg: params.config,
          accountId: requester.accountId,
          conversationId: requester.conversationId,
          senderPolicyMode: senderPolicyMode === "never" ? "never" : "always",
          senderId: requester.senderId,
          senderName: requester.senderName,
          senderUsername: requester.senderUsername,
          senderE164: requester.senderE164,
        })
      : undefined;
  // Legacy plugins retain the original request's execution-local snapshot.
  // New delegation admissions carry requester facts, never this policy.
  const legacyPolicy = resolveLegacyConversationToolPolicy(params.conversationPolicy);
  return (
    legacyPolicy ??
    (direct
      ? pickSandboxToolPolicy(configuredDirectPolicy)
      : resolveGroupToolPolicy({
          config: params.config,
          sessionKey:
            params.requesterOrigin?.sessionKey ?? params.groupPolicySessionKey ?? params.sessionKey,
          spawnedBy: params.requesterOrigin ? undefined : params.spawnedBy,
          messageProvider: requester.messageProvider ?? undefined,
          groupId: requester.groupId,
          groupChannel: requester.groupChannel,
          groupSpace: requester.groupSpace,
          accountId: requester.accountId,
          requireConfiguredAccount: params.requireConfiguredGroupAccount,
          senderId: requester.senderId,
          senderName: requester.senderName,
          senderUsername: requester.senderUsername,
          senderE164: requester.senderE164,
          senderPolicyMode: senderPolicyMode === "never" ? "never" : "always",
        }))
  );
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
  const delegatedPolicy = resolveDelegatedPolicy(params, params.preparedSessionCapabilityStore);
  return delegatedPolicy.delegated && delegatedPolicy.source === "completion-handoff";
}

/** Resolve current requester permissions alongside any persisted child execution envelope. */
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
  // Preserved origin supplies requester facts for a new admission without
  // replacing the child's persisted ceiling or its explicit delegation grant.
  const resolveCurrentRequesterPolicy =
    !delegatedPolicy.delegated ||
    (delegatedPolicy.source === "persisted-child" && params.requesterOrigin !== undefined);
  const requester = params.requesterOrigin ?? params;
  const senderPolicyMode = params.senderPolicyMode ?? "always";
  const shouldResolveSenderPolicy =
    senderPolicyMode === "always" ||
    (senderPolicyMode === "when-sender-id" && Boolean(requester.senderId));
  const groupPolicy = resolveCurrentRequesterPolicy
    ? resolveRequesterConversationToolPolicy(params)
    : undefined;
  const senderPolicy =
    resolveCurrentRequesterPolicy && shouldResolveSenderPolicy
      ? resolveSenderToolPolicy({
          config: params.config,
          agentId: params.agentId,
          sessionKey: requester.sessionKey,
          messageProvider: requester.messageProvider,
          senderId: requester.senderId,
          senderName: requester.senderName,
          senderUsername: requester.senderUsername,
          senderE164: requester.senderE164,
        })
      : undefined;
  if (delegatedPolicy.delegated) {
    // Senderless resumes and verified completion handoffs retain their snapshot;
    // resolving them without requester identity would select an unrelated wildcard.
    return {
      delegated: true,
      requesterPolicySource: delegatedPolicy.source,
      groupPolicy,
      senderPolicy,
      subagentPolicy,
      inheritedToolPolicy: delegatedPolicy.policy,
      sessionInheritedToolPolicy:
        delegatedPolicy.source === "completion-handoff"
          ? delegatedPolicy.sessionPolicy
          : delegatedPolicy.policy,
      inheritedToolPolicyForSpawn: delegatedPolicy.policyForSpawn ?? delegatedPolicy.policy,
      delegatedToolPolicy: delegatedPolicy.delegatedToolPolicy,
      inheritedToolPolicySource:
        toolPolicyRestrictsTools(groupPolicy) || toolPolicyRestrictsTools(senderPolicy)
          ? "sender"
          : delegatedPolicy.inheritedToolPolicySource,
    };
  }
  const inheritedEnvelope = resolvePersistedSubagentToolPolicyEnvelope(subagentSessionKey, {
    cfg: params.config,
    store: subagentStore,
  });
  const inheritedToolPolicy = resolveInheritedToolPolicyForSession(
    params.config,
    subagentSessionKey,
    { store: subagentStore },
  );
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
    inheritedToolPolicy,
    sessionInheritedToolPolicy: inheritedToolPolicy,
  };
}
