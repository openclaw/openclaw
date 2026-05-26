import { s as normalizeStringEntries } from "../string-normalization-DiPHgdft.js";
import { l as decideChannelIngress, s as resolveChannelIngressState$1 } from "../runtime-BUVuto5K.js";
import "../message-access-1jXjZQRP.js";
//#region src/plugin-sdk/channel-ingress.ts
const CHANNEL_INGRESS_GATE_SELECTORS = {
	command: {
		phase: "command",
		kind: "command"
	},
	activation: {
		phase: "activation",
		kind: "mention"
	},
	dmSender: {
		phase: "sender",
		kind: "dmSender"
	},
	groupSender: {
		phase: "sender",
		kind: "groupSender"
	},
	event: {
		phase: "event",
		kind: "event"
	}
};
function defaultNormalize(value) {
	return value;
}
function normalizeMatchValue(value, normalize) {
	const normalized = normalize(value);
	return normalized == null ? null : normalized.trim() || null;
}
function resolveDangerous(dangerous, entry) {
	return typeof dangerous === "function" ? dangerous(entry) : dangerous;
}
function defaultIngressMatchKey(params) {
	return `${params.kind}:${params.value}`;
}
function findChannelIngressGate(decision, selector) {
	return decision.graph.gates.find((gate) => gate.phase === selector.phase && gate.kind === selector.kind);
}
function findChannelIngressSenderGate(decision, params) {
	return findChannelIngressGate(decision, params.isGroup ? CHANNEL_INGRESS_GATE_SELECTORS.groupSender : CHANNEL_INGRESS_GATE_SELECTORS.dmSender);
}
function findChannelIngressCommandGate(decision) {
	return findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.command);
}
function decideChannelIngressBundle(params) {
	return {
		dm: decideChannelIngress(params.directState, params.basePolicy),
		group: decideChannelIngress(params.groupState, params.basePolicy),
		dmCommand: decideChannelIngress(params.directState, params.commandPolicy),
		groupCommand: decideChannelIngress(params.groupState, params.commandPolicy)
	};
}
function projectGroupPolicy(gate) {
	const policy = gate?.sender?.policy;
	return policy === "open" || policy === "disabled" ? policy : "allowlist";
}
function projectMentionFacts(gate) {
	const activation = gate?.activation;
	if (!activation?.hasMentionFacts) return;
	return {
		canDetectMention: activation.canDetectMention ?? false,
		wasMentioned: activation.wasMentioned ?? false,
		hasAnyMention: activation.hasAnyMention,
		implicitMentionKinds: activation.implicitMentionKinds ? [...activation.implicitMentionKinds] : void 0,
		requireMention: activation.requireMention,
		effectiveWasMentioned: activation.effectiveWasMentioned,
		shouldSkip: activation.shouldSkip
	};
}
function projectDmDecision(decision, dmSender) {
	if (decision.decision === "pairing") return "pairing";
	if (dmSender) return dmSender.allowed ? "allow" : "deny";
	return decision.admission === "drop" ? "deny" : "allow";
}
function projectIngressAccessFacts(decision) {
	const command = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.command);
	const activation = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.activation);
	const dmSender = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.dmSender);
	const groupSender = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.groupSender);
	const event = findChannelIngressGate(decision, CHANNEL_INGRESS_GATE_SELECTORS.event);
	return {
		dm: {
			decision: projectDmDecision(decision, dmSender),
			reason: dmSender?.reasonCode ?? decision.reasonCode,
			allowFrom: [],
			allowlist: dmSender?.allowlist
		},
		group: {
			policy: projectGroupPolicy(groupSender),
			routeAllowed: !decision.graph.gates.some((gate) => gate.phase === "route" && gate.effect === "block-dispatch"),
			senderAllowed: groupSender?.allowed ?? dmSender?.allowed ?? false,
			allowFrom: [],
			requireMention: activation?.activation?.requireMention ?? false,
			allowlist: groupSender?.allowlist
		},
		commands: command?.command ? {
			authorized: command.allowed,
			shouldBlockControlCommand: command.command.shouldBlockControlCommand,
			reasonCode: command.reasonCode,
			useAccessGroups: command.command.useAccessGroups,
			allowTextCommands: command.command.allowTextCommands,
			modeWhenAccessGroupsOff: command.command.modeWhenAccessGroupsOff,
			authorizers: []
		} : void 0,
		event: event?.event ? {
			...event.event,
			authorized: event.allowed,
			reasonCode: event.reasonCode
		} : void 0,
		mentions: projectMentionFacts(activation)
	};
}
function mapChannelIngressDecisionToTurnAdmission(decision, sideEffect) {
	if (decision.admission === "dispatch") return {
		kind: "dispatch",
		reason: decision.reasonCode
	};
	if (decision.admission === "observe") return {
		kind: "observeOnly",
		reason: decision.reasonCode
	};
	if (decision.admission === "pairing-required") return sideEffect.kind === "pairing-reply-sent" ? {
		kind: "handled",
		reason: decision.reasonCode
	} : {
		kind: "drop",
		reason: decision.reasonCode
	};
	if (decision.admission === "skip") return sideEffect.kind === "pending-history-recorded" || sideEffect.kind === "local-event-handled" || sideEffect.kind === "command-reply-sent" ? {
		kind: "handled",
		reason: decision.reasonCode
	} : {
		kind: "drop",
		reason: decision.reasonCode,
		recordHistory: false
	};
	return sideEffect.kind === "local-event-handled" || sideEffect.kind === "command-reply-sent" ? {
		kind: "handled",
		reason: decision.reasonCode
	} : {
		kind: "drop",
		reason: decision.reasonCode
	};
}
function createChannelIngressPluginId(id) {
	const trimmed = id.trim();
	if (!trimmed) throw new Error("Channel ingress plugin id must be non-empty.");
	return trimmed;
}
function createChannelIngressSubject(input) {
	return { identifiers: ("identifiers" in input ? input.identifiers : [input]).map((identifier, index) => ({
		opaqueId: identifier.opaqueId ?? `subject-${index + 1}`,
		kind: identifier.kind ?? "stable-id",
		value: identifier.value,
		dangerous: identifier.dangerous,
		sensitivity: identifier.sensitivity
	})) };
}
function createChannelIngressStringAdapter(params = {}) {
	const kind = params.kind ?? "stable-id";
	const normalizeEntry = params.normalizeEntry ?? defaultNormalize;
	const normalizeSubject = params.normalizeSubject ?? normalizeEntry;
	const isWildcardEntry = params.isWildcardEntry ?? ((entry) => entry === "*");
	return {
		normalizeEntries({ entries }) {
			return {
				matchable: normalizeStringEntries(entries).flatMap((entry, index) => {
					const value = isWildcardEntry(entry) ? "*" : normalizeMatchValue(entry, normalizeEntry);
					if (!value) return [];
					return [{
						opaqueEntryId: params.resolveEntryId?.({
							entry,
							index
						}) ?? `entry-${index + 1}`,
						kind,
						value,
						dangerous: resolveDangerous(params.dangerous, entry),
						sensitivity: params.sensitivity
					}];
				}),
				invalid: [],
				disabled: []
			};
		},
		matchSubject({ subject, entries }) {
			const values = new Set(subject.identifiers.flatMap((identifier) => {
				if (identifier.kind !== kind) return [];
				const value = normalizeMatchValue(identifier.value, normalizeSubject);
				return value ? [value] : [];
			}));
			const matchedEntryIds = entries.filter((entry) => entry.kind === kind && (entry.value === "*" || values.has(entry.value))).map((entry) => entry.opaqueEntryId);
			return {
				matched: matchedEntryIds.length > 0,
				matchedEntryIds
			};
		}
	};
}
function createChannelIngressMultiIdentifierAdapter(params) {
	const getEntryMatchKey = params.getEntryMatchKey ?? defaultIngressMatchKey;
	const getSubjectMatchKeys = params.getSubjectMatchKeys ?? ((identifier) => [defaultIngressMatchKey(identifier)]);
	const isWildcardEntry = params.isWildcardEntry ?? ((entry) => entry.value === "*");
	return {
		normalizeEntries({ entries }) {
			return {
				matchable: entries.flatMap((entry, index) => params.normalizeEntry(entry, index)),
				invalid: [],
				disabled: []
			};
		},
		matchSubject({ subject, entries }) {
			const subjectKeys = new Set(subject.identifiers.flatMap((identifier) => getSubjectMatchKeys(identifier).filter((key) => Boolean(key))));
			const matchedEntryIds = entries.filter((entry) => {
				if (isWildcardEntry(entry)) return true;
				const key = getEntryMatchKey(entry);
				return key ? subjectKeys.has(key) : false;
			}).map((entry) => entry.opaqueEntryId);
			return {
				matched: matchedEntryIds.length > 0,
				matchedEntryIds
			};
		}
	};
}
function assertNeverChannelIngressReason(reasonCode) {
	throw new Error(`Unhandled channel ingress reason code: ${String(reasonCode)}`);
}
/** @deprecated Use `senderAccess.reasonCode` from `resolveChannelMessageIngress(...)` or typed gate selectors. */
function findChannelIngressSenderReasonCode(decision, params) {
	return findChannelIngressSenderGate(decision, params)?.reasonCode ?? decision.reasonCode;
}
/** @deprecated Use `senderAccess.reasonCode` from `resolveChannelMessageIngress(...)`. */
function mapChannelIngressReasonCodeToDmGroupAccessReason(params) {
	switch (params.reasonCode) {
		case "group_policy_open":
		case "group_policy_allowed": return "group_policy_allowed";
		case "group_policy_disabled": return "group_policy_disabled";
		case "route_sender_empty":
		case "group_policy_empty_allowlist": return "group_policy_empty_allowlist";
		case "group_policy_not_allowlisted": return "group_policy_not_allowlisted";
		case "dm_policy_open": return "dm_policy_open";
		case "dm_policy_disabled": return "dm_policy_disabled";
		case "dm_policy_allowlisted": return "dm_policy_allowlisted";
		case "dm_policy_pairing_required": return "dm_policy_pairing_required";
		default: return params.isGroup ? "group_policy_not_allowlisted" : "dm_policy_not_allowlisted";
	}
}
/** @deprecated Use `senderAccess.reason` from `resolveChannelMessageIngress(...)`. */
function formatChannelIngressPolicyReason(params) {
	switch (params.reasonCode) {
		case "group_policy_allowed": return `groupPolicy=${params.groupPolicy}`;
		case "group_policy_disabled": return "groupPolicy=disabled";
		case "group_policy_empty_allowlist": return "groupPolicy=allowlist (empty allowlist)";
		case "group_policy_not_allowlisted": return "groupPolicy=allowlist (not allowlisted)";
		case "dm_policy_open": return "dmPolicy=open";
		case "dm_policy_disabled": return "dmPolicy=disabled";
		case "dm_policy_allowlisted": return `dmPolicy=${params.dmPolicy} (allowlisted)`;
		case "dm_policy_pairing_required": return "dmPolicy=pairing (not allowlisted)";
		case "dm_policy_not_allowlisted": return `dmPolicy=${params.dmPolicy} (not allowlisted)`;
	}
	return params.reasonCode;
}
/** @deprecated Use `senderAccess.groupAccess` from `resolveChannelMessageIngress(...)`. */
function projectChannelIngressSenderGroupAccess(params) {
	const reasonCode = mapChannelIngressReasonCodeToDmGroupAccessReason({
		reasonCode: params.reasonCode,
		isGroup: true
	});
	const reason = params.groupPolicy === "disabled" || reasonCode === "group_policy_disabled" ? "disabled" : reasonCode === "group_policy_empty_allowlist" ? "empty_allowlist" : reasonCode === "group_policy_not_allowlisted" ? "sender_not_allowlisted" : "allowed";
	return {
		allowed: reason === "allowed" && params.decisionAllowed,
		groupPolicy: params.groupPolicy,
		providerMissingFallbackApplied: params.providerMissingFallbackApplied ?? false,
		reason
	};
}
/** @deprecated Use `senderAccess` from `resolveChannelMessageIngress(...)`. */
function projectChannelIngressDmGroupAccess(params) {
	const reasonCode = mapChannelIngressReasonCodeToDmGroupAccessReason({
		reasonCode: findChannelIngressSenderReasonCode(params.ingress, { isGroup: params.isGroup }),
		isGroup: params.isGroup
	});
	return {
		decision: reasonCode === "dm_policy_pairing_required" ? "pairing" : params.ingress.decision === "allow" ? "allow" : "block",
		reasonCode,
		reason: formatChannelIngressPolicyReason({
			reasonCode,
			dmPolicy: params.dmPolicy,
			groupPolicy: params.groupPolicy
		})
	};
}
async function resolveChannelIngressState(input) {
	return await resolveChannelIngressState$1(input);
}
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
async function resolveChannelIngressAccess(params) {
	const { policy, effectiveAllowFrom, effectiveGroupAllowFrom, ...stateInput } = params;
	const state = await resolveChannelIngressState(stateInput);
	const ingress = decideChannelIngress(state, policy);
	const isGroup = params.conversation.kind !== "direct";
	const senderReasonCode = findChannelIngressSenderReasonCode(ingress, { isGroup });
	const access = projectChannelIngressDmGroupAccess({
		ingress,
		isGroup,
		dmPolicy: policy.dmPolicy,
		groupPolicy: policy.groupPolicy
	});
	const commandGate = findChannelIngressCommandGate(ingress);
	return {
		state,
		ingress,
		isGroup,
		senderReasonCode,
		access: {
			...access,
			effectiveAllowFrom: [...effectiveAllowFrom ?? []],
			effectiveGroupAllowFrom: [...effectiveGroupAllowFrom ?? []]
		},
		commandAuthorized: commandGate?.allowed === true,
		shouldBlockControlCommand: commandGate?.command?.shouldBlockControlCommand === true
	};
}
//#endregion
export { CHANNEL_INGRESS_GATE_SELECTORS, assertNeverChannelIngressReason, createChannelIngressMultiIdentifierAdapter, createChannelIngressPluginId, createChannelIngressStringAdapter, createChannelIngressSubject, decideChannelIngress, decideChannelIngressBundle, findChannelIngressCommandGate, findChannelIngressGate, findChannelIngressSenderGate, findChannelIngressSenderReasonCode, formatChannelIngressPolicyReason, mapChannelIngressDecisionToTurnAdmission, mapChannelIngressReasonCodeToDmGroupAccessReason, projectChannelIngressDmGroupAccess, projectChannelIngressSenderGroupAccess, projectIngressAccessFacts, resolveChannelIngressAccess, resolveChannelIngressState };
