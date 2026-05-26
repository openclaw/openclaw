import { jt as AccessGroupConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as ChatChannelId } from "./channel-id.types-ClK6B_QE.js";
import { t as PairingChannel } from "./pairing-store.types-Drbj8_It.js";
import { r as InboundMentionFacts, t as InboundImplicitMentionKind } from "./mention-gating-D6dFDlTf.js";

//#region src/channels/message-access/types.d.ts
/** Channel identifier used in ingress diagnostics and config lookups. */
type ChannelIngressChannelId = ChatChannelId;
/** Redacted identifier category used by allowlist normalization and matching. */
type ChannelIngressIdentifierKind = "stable-id" | "username" | "email" | "phone" | "role" | `plugin:${string}`;
/** Public, redacted identifier material that can participate in allowlist matching. */
type MatchableIdentifier = {
  opaqueId: string;
  kind: ChannelIngressIdentifierKind;
  dangerous?: boolean;
  sensitivity?: "normal" | "pii";
};
/** Internal identifier material with the raw comparable value retained. */
type InternalMatchMaterial = MatchableIdentifier & {
  value: string;
};
/** Internal subject representation used by the shared ingress kernel. */
type InternalChannelIngressSubject = {
  identifiers: InternalMatchMaterial[];
};
/** Public, redacted form of a normalized allowlist entry. */
type ChannelIngressNormalizedEntry = {
  opaqueEntryId: string;
  kind: ChannelIngressIdentifierKind;
  dangerous?: boolean;
  sensitivity?: "normal" | "pii";
};
/** Internal normalized allowlist entry with its raw comparable value retained. */
type InternalNormalizedEntry = ChannelIngressNormalizedEntry & {
  value: string;
};
/** Redacted diagnostic for an invalid, disabled, or unsupported allowlist entry. */
type RedactedIngressEntryDiagnostic = {
  opaqueEntryId?: string;
  reasonCode: IngressReasonCode;
};
/** Redacted allowlist match result exposed to callers and access facts. */
type RedactedIngressMatch = {
  matched: boolean;
  matchedEntryIds: string[];
};
/** Public normalization result for a set of allowlist entries. */
type ChannelIngressNormalizeResult = {
  matchable: ChannelIngressNormalizedEntry[];
  invalid: RedactedIngressEntryDiagnostic[];
  disabled: RedactedIngressEntryDiagnostic[];
};
/** Internal normalization result with raw comparable entry values retained. */
type InternalChannelIngressNormalizeResult = Omit<ChannelIngressNormalizeResult, "matchable"> & {
  matchable: InternalNormalizedEntry[];
};
/** Adapter that gives the shared ingress kernel channel-specific identity matching. */
type InternalChannelIngressAdapter = {
  normalizeEntries(params: {
    entries: readonly string[];
    context: "dm" | "group" | "route" | "command";
    accountId: string;
  }): InternalChannelIngressNormalizeResult | Promise<InternalChannelIngressNormalizeResult>;
  matchSubject(params: {
    subject: InternalChannelIngressSubject;
    entries: readonly InternalNormalizedEntry[];
    context: "dm" | "group" | "route" | "command";
  }): RedactedIngressMatch | Promise<RedactedIngressMatch>;
};
/** Resolved access-group membership fact used by allowlist entries. */
type AccessGroupMembershipFact = {
  kind: "matched";
  groupName: string;
  source: "static" | "dynamic";
  matchedEntryIds: string[];
} | {
  kind: "not-matched";
  groupName: string;
  source: "static" | "dynamic";
} | {
  kind: "missing" | "unsupported" | "failed";
  groupName: string;
  source: "static" | "dynamic";
  reasonCode: IngressReasonCode;
  diagnosticId?: string;
};
/** Fully normalized allowlist facts for one ingress gate. */
type ResolvedIngressAllowlist = {
  rawEntryCount: number;
  normalizedEntries: ChannelIngressNormalizedEntry[];
  invalidEntries: RedactedIngressEntryDiagnostic[];
  disabledEntries: RedactedIngressEntryDiagnostic[];
  matchedEntryIds: string[];
  hasConfiguredEntries: boolean;
  hasMatchableEntries: boolean;
  hasWildcard: boolean;
  accessGroups: {
    referenced: string[];
    matched: string[];
    missing: string[];
    unsupported: string[];
    failed: string[];
  };
  match: RedactedIngressMatch;
};
/** Redacted allowlist facts safe to expose in the access graph. */
type RedactedIngressAllowlistFacts = {
  configured: boolean;
  matched: boolean;
  reasonCode: IngressReasonCode;
  matchedEntryIds: string[];
  invalidEntryCount: number;
  disabledEntryCount: number;
  accessGroups: ResolvedIngressAllowlist["accessGroups"];
};
/** Route lookup state projected into the ingress access graph. */
type RouteGateState = "not-configured" | "matched" | "not-matched" | "disabled" | "lookup-failed";
/** How a matched route affects sender allowlist evaluation. */
type RouteSenderPolicy = "inherit" | "replace" | "deny-when-empty";
/** Source list used when a route sender policy contributes sender entries. */
type RouteSenderAllowlistSource = "effective-dm" | "effective-group";
/** Raw route gate facts supplied by a channel-specific router. */
type RouteGateFacts = {
  id: string;
  kind: "route" | "routeSender" | "membership" | "ownerAllowlist" | "nestedAllowlist";
  gate: RouteGateState;
  effect: "allow" | "block-dispatch" | "ignore";
  precedence: number;
  senderPolicy: RouteSenderPolicy;
  senderAllowFrom?: Array<string | number>;
  senderAllowFromSource?: RouteSenderAllowlistSource;
  match?: RedactedIngressMatch;
};
/** Route gate facts after any route-specific sender allowlist is normalized. */
type ResolvedRouteGateFacts = Omit<RouteGateFacts, "senderAllowFrom" | "senderAllowFromSource"> & {
  senderAllowlist?: ResolvedIngressAllowlist;
};
/** Inbound event facts used to choose command, pairing, and origin-subject rules. */
type ChannelIngressEventInput = {
  kind: "message" | "reaction" | "button" | "postback" | "native-command" | "slash-command" | "system";
  authMode: "inbound" | "command" | "origin-subject" | "route-only" | "none";
  mayPair: boolean;
  originSubject?: InternalChannelIngressSubject;
};
/** Redacted event facts exposed in decisions and access facts. */
type RedactedChannelIngressEvent = Omit<ChannelIngressEventInput, "originSubject"> & {
  hasOriginSubject: boolean;
  originSubjectMatched: boolean;
};
/** Complete raw input to the shared ingress state resolver. */
type ChannelIngressStateInput = {
  channelId: ChannelIngressChannelId;
  accountId: string;
  subject: InternalChannelIngressSubject;
  conversation: {
    kind: "direct" | "group" | "channel";
    id: string;
    parentId?: string;
    threadId?: string;
    title?: string;
  };
  adapter: InternalChannelIngressAdapter;
  accessGroups?: Record<string, AccessGroupConfig>;
  accessGroupMembership?: readonly AccessGroupMembershipFact[];
  routeFacts?: RouteGateFacts[];
  mentionFacts?: InboundMentionFacts;
  event: ChannelIngressEventInput;
  allowlists: {
    dm?: Array<string | number>;
    group?: Array<string | number>;
    commandOwner?: Array<string | number>;
    commandGroup?: Array<string | number>;
    pairingStore?: Array<string | number>;
  };
};
/** Policy knobs that decide how the ingress graph is evaluated. */
type ChannelIngressPolicyInput = {
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  groupPolicy: "allowlist" | "open" | "disabled";
  groupAllowFromFallbackToAllowFrom?: boolean;
  mutableIdentifierMatching?: "disabled" | "enabled";
  activation?: {
    requireMention: boolean;
    allowTextCommands: boolean;
    allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
    order?: "before-sender" | "after-command";
  };
  command?: {
    useAccessGroups?: boolean;
    allowTextCommands: boolean;
    hasControlCommand: boolean;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  };
};
/** Ordered phase for a gate in the ingress graph. */
type IngressGatePhase = "route" | "sender" | "command" | "event" | "activation";
/** Gate kind used in the ingress graph and projected access facts. */
type IngressGateKind = "route" | "routeSender" | "dmSender" | "groupSender" | "membership" | "ownerAllowlist" | "nestedAllowlist" | "command" | "event" | "mention";
/** Effect produced by a gate when computing final ingress admission. */
type IngressGateEffect = "allow" | "block-dispatch" | "block-command" | "skip" | "observe" | "ignore";
/** Stable machine-readable reason code for ingress diagnostics. */
type IngressReasonCode = "allowed" | "route_blocked" | "route_sender_empty" | "dm_policy_disabled" | "dm_policy_open" | "dm_policy_allowlisted" | "dm_policy_pairing_required" | "dm_policy_not_allowlisted" | "group_policy_disabled" | "group_policy_open" | "group_policy_allowed" | "group_policy_empty_allowlist" | "group_policy_not_allowlisted" | "command_authorized" | "control_command_unauthorized" | "event_authorized" | "event_unauthorized" | "event_pairing_not_allowed" | "sender_not_required" | "origin_subject_missing" | "origin_subject_not_matched" | "activation_allowed" | "activation_skipped" | "access_group_missing" | "access_group_unsupported" | "access_group_failed" | "mutable_identifier_disabled" | "no_policy_match";
/** One evaluated gate in the ordered ingress access graph. */
type AccessGraphGate = {
  id: string;
  phase: IngressGatePhase;
  kind: IngressGateKind;
  effect: IngressGateEffect;
  allowed: boolean;
  reasonCode: IngressReasonCode;
  match?: RedactedIngressMatch;
  allowlist?: RedactedIngressAllowlistFacts;
  sender?: {
    policy: ChannelIngressPolicyInput["dmPolicy"] | ChannelIngressPolicyInput["groupPolicy"];
  };
  command?: {
    useAccessGroups: boolean;
    allowTextCommands: boolean;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
    shouldBlockControlCommand: boolean;
  };
  event?: RedactedChannelIngressEvent;
  activation?: {
    hasMentionFacts: boolean;
    requireMention: boolean;
    allowTextCommands: boolean;
    allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
    order?: "before-sender" | "after-command";
    shouldSkip: boolean;
    canDetectMention?: boolean;
    wasMentioned?: boolean;
    hasAnyMention?: boolean;
    implicitMentionKinds?: readonly InboundImplicitMentionKind[];
    effectiveWasMentioned?: boolean;
    shouldBypassMention?: boolean;
  };
};
/** Ordered graph of all evaluated ingress gates. */
type AccessGraph = {
  gates: AccessGraphGate[];
};
/** Normalized ingress state before policy gates are reduced into a decision. */
type ChannelIngressState = {
  channelId: ChannelIngressChannelId;
  accountId: string;
  conversationKind: "direct" | "group" | "channel";
  event: RedactedChannelIngressEvent;
  mentionFacts?: InboundMentionFacts;
  routeFacts: ResolvedRouteGateFacts[];
  allowlists: {
    dm: ResolvedIngressAllowlist;
    pairingStore: ResolvedIngressAllowlist;
    group: ResolvedIngressAllowlist;
    commandOwner: ResolvedIngressAllowlist;
    commandGroup: ResolvedIngressAllowlist;
  };
};
/** Final runtime admission action for the inbound event. */
type ChannelIngressAdmission = "dispatch" | "observe" | "skip" | "drop" | "pairing-required";
/** Final decision and graph for a resolved channel ingress event. */
type ChannelIngressDecision = {
  admission: ChannelIngressAdmission;
  decision: "allow" | "block" | "pairing";
  decisiveGateId: string;
  reasonCode: IngressReasonCode;
  graph: AccessGraph;
};
//#endregion
//#region src/channels/message-access/decision.d.ts
declare function decideChannelIngress(state: ChannelIngressState, policy: ChannelIngressPolicyInput): ChannelIngressDecision;
//#endregion
//#region src/channels/message-access/runtime-types.d.ts
/** Redacted subject identity assembled from a stable id plus optional platform aliases. */
type ChannelIngressSubject = InternalChannelIngressSubject;
/** Normalized allowlist entry material produced by a channel identity adapter. */
type ChannelIngressAdapterEntry = InternalNormalizedEntry;
/** Describes one identity field used for stable ids or platform-specific aliases. */
type ChannelIngressIdentityField = {
  /** Unique field key used in subject alias maps and diagnostics. */key?: string; /** Redacted identifier kind written into the access graph. */
  kind?: ChannelIngressIdentifierKind; /** Shared normalizer used for both entries and subjects when no side-specific normalizer exists. */
  normalize?: (value: string) => string | null | undefined; /** Normalizes configured allowlist entries for this identity field. */
  normalizeEntry?: (value: string) => string | null | undefined; /** Normalizes inbound subject values for this identity field. */
  normalizeSubject?: (value: string) => string | null | undefined; /** Marks identifiers as dangerous in diagnostics, for example mutable display names. */
  dangerous?: boolean | ((value: string) => boolean | undefined); /** Redaction hint for diagnostics and access graph consumers. */
  sensitivity?: "normal" | "pii";
};
/** Named alias field such as email, phone, UUID, room id, or platform user id. */
type ChannelIngressIdentityAlias = ChannelIngressIdentityField & {
  key: string;
};
/** Identity contract for a channel resolver. Plugins provide platform normalization here. */
type ChannelIngressIdentityDescriptor = {
  /** Primary stable identity field. Prefer immutable sender ids when the platform has one. */primary: ChannelIngressIdentityField; /** Additional identifiers that can match legacy or platform-specific allowlist entries. */
  aliases?: readonly ChannelIngressIdentityAlias[]; /** Returns true when a raw allowlist entry should authorize every sender. */
  isWildcardEntry?: (value: string) => boolean; /** Optional custom match hook for platform-specific identity equivalence. */
  matchEntry?: (params: {
    subject: ChannelIngressSubject;
    entry: ChannelIngressAdapterEntry;
    context: "dm" | "group" | "route" | "command";
  }) => boolean | undefined; /** Generates stable redacted entry ids for diagnostics. */
  resolveEntryId?: (params: {
    entry: string;
    entryIndex: number;
    fieldKey: string;
    fieldIndex: number;
  }) => string;
};
/** Convenience input for defining a stable identity descriptor with optional aliases. */
type StableChannelIngressIdentityParams = ChannelIngressIdentityField & Pick<ChannelIngressIdentityDescriptor, "aliases" | "isWildcardEntry" | "matchEntry"> & {
  /** Prefix used for generated entry ids when `resolveEntryId` is omitted. */entryIdPrefix?: string; /** Custom entry-id generator used in redacted diagnostics. */
  resolveEntryId?: ChannelIngressIdentityDescriptor["resolveEntryId"];
};
/** Raw sender identity passed by a plugin for one inbound event. */
type ChannelIngressIdentitySubjectInput = {
  /** Stable sender id appended to effective allowlists when access groups matched. */stableId?: string | number | null; /** Optional identity aliases keyed by `ChannelIngressIdentityAlias.key`. */
  aliases?: Record<string, string | number | null | undefined>;
};
/** Minimal config subset consumed by the ingress resolver. */
type ChannelIngressConfigInput = {
  /** Static or dynamic access group definitions referenced by allowlist entries. */accessGroups?: ChannelIngressStateInput["accessGroups"]; /** Command config used for access-group command behavior. */
  commands?: {
    useAccessGroups?: boolean;
  } | null;
} | null;
/** Command gate input for control-command authorization. */
type ChannelMessageIngressCommandInput = NonNullable<ChannelIngressPolicyInput["command"]> & {
  /** Explicit command-owner allowlist; defaults to effective DM allowlist. */commandOwnerAllowFrom?: Array<string | number> | null; /** Controls whether group command owners inherit configured DM owners. */
  groupOwnerAllowFrom?: "configured" | "none"; /** Allows direct-message command checks to reuse effective group allowlists. */
  directGroupAllowFrom?: "effective" | "none"; /** Group command allowFrom fallback, separate from normal group sender policy. */
  commandGroupAllowFromFallbackToAllowFrom?: boolean;
};
/** Preset form for command gates accepted by `createChannelIngressResolver`. */
type ChannelIngressCommandPresetInput = Omit<Partial<ChannelMessageIngressCommandInput>, "useAccessGroups"> & {
  /** Set false to omit the command gate entirely. */requested?: boolean; /** Overrides `cfg.commands.useAccessGroups` for this command decision. */
  useAccessGroups?: boolean | null; /** Config subset used to derive command access-group behavior. */
  cfg?: ChannelIngressConfigInput;
};
/** Preset form for event gates accepted by `createChannelIngressResolver`. */
type ChannelIngressEventPresetInput = Partial<ChannelIngressEventInput> & {
  /** Convenience flag used to derive pairing defaults for group events. */isGroup?: boolean;
};
/** Optional route gate, such as a room, thread, topic, guild, or group route. */
type ChannelIngressRouteDescriptor = {
  /** Stable route id used in diagnostics. */id: string; /** Route kind for diagnostics and graph consumers. */
  kind?: RouteGateFacts["kind"]; /** Whether this route policy is configured. */
  configured?: boolean; /** Whether the inbound event matched this route. */
  matched?: boolean; /** Whether this route admits the inbound event. */
  allowed?: boolean; /** Whether to include this route descriptor in the graph. */
  enabled?: boolean; /** Ordering hint when multiple route descriptors are supplied. */
  precedence?: number; /** How route sender allowlists combine with effective channel allowlists. */
  senderPolicy?: RouteGateFacts["senderPolicy"]; /** Route-specific sender allowlist entries. */
  senderAllowFrom?: Array<string | number> | null; /** Indicates whether route sender entries came from effective DM or group policy. */
  senderAllowFromSource?: RouteGateFacts["senderAllowFromSource"]; /** Optional redacted match id for the route. */
  matchId?: string; /** Reason used when this route blocks the event. */
  blockReason?: string;
};
/** Dynamic access-group resolver invoked for groups that need platform lookups. */
type ChannelIngressAccessGroupMembershipResolver = (params: {
  name: string;
  group: AccessGroupConfig;
  channelId: ChannelIngressChannelId;
  accountId: string;
  subject: ChannelIngressIdentitySubjectInput;
}) => boolean | Promise<boolean>;
/** Complete input for resolving one inbound channel message or event. */
type ResolveChannelMessageIngressParams = {
  /** Channel id used for config, diagnostics, access groups, and pairing-store reads. */channelId: ChannelIngressChannelId; /** Account id scoped to this channel instance. */
  accountId: string; /** Identity descriptor that normalizes sender and allowlist material. */
  identity: ChannelIngressIdentityDescriptor; /** Inbound sender identity for this event. */
  subject: ChannelIngressIdentitySubjectInput; /** Conversation classification and id. */
  conversation: ChannelIngressStateInput["conversation"]; /** Event auth mode and pairing/origin-subject facts. */
  event: ChannelIngressEventInput; /** Sender, command, event, route, and activation policy. */
  policy: ChannelIngressPolicyInput; /** Raw direct-message allowlist entries. */
  allowFrom?: Array<string | number> | null; /** Raw group sender allowlist entries. */
  groupAllowFrom?: Array<string | number> | null; /** Route descriptors used to build route gates. */
  route?: ChannelIngressRouteDescriptor | readonly ChannelIngressRouteDescriptor[]; /** Prebuilt route facts for lower-level callers. */
  routeFacts?: RouteGateFacts[]; /** Access group config referenced by allowlist entries. */
  accessGroups?: ChannelIngressStateInput["accessGroups"]; /** Precomputed access-group memberships for this subject. */
  accessGroupMembership?: readonly AccessGroupMembershipFact[]; /** Resolver for dynamic access groups. */
  resolveAccessGroupMembership?: ChannelIngressAccessGroupMembershipResolver; /** Concrete sender entry appended to effective allowlists when an access group matched. */
  accessGroupMatchedAllowFromEntry?: string | number | null; /** Records whether a provider-specific missing-config fallback was applied. */
  providerMissingFallbackApplied?: boolean; /** Mention or activation facts for activation gates. */
  mentionFacts?: ChannelIngressStateInput["mentionFacts"]; /** Optional pairing-store reader for direct-message allowlist material. */
  readStoreAllowFrom?: (params: {
    channelId: ChannelIngressChannelId;
    accountId: string;
    dmPolicy: ChannelIngressPolicyInput["dmPolicy"];
  }) => Promise<readonly (string | number)[] | null | undefined>; /** Reads the default pairing store when no explicit reader is supplied. */
  useDefaultPairingStore?: boolean; /** Command gate input; omit when no command policy is requested. */
  command?: ChannelMessageIngressCommandInput;
};
/** Shared resolver defaults for repeated events from the same channel account. */
type CreateChannelIngressResolverParams = Pick<ResolveChannelMessageIngressParams, "channelId" | "accountId" | "identity" | "accessGroups" | "accessGroupMembership" | "resolveAccessGroupMembership" | "accessGroupMatchedAllowFromEntry" | "readStoreAllowFrom" | "useDefaultPairingStore"> & {
  /** Config subset used for access groups and command behavior. */cfg?: ChannelIngressConfigInput; /** Global override for access-group expansion in this resolver. */
  useAccessGroups?: boolean | null; /** Default DM policy for message calls that omit it. */
  defaultDmPolicy?: ChannelIngressPolicyInput["dmPolicy"]; /** Default group policy for message calls that omit it. */
  defaultGroupPolicy?: ChannelIngressPolicyInput["groupPolicy"]; /** Default group allowlist fallback behavior. */
  groupAllowFromFallbackToAllowFrom?: boolean; /** Mutable identifier matching policy for this resolver. */
  mutableIdentifierMatching?: ChannelIngressPolicyInput["mutableIdentifierMatching"];
};
/** Per-message input for a resolver created by `createChannelIngressResolver`. */
type ChannelIngressResolverMessageParams = Omit<ResolveChannelMessageIngressParams, "channelId" | "accountId" | "identity" | "accessGroups" | "resolveAccessGroupMembership" | "accessGroupMatchedAllowFromEntry" | "readStoreAllowFrom" | "useDefaultPairingStore" | "event" | "policy" | "command"> & {
  /** Event facts or presets; defaults to a normal inbound message event. */event?: ChannelIngressEventInput | ChannelIngressEventPresetInput; /** DM policy override for this event. */
  dmPolicy?: ChannelIngressPolicyInput["dmPolicy"]; /** Group policy override for this event. */
  groupPolicy?: ChannelIngressPolicyInput["groupPolicy"]; /** Additional policy fields merged with resolver defaults. */
  policy?: Partial<Omit<ChannelIngressPolicyInput, "dmPolicy" | "groupPolicy">>; /** Command gate input, preset, or false to suppress command checks. */
  command?: ChannelMessageIngressCommandInput | ChannelIngressCommandPresetInput | false;
};
/** Reusable high-level ingress resolver for message, command, and event surfaces. */
type ChannelIngressResolver = {
  /** Resolve a normal inbound message with sender, route, command, event, and activation gates. */message(params: ChannelIngressResolverMessageParams): Promise<ResolvedChannelMessageIngress>; /** Resolve a command-oriented event with command auth defaults enabled. */
  command(params: ChannelIngressResolverMessageParams): Promise<ResolvedChannelMessageIngress>; /** Resolve a non-message event with event-gate defaults enabled. */
  event(params: ChannelIngressResolverMessageParams): Promise<ResolvedChannelMessageIngress>;
};
/** One-shot helper input using a simple stable identity descriptor. */
type ResolveStableChannelMessageIngressParams = Omit<CreateChannelIngressResolverParams, "identity"> & ChannelIngressResolverMessageParams & {
  identity?: StableChannelIngressIdentityParams;
};
/** Sender/conversation projection consumed by channel handlers. */
type ChannelIngressSenderAccess = {
  /** True when the sender gate admits the event. */allowed: boolean; /** Final ingress decision after all gates, not just the sender gate. */
  decision: ChannelIngressDecision["decision"]; /** Sender gate reason when present, otherwise decisive ingress reason. */
  reasonCode: IngressReasonCode; /** Sender gate from the access graph, when one ran. */
  gate?: AccessGraphGate; /** Effective DM allowlist entries after store and access-group processing. */
  effectiveAllowFrom: string[]; /** Effective group allowlist entries after fallback and access-group processing. */
  effectiveGroupAllowFrom: string[]; /** Whether provider-specific fallback behavior was applied. */
  providerMissingFallbackApplied: boolean;
};
/** Command projection consumed by channel command/control handlers. */
type ChannelIngressCommandAccess = {
  /** True when a command gate was requested for this event. */requested: boolean; /** True when the command gate authorizes this sender. */
  authorized: boolean; /** True when an unauthorized control command should be blocked. */
  shouldBlockControlCommand: boolean; /** Command gate reason when present, otherwise decisive ingress reason. */
  reasonCode: IngressReasonCode; /** Command gate from the access graph, when one ran. */
  gate?: AccessGraphGate;
};
/** Route projection consumed by room/thread/topic handlers. */
type ChannelIngressRouteAccess = {
  /** True when all configured route gates admit the event. */allowed: boolean; /** Route gate reason when a route gate decided. */
  reasonCode?: IngressReasonCode; /** Optional route-specific reason text. */
  reason?: string; /** Route gate from the access graph, when one ran. */
  gate?: AccessGraphGate;
};
/** Activation/mention projection consumed by group handlers. */
type ChannelIngressActivationAccess = {
  /** True when an activation gate ran. */ran: boolean; /** True when activation admits the event. */
  allowed: boolean; /** True when the event should be skipped instead of dispatched. */
  shouldSkip: boolean; /** Activation gate reason when present, otherwise decisive ingress reason. */
  reasonCode: IngressReasonCode; /** Effective mention match after command bypass and activation policy. */
  effectiveWasMentioned?: boolean; /** True when mention gating was bypassed by policy or command facts. */
  shouldBypassMention?: boolean; /** Activation gate from the access graph, when one ran. */
  gate?: AccessGraphGate;
};
/** Full ingress result returned by runtime resolvers. */
type ResolvedChannelMessageIngress = {
  /** Redacted normalized state used as input to the decision engine. */state: ChannelIngressState; /** Ordered access graph plus final admission decision. */
  ingress: ChannelIngressDecision; /** Sender/conversation projection. */
  senderAccess: ChannelIngressSenderAccess; /** Route projection. */
  routeAccess: ChannelIngressRouteAccess; /** Command projection. */
  commandAccess: ChannelIngressCommandAccess; /** Activation/mention projection. */
  activationAccess: ChannelIngressActivationAccess;
};
//#endregion
//#region src/channels/message-access/runtime-identity.d.ts
/** Build an identity descriptor for channels with one stable id and optional aliases. */
declare function defineStableChannelIngressIdentity(params?: StableChannelIngressIdentityParams): ChannelIngressIdentityDescriptor;
//#endregion
//#region src/channels/message-access/runtime.d.ts
/**
 * Read pairing-store allowlist entries when a direct-message policy permits
 * store fallback.
 */
declare function readChannelIngressStoreAllowFromForDmPolicy(params: {
  provider: PairingChannel;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
  readStore?: (provider: PairingChannel, accountId: string) => Promise<string[]>;
}): Promise<string[]>;
/**
 * Create a reusable ingress resolver for one channel account and identity
 * descriptor.
 */
declare function createChannelIngressResolver(base: CreateChannelIngressResolverParams): ChannelIngressResolver;
/**
 * Resolve one inbound event using a simple stable subject identity descriptor.
 */
declare function resolveStableChannelMessageIngress(params: ResolveStableChannelMessageIngressParams): Promise<ResolvedChannelMessageIngress>;
/**
 * Collect optional route descriptors while dropping false, null, and undefined
 * entries.
 */
declare function channelIngressRoutes(...routes: Array<ChannelIngressRouteDescriptor | false | null | undefined>): ChannelIngressRouteDescriptor[];
/**
 * Resolve sender, route, command, event, and activation gates for one inbound
 * channel event.
 */
declare function resolveChannelMessageIngress(params: ResolveChannelMessageIngressParams): Promise<ResolvedChannelMessageIngress>;
//#endregion
export { ResolvedRouteGateFacts as $, ChannelIngressChannelId as A, IngressGatePhase as B, ResolvedChannelMessageIngress as C, AccessGraphGate as D, AccessGraph as E, ChannelIngressPolicyInput as F, InternalMatchMaterial as G, InternalChannelIngressAdapter as H, ChannelIngressState as I, RedactedChannelIngressEvent as J, InternalNormalizedEntry as K, ChannelIngressStateInput as L, ChannelIngressEventInput as M, ChannelIngressIdentifierKind as N, AccessGroupMembershipFact as O, ChannelIngressNormalizedEntry as P, ResolvedIngressAllowlist as Q, IngressGateEffect as R, ResolveStableChannelMessageIngressParams as S, decideChannelIngress as T, InternalChannelIngressNormalizeResult as U, IngressReasonCode as V, InternalChannelIngressSubject as W, RedactedIngressEntryDiagnostic as X, RedactedIngressAllowlistFacts as Y, RedactedIngressMatch as Z, ChannelIngressRouteAccess as _, resolveStableChannelMessageIngress as a, CreateChannelIngressResolverParams as b, ChannelIngressCommandPresetInput as c, ChannelIngressIdentityAlias as d, RouteGateFacts as et, ChannelIngressIdentityDescriptor as f, ChannelIngressResolverMessageParams as g, ChannelIngressResolver as h, resolveChannelMessageIngress as i, ChannelIngressDecision as j, ChannelIngressAdmission as k, ChannelIngressConfigInput as l, ChannelIngressIdentitySubjectInput as m, createChannelIngressResolver as n, RouteSenderAllowlistSource as nt, defineStableChannelIngressIdentity as o, ChannelIngressIdentityField as p, MatchableIdentifier as q, readChannelIngressStoreAllowFromForDmPolicy as r, RouteSenderPolicy as rt, ChannelIngressAccessGroupMembershipResolver as s, channelIngressRoutes as t, RouteGateState as tt, ChannelIngressEventPresetInput as u, ChannelIngressRouteDescriptor as v, StableChannelIngressIdentityParams as w, ResolveChannelMessageIngressParams as x, ChannelMessageIngressCommandInput as y, IngressGateKind as z };