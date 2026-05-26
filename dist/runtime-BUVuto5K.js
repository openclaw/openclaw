import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { a as parseAccessGroupAllowFromEntry, i as mergeDmAllowFromSources, o as resolveGroupAllowFromSources } from "./allow-from-D1f7S_rf.js";
import { t as resolveCommandAuthorizedFromAuthorizers } from "./command-gating-BZR3snoF.js";
import { a as readChannelAllowFromStore } from "./pairing-store-jPMfFWFn.js";
import { n as resolveInboundMentionDecision } from "./mention-gating-3P8aSD7o.js";
//#region src/channels/message-access/allowlist.ts
function allowlistFailureReason(allowlist) {
	if (allowlist.accessGroups.failed.length > 0) return "access_group_failed";
	if (allowlist.accessGroups.unsupported.length > 0) return "access_group_unsupported";
	if (allowlist.accessGroups.missing.length > 0) return "access_group_missing";
	return null;
}
function redactedAllowlistDiagnostics(allowlist, reasonCode) {
	return {
		configured: allowlist.hasConfiguredEntries,
		matched: allowlist.match.matched,
		reasonCode,
		matchedEntryIds: allowlist.matchedEntryIds,
		invalidEntryCount: allowlist.invalidEntries.length,
		disabledEntryCount: allowlist.disabledEntries.length,
		accessGroups: allowlist.accessGroups
	};
}
function uniqueStrings(values) {
	return Array.from(new Set(values));
}
function mergeResolvedAllowlists(allowlists) {
	const matches = allowlists.map((allowlist) => allowlist.match);
	const matchedEntryIds = uniqueStrings(allowlists.flatMap((allowlist) => allowlist.matchedEntryIds));
	return {
		rawEntryCount: allowlists.reduce((sum, allowlist) => sum + allowlist.rawEntryCount, 0),
		normalizedEntries: allowlists.flatMap((allowlist) => allowlist.normalizedEntries),
		invalidEntries: allowlists.flatMap((allowlist) => allowlist.invalidEntries),
		disabledEntries: allowlists.flatMap((allowlist) => allowlist.disabledEntries),
		matchedEntryIds,
		hasConfiguredEntries: allowlists.some((allowlist) => allowlist.hasConfiguredEntries),
		hasMatchableEntries: allowlists.some((allowlist) => allowlist.hasMatchableEntries),
		hasWildcard: allowlists.some((allowlist) => allowlist.hasWildcard),
		accessGroups: {
			referenced: uniqueStrings(allowlists.flatMap((allowlist) => allowlist.accessGroups.referenced)),
			matched: uniqueStrings(allowlists.flatMap((allowlist) => allowlist.accessGroups.matched)),
			missing: uniqueStrings(allowlists.flatMap((allowlist) => allowlist.accessGroups.missing)),
			unsupported: uniqueStrings(allowlists.flatMap((allowlist) => allowlist.accessGroups.unsupported)),
			failed: uniqueStrings(allowlists.flatMap((allowlist) => allowlist.accessGroups.failed))
		},
		match: {
			matched: matches.some((match) => match.matched) || matchedEntryIds.length > 0,
			matchedEntryIds
		}
	};
}
function applyMutableIdentifierPolicy(allowlist, policy) {
	if (policy.mutableIdentifierMatching === "enabled") return allowlist;
	const dangerousEntryIds = new Set(allowlist.normalizedEntries.filter((entry) => entry.dangerous).map((entry) => entry.opaqueEntryId));
	if (dangerousEntryIds.size === 0) return allowlist;
	const matchedEntryIds = allowlist.matchedEntryIds.filter((id) => !dangerousEntryIds.has(id));
	const disabledEntries = [...allowlist.disabledEntries, ...allowlist.normalizedEntries.filter((entry) => entry.dangerous).map((entry) => ({
		opaqueEntryId: entry.opaqueEntryId,
		reasonCode: "mutable_identifier_disabled"
	}))];
	return {
		...allowlist,
		disabledEntries,
		matchedEntryIds,
		hasMatchableEntries: allowlist.normalizedEntries.some((entry) => !entry.dangerous),
		match: {
			matched: matchedEntryIds.length > 0,
			matchedEntryIds
		}
	};
}
function effectiveGroupSenderAllowlist(params) {
	let effective = params.policy.groupAllowFromFallbackToAllowFrom && !params.state.allowlists.group.hasConfiguredEntries ? params.state.allowlists.dm : params.state.allowlists.group;
	for (const route of params.state.routeFacts) {
		if (route.gate !== "matched" || !route.senderAllowlist) continue;
		if (route.senderPolicy === "inherit") {
			effective = mergeResolvedAllowlists([effective, route.senderAllowlist]);
			continue;
		}
		effective = route.senderAllowlist;
	}
	return applyMutableIdentifierPolicy(effective, params.policy);
}
//#endregion
//#region src/channels/message-access/sender-gates.ts
function senderGate(params) {
	return {
		id: params.id,
		phase: "sender",
		kind: params.kind,
		effect: params.effect,
		allowed: params.allowed,
		reasonCode: params.reasonCode,
		match: params.match,
		sender: { policy: params.policy },
		allowlist: redactedAllowlistDiagnostics(params.allowlistSource, params.reasonCode)
	};
}
function senderGateForDirect(params) {
	const dm = applyMutableIdentifierPolicy(params.state.allowlists.dm, params.policy);
	const pairingStore = applyMutableIdentifierPolicy(params.state.allowlists.pairingStore, params.policy);
	const base = {
		policy: params.policy.dmPolicy,
		allowlistSource: dm,
		match: dm.match
	};
	const allow = (reasonCode) => senderGate({
		id: "sender:dm",
		kind: "dmSender",
		...base,
		effect: "allow",
		allowed: true,
		reasonCode
	});
	const block = (reasonCode) => senderGate({
		id: "sender:dm",
		kind: "dmSender",
		...base,
		effect: "block-dispatch",
		allowed: false,
		reasonCode
	});
	if (params.policy.dmPolicy === "disabled") return block("dm_policy_disabled");
	if (params.policy.dmPolicy === "open") {
		if (dm.hasWildcard) return allow("dm_policy_open");
		if (dm.match.matched) return allow("dm_policy_allowlisted");
		return block("dm_policy_not_allowlisted");
	}
	if (dm.match.matched) return allow("dm_policy_allowlisted");
	if (params.policy.dmPolicy === "pairing" && pairingStore.match.matched) return senderGate({
		id: "sender:dm",
		kind: "dmSender",
		effect: "allow",
		allowed: true,
		reasonCode: "dm_policy_allowlisted",
		match: pairingStore.match,
		policy: params.policy.dmPolicy,
		allowlistSource: pairingStore
	});
	if (params.policy.dmPolicy === "pairing" && params.state.event.mayPair) return block("dm_policy_pairing_required");
	return block(params.policy.dmPolicy === "pairing" ? "event_pairing_not_allowed" : allowlistFailureReason(dm) ?? "dm_policy_not_allowlisted");
}
function senderGateForGroup(params) {
	const group = effectiveGroupSenderAllowlist(params);
	const base = {
		policy: params.policy.groupPolicy,
		allowlistSource: group,
		match: group.match
	};
	const allow = (reasonCode) => senderGate({
		id: "sender:group",
		kind: "groupSender",
		...base,
		effect: "allow",
		allowed: true,
		reasonCode
	});
	const block = (reasonCode) => senderGate({
		id: "sender:group",
		kind: "groupSender",
		...base,
		effect: "block-dispatch",
		allowed: false,
		reasonCode
	});
	if (params.policy.groupPolicy === "disabled") return block("group_policy_disabled");
	if (params.policy.groupPolicy === "open") return allow("group_policy_open");
	if (!group.hasConfiguredEntries) return block("group_policy_empty_allowlist");
	if (group.match.matched) return allow("group_policy_allowed");
	return block(allowlistFailureReason(group) ?? "group_policy_not_allowlisted");
}
function applyEventAuthModeToSenderGate(params) {
	if (params.state.event.authMode === "inbound" || params.senderGate.allowed) return params.senderGate;
	const reasonCode = "sender_not_required";
	return {
		...params.senderGate,
		effect: "ignore",
		allowed: true,
		reasonCode,
		allowlist: params.senderGate.allowlist ? {
			...params.senderGate.allowlist,
			reasonCode
		} : void 0
	};
}
//#endregion
//#region src/channels/message-access/decision.ts
function decisiveDecision(params) {
	return {
		admission: params.admission,
		decision: params.decision,
		decisiveGateId: params.gate.id,
		reasonCode: params.gate.reasonCode,
		graph: { gates: params.gates }
	};
}
function routeGates(state) {
	return state.routeFacts.map((route) => ({
		id: route.id,
		phase: "route",
		kind: route.kind,
		effect: route.effect,
		allowed: route.effect !== "block-dispatch",
		reasonCode: route.effect === "block-dispatch" ? "route_blocked" : "allowed",
		match: route.match
	}));
}
function routeSenderEmptyGate(state) {
	const route = state.routeFacts.find((fact) => fact.senderPolicy === "deny-when-empty" && fact.gate === "matched" && fact.senderAllowlist?.hasConfiguredEntries !== true);
	if (!route) return null;
	const reasonCode = "route_sender_empty";
	return {
		id: `${route.id}:sender`,
		phase: "route",
		kind: "routeSender",
		effect: "block-dispatch",
		allowed: false,
		reasonCode,
		match: route.match,
		allowlist: route.senderAllowlist ? redactedAllowlistDiagnostics(route.senderAllowlist, reasonCode) : void 0
	};
}
function commandGate(params) {
	const command = params.policy.command;
	if (!command) return {
		id: "command",
		phase: "command",
		kind: "command",
		effect: "allow",
		allowed: true,
		reasonCode: "command_authorized"
	};
	const useAccessGroups = command.useAccessGroups ?? true;
	const owner = applyMutableIdentifierPolicy(params.state.allowlists.commandOwner, params.policy);
	const group = applyMutableIdentifierPolicy(params.state.allowlists.commandGroup, params.policy);
	const authorized = resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups,
		modeWhenAccessGroupsOff: command.modeWhenAccessGroupsOff,
		authorizers: [{
			configured: owner.hasConfiguredEntries,
			allowed: owner.match.matched
		}, {
			configured: group.hasConfiguredEntries,
			allowed: group.match.matched
		}]
	});
	const shouldBlock = command.allowTextCommands && command.hasControlCommand && !authorized;
	return {
		id: "command",
		phase: "command",
		kind: "command",
		effect: shouldBlock ? "block-command" : "allow",
		allowed: authorized,
		reasonCode: shouldBlock ? "control_command_unauthorized" : "command_authorized",
		match: mergeCommandMatch(owner.match, group.match),
		command: {
			useAccessGroups,
			allowTextCommands: command.allowTextCommands,
			modeWhenAccessGroupsOff: command.modeWhenAccessGroupsOff,
			shouldBlockControlCommand: shouldBlock
		}
	};
}
function mergeCommandMatch(owner, group) {
	const matchedEntryIds = Array.from(new Set([...owner.matchedEntryIds, ...group.matchedEntryIds]));
	return {
		matched: owner.matched || group.matched || matchedEntryIds.length > 0,
		matchedEntryIds
	};
}
function eventGate(params) {
	const authMode = params.state.event.authMode;
	const event = params.state.event;
	const eventResult = (allowed, reasonCode) => ({
		id: "event",
		phase: "event",
		kind: "event",
		effect: allowed ? "allow" : "block-dispatch",
		allowed,
		reasonCode,
		event
	});
	if (authMode === "none" || authMode === "route-only") return eventResult(true, "event_authorized");
	if (authMode === "command") return eventResult(params.commandGate.allowed, params.commandGate.allowed ? "event_authorized" : "event_unauthorized");
	if (authMode === "origin-subject") {
		if (!params.state.event.hasOriginSubject) return eventResult(false, "origin_subject_missing");
		const matched = params.state.event.originSubjectMatched;
		return eventResult(matched, matched ? "event_authorized" : "origin_subject_not_matched");
	}
	return eventResult(params.senderGate.allowed, params.senderGate.allowed ? "event_authorized" : "event_unauthorized");
}
function activationMetadata(params) {
	const mentionFacts = params.mentionFacts;
	return {
		hasMentionFacts: mentionFacts != null,
		requireMention: params.activation?.requireMention ?? false,
		allowTextCommands: params.activation?.allowTextCommands ?? false,
		...params.activation?.allowedImplicitMentionKinds !== void 0 ? { allowedImplicitMentionKinds: params.activation.allowedImplicitMentionKinds } : {},
		...params.activation?.order ? { order: params.activation.order } : {},
		shouldSkip: params.shouldSkip,
		...mentionFacts?.canDetectMention !== void 0 ? { canDetectMention: mentionFacts.canDetectMention } : {},
		...mentionFacts?.wasMentioned !== void 0 ? { wasMentioned: mentionFacts.wasMentioned } : {},
		...mentionFacts?.hasAnyMention !== void 0 ? { hasAnyMention: mentionFacts.hasAnyMention } : {},
		...mentionFacts?.implicitMentionKinds !== void 0 ? { implicitMentionKinds: mentionFacts.implicitMentionKinds } : {},
		...params.effectiveWasMentioned !== void 0 ? { effectiveWasMentioned: params.effectiveWasMentioned } : {},
		...params.shouldBypassMention !== void 0 ? { shouldBypassMention: params.shouldBypassMention } : {}
	};
}
function activationGate(params) {
	const activation = params.policy.activation;
	const mentionFacts = params.state.mentionFacts;
	const activationResult = (input) => ({
		id: "activation",
		phase: "activation",
		kind: "mention",
		effect: input.shouldSkip ? "skip" : "allow",
		allowed: !input.shouldSkip,
		reasonCode: input.shouldSkip ? "activation_skipped" : "activation_allowed",
		activation: activationMetadata({
			activation,
			mentionFacts,
			shouldSkip: input.shouldSkip,
			effectiveWasMentioned: input.effectiveWasMentioned,
			shouldBypassMention: input.shouldBypassMention
		})
	});
	if (!activation || !mentionFacts) return activationResult({
		shouldSkip: false,
		effectiveWasMentioned: mentionFacts && (mentionFacts.wasMentioned || Boolean(mentionFacts.implicitMentionKinds?.length))
	});
	const result = resolveInboundMentionDecision({
		facts: mentionFacts,
		policy: {
			isGroup: params.state.conversationKind !== "direct",
			requireMention: activation.requireMention,
			allowedImplicitMentionKinds: activation.allowedImplicitMentionKinds,
			allowTextCommands: activation.allowTextCommands,
			hasControlCommand: params.policy.command?.hasControlCommand ?? false,
			commandAuthorized: params.commandGate.allowed
		}
	});
	return activationResult({
		shouldSkip: result.shouldSkip,
		effectiveWasMentioned: result.effectiveWasMentioned,
		shouldBypassMention: result.shouldBypassMention
	});
}
function decideChannelIngress(state, policy) {
	const gates = routeGates(state);
	const emptyRouteSenderGate = routeSenderEmptyGate(state);
	if (emptyRouteSenderGate) gates.push(emptyRouteSenderGate);
	const routeBlock = gates.find((entry) => entry.effect === "block-dispatch");
	if (routeBlock) return decisiveDecision({
		admission: "drop",
		decision: "block",
		gate: routeBlock,
		gates
	});
	const activationBeforeSender = policy.activation?.order === "before-sender" && !policy.activation.allowTextCommands ? activationGate({
		state,
		policy,
		commandGate: commandGate({
			state,
			policy: {
				...policy,
				command: void 0
			}
		})
	}) : null;
	if (activationBeforeSender) {
		gates.push(activationBeforeSender);
		if (activationBeforeSender.effect === "skip") return decisiveDecision({
			admission: "skip",
			decision: "allow",
			gate: activationBeforeSender,
			gates
		});
	}
	const eventModeSender = applyEventAuthModeToSenderGate({
		state,
		senderGate: state.conversationKind === "direct" ? senderGateForDirect({
			state,
			policy
		}) : senderGateForGroup({
			state,
			policy
		})
	});
	gates.push(eventModeSender);
	if (!eventModeSender.allowed) return decisiveDecision({
		admission: eventModeSender.reasonCode === "dm_policy_pairing_required" ? "pairing-required" : "drop",
		decision: eventModeSender.reasonCode === "dm_policy_pairing_required" ? "pairing" : "block",
		gate: eventModeSender,
		gates
	});
	const command = commandGate({
		state,
		policy
	});
	gates.push(command);
	if (command.effect === "block-command") return decisiveDecision({
		admission: "drop",
		decision: "block",
		gate: command,
		gates
	});
	const event = eventGate({
		state,
		senderGate: eventModeSender,
		commandGate: command
	});
	gates.push(event);
	if (!event.allowed) return decisiveDecision({
		admission: "drop",
		decision: "block",
		gate: event,
		gates
	});
	const activation = activationBeforeSender ?? activationGate({
		state,
		policy,
		commandGate: command
	});
	if (!activationBeforeSender) gates.push(activation);
	if (activation.effect === "skip") return decisiveDecision({
		admission: "skip",
		decision: "allow",
		gate: activation,
		gates
	});
	if (activation.effect === "observe") return decisiveDecision({
		admission: "observe",
		decision: "allow",
		gate: activation,
		gates
	});
	return decisiveDecision({
		admission: "dispatch",
		decision: "allow",
		gate: activation,
		gates
	});
}
//#endregion
//#region src/channels/message-access/runtime-access-groups.ts
function uniqueValues(values) {
	return Array.from(new Set(values));
}
function accessGroupNames(entries) {
	return Array.from(new Set(entries.map((entry) => parseAccessGroupAllowFromEntry(String(entry))).filter((entry) => entry != null)));
}
function allReferencedAccessGroupNames(entries) {
	return Array.from(new Set(entries.flatMap((entryGroup) => accessGroupNames(entryGroup))));
}
async function normalizeEffectiveEntries(params) {
	const rawEntries = normalizeStringEntries(params.entries);
	const accessGroupEntries = rawEntries.filter((entry) => parseAccessGroupAllowFromEntry(entry) != null);
	const directEntries = rawEntries.filter((entry) => parseAccessGroupAllowFromEntry(entry) == null);
	if (directEntries.length === 0) return accessGroupEntries;
	const normalized = await params.adapter.normalizeEntries({
		entries: directEntries,
		context: params.context,
		accountId: params.accountId
	});
	return uniqueValues([...accessGroupEntries, ...normalized.matchable.map((entry) => entry.value)]);
}
async function resolveRuntimeAccessGroupMembershipFacts(params) {
	if (!params.input.resolveAccessGroupMembership || params.names.length === 0) return [];
	const facts = [];
	for (const name of params.names) {
		const group = params.input.accessGroups?.[name];
		if (!group || group.type === "message.senders") continue;
		try {
			const matched = await params.input.resolveAccessGroupMembership({
				name,
				group,
				channelId: params.channelId,
				accountId: params.input.accountId,
				subject: params.input.subject
			});
			facts.push(matched ? {
				kind: "matched",
				groupName: name,
				source: "dynamic",
				matchedEntryIds: [`access-group:${name}`]
			} : {
				kind: "not-matched",
				groupName: name,
				source: "dynamic"
			});
		} catch {
			facts.push({
				kind: "failed",
				groupName: name,
				source: "dynamic",
				reasonCode: "access_group_failed",
				diagnosticId: `access-group:${name}`
			});
		}
	}
	return facts;
}
//#endregion
//#region src/channels/message-access/runtime-identity.ts
/** Build an identity descriptor for channels with one stable id and optional aliases. */
function defineStableChannelIngressIdentity(params = {}) {
	const { entryIdPrefix, resolveEntryId, aliases, isWildcardEntry, matchEntry, ...primary } = params;
	return {
		primary,
		aliases,
		isWildcardEntry,
		matchEntry,
		resolveEntryId: resolveEntryId ?? (entryIdPrefix ? ({ entryIndex }) => `${entryIdPrefix}-${entryIndex + 1}` : void 0)
	};
}
function defaultNormalize(value) {
	return value;
}
function normalizeFieldValue(field, value, mode) {
	const normalized = (mode === "entry" ? field.normalizeEntry ?? field.normalize ?? defaultNormalize : field.normalizeSubject ?? field.normalize ?? defaultNormalize)(value);
	return normalized == null ? null : normalized.trim() || null;
}
function fieldDangerous(field, value) {
	return typeof field.dangerous === "function" ? field.dangerous(value) : field.dangerous;
}
function identityFields(identity) {
	const fields = [{
		...identity.primary,
		key: identity.primary.key ?? "stableId",
		kind: identity.primary.kind ?? "stable-id"
	}];
	for (const alias of identity.aliases ?? []) fields.push({
		...alias,
		kind: alias.kind ?? `plugin:${alias.key}`
	});
	return fields;
}
function identityMatchKey(entry) {
	return `${entry.kind}:${entry.value}`;
}
function adapterEntry(params) {
	return {
		opaqueEntryId: params.identity.resolveEntryId?.({
			entry: params.entry,
			entryIndex: params.entryIndex,
			fieldKey: params.field.key,
			fieldIndex: params.fieldIndex
		}) ?? `entry-${params.entryIndex + 1}:${params.fallbackSuffix ?? params.field.key}`,
		kind: params.field.kind,
		value: params.value,
		dangerous: fieldDangerous(params.field, params.entry),
		sensitivity: params.field.sensitivity
	};
}
function createIdentityAdapter(identity) {
	const fields = identityFields(identity);
	const isWildcardEntry = identity.isWildcardEntry ?? ((value) => value === "*");
	return {
		normalizeEntries({ entries }) {
			return {
				matchable: entries.flatMap((entry, entryIndex) => {
					if (isWildcardEntry(entry)) return [adapterEntry({
						identity,
						field: fields[0],
						fieldIndex: 0,
						entry,
						entryIndex,
						value: "*",
						fallbackSuffix: "wildcard"
					})];
					return fields.flatMap((field, fieldIndex) => {
						const value = normalizeFieldValue(field, entry, "entry");
						if (!value) return [];
						return [adapterEntry({
							identity,
							field,
							fieldIndex,
							entry,
							entryIndex,
							value
						})];
					});
				}),
				invalid: [],
				disabled: []
			};
		},
		matchSubject({ subject, entries, context }) {
			const subjectKeys = new Set(subject.identifiers.flatMap((identifier) => {
				const field = fields.find((candidate) => candidate.kind === identifier.kind);
				if (!field) return [];
				const value = normalizeFieldValue(field, identifier.value, "subject");
				return value ? [identityMatchKey({
					kind: identifier.kind,
					value
				})] : [];
			}));
			const matchedEntryIds = entries.filter((entry) => {
				const fallback = entry.value === "*" || subjectKeys.has(identityMatchKey(entry));
				return identity.matchEntry?.({
					subject,
					entry,
					context
				}) ?? fallback;
			}).map((entry) => entry.opaqueEntryId);
			return {
				matched: matchedEntryIds.length > 0,
				matchedEntryIds
			};
		}
	};
}
function createIdentitySubject(identity, input) {
	return { identifiers: identityFields(identity).flatMap((field, index) => {
		const rawValue = index === 0 ? input.stableId : input.aliases?.[field.key];
		if (rawValue == null) return [];
		const value = String(rawValue);
		return [{
			opaqueId: field.key,
			kind: field.kind,
			value,
			dangerous: fieldDangerous(field, value),
			sensitivity: field.sensitivity
		}];
	}) };
}
//#endregion
//#region src/channels/message-access/state.ts
function redactedEntries(entries) {
	return entries.map(({ value: _value, ...entry }) => entry);
}
function emptyMatch() {
	return {
		matched: false,
		matchedEntryIds: []
	};
}
function mergeMatches(matches) {
	const matchedEntryIds = Array.from(new Set(matches.flatMap((match) => match.matchedEntryIds)));
	return {
		matched: matches.some((match) => match.matched) || matchedEntryIds.length > 0,
		matchedEntryIds
	};
}
function mergeDiagnostics(...groups) {
	const diagnostics = [];
	for (const group of groups) if (group) diagnostics.push(...group);
	return diagnostics;
}
function accessGroupFactByName(facts) {
	return new Map((facts ?? []).map((fact) => [fact.groupName, fact]));
}
async function normalizeAndMatch(params) {
	if (params.entries.length === 0) return {
		normalizedEntries: [],
		invalidEntries: [],
		disabledEntries: [],
		match: emptyMatch()
	};
	const normalized = await params.adapter.normalizeEntries({
		entries: params.entries,
		context: params.context,
		accountId: params.accountId
	});
	const match = normalized.matchable.length > 0 ? await params.adapter.matchSubject({
		subject: params.subject,
		entries: normalized.matchable,
		context: params.context
	}) : emptyMatch();
	return {
		normalizedEntries: redactedEntries(normalized.matchable),
		invalidEntries: normalized.invalid,
		disabledEntries: normalized.disabled,
		match
	};
}
function referencedAccessGroups(entries) {
	return Array.from(new Set(entries.map((entry) => parseAccessGroupAllowFromEntry(entry)).filter((entry) => entry != null)));
}
function directAllowlistEntries(entries) {
	return entries.filter((entry) => parseAccessGroupAllowFromEntry(entry) == null);
}
function groupSenderEntries(params) {
	const group = params.input.accessGroups?.[params.groupName];
	if (!group || group.type !== "message.senders") return [];
	return normalizeStringEntries([...group.members["*"] ?? [], ...group.members[params.input.channelId] ?? []]);
}
function eventSubjectMatchContext(input) {
	return input.conversation.kind === "direct" ? "dm" : "group";
}
async function normalizeSubjectIdentifiersForMatch(params) {
	return (await Promise.all(params.subject.identifiers.map(async (identifier, identifierIndex) => {
		return (await params.input.adapter.normalizeEntries({
			entries: [identifier.value],
			context: params.context,
			accountId: params.input.accountId
		})).matchable.filter((entry) => entry.kind === identifier.kind && entry.value !== "*").map((entry, entryIndex) => ({
			opaqueEntryId: `${params.opaquePrefix}-${identifierIndex + 1}:${entryIndex + 1}`,
			kind: entry.kind,
			value: entry.value,
			dangerous: entry.dangerous,
			sensitivity: entry.sensitivity
		}));
	}))).flat();
}
async function originSubjectMatched(input) {
	const origin = input.event.originSubject;
	if (!origin) return false;
	if (origin.identifiers.some((identifier) => input.subject.identifiers.some((current) => current.kind === identifier.kind && current.value === identifier.value))) return true;
	const context = eventSubjectMatchContext(input);
	const originEntries = await normalizeSubjectIdentifiersForMatch({
		input,
		subject: origin,
		context,
		opaquePrefix: "origin"
	});
	if (originEntries.length > 0) {
		if ((await input.adapter.matchSubject({
			subject: input.subject,
			entries: originEntries,
			context
		})).matched) return true;
	}
	const currentEntries = await normalizeSubjectIdentifiersForMatch({
		input,
		subject: input.subject,
		context,
		opaquePrefix: "current"
	});
	if (currentEntries.length === 0) return false;
	return (await input.adapter.matchSubject({
		subject: origin,
		entries: currentEntries,
		context
	})).matched;
}
async function resolveAccessGroupEntries(params) {
	const factByName = accessGroupFactByName(params.input.accessGroupMembership);
	const accessGroups = {
		referenced: [...params.referenced],
		matched: [],
		missing: [],
		unsupported: [],
		failed: []
	};
	const normalizedEntries = [];
	const invalidEntries = [];
	const disabledEntries = [];
	const matches = [];
	for (const groupName of params.referenced) {
		const fact = factByName.get(groupName);
		if (fact?.kind === "matched") {
			accessGroups.matched.push(groupName);
			matches.push({
				matched: true,
				matchedEntryIds: fact.matchedEntryIds
			});
			continue;
		}
		if (fact?.kind === "missing" || fact?.kind === "unsupported" || fact?.kind === "failed") {
			accessGroups[fact.kind].push(groupName);
			continue;
		}
		if (fact?.kind === "not-matched") continue;
		const group = params.input.accessGroups?.[groupName];
		if (!group) {
			accessGroups.missing.push(groupName);
			continue;
		}
		if (group.type !== "message.senders") {
			accessGroups.unsupported.push(groupName);
			continue;
		}
		const groupEntries = groupSenderEntries({
			groupName,
			input: params.input
		});
		const resolved = await normalizeAndMatch({
			adapter: params.input.adapter,
			subject: params.input.subject,
			accountId: params.input.accountId,
			entries: groupEntries,
			context: params.context
		});
		normalizedEntries.push(...resolved.normalizedEntries);
		invalidEntries.push(...resolved.invalidEntries);
		disabledEntries.push(...resolved.disabledEntries);
		if (resolved.match.matched) {
			accessGroups.matched.push(groupName);
			matches.push(resolved.match);
		}
	}
	return {
		normalizedEntries,
		invalidEntries,
		disabledEntries,
		matches,
		accessGroups
	};
}
async function resolveIngressAllowlist(params) {
	const entries = normalizeStringEntries(params.rawEntries ?? []);
	const referenced = referencedAccessGroups(entries);
	const directEntries = directAllowlistEntries(entries);
	const direct = await normalizeAndMatch({
		adapter: params.input.adapter,
		subject: params.input.subject,
		accountId: params.input.accountId,
		entries: directEntries,
		context: params.context
	});
	const groups = await resolveAccessGroupEntries({
		input: params.input,
		context: params.context,
		referenced
	});
	const match = mergeMatches([direct.match, ...groups.matches]);
	return {
		rawEntryCount: entries.length,
		normalizedEntries: [...direct.normalizedEntries, ...groups.normalizedEntries],
		invalidEntries: mergeDiagnostics(direct.invalidEntries, groups.invalidEntries),
		disabledEntries: mergeDiagnostics(direct.disabledEntries, groups.disabledEntries),
		matchedEntryIds: match.matchedEntryIds,
		hasConfiguredEntries: entries.length > 0,
		hasMatchableEntries: direct.normalizedEntries.length > 0 || groups.normalizedEntries.length > 0,
		hasWildcard: directEntries.includes("*"),
		accessGroups: groups.accessGroups,
		match
	};
}
async function resolveRouteFacts(input) {
	const routeFacts = [...input.routeFacts ?? []].toSorted((left, right) => left.precedence - right.precedence || left.id.localeCompare(right.id));
	const resolved = [];
	for (const route of routeFacts) {
		const senderAllowFrom = route.senderAllowFrom ?? (route.senderAllowFromSource === "effective-dm" ? input.allowlists.dm : route.senderAllowFromSource === "effective-group" ? input.allowlists.group : void 0);
		resolved.push({
			id: route.id,
			kind: route.kind,
			gate: route.gate,
			effect: route.effect,
			precedence: route.precedence,
			senderPolicy: route.senderPolicy,
			match: route.match,
			senderAllowlist: senderAllowFrom != null ? await resolveIngressAllowlist({
				input,
				rawEntries: senderAllowFrom,
				context: "route"
			}) : void 0
		});
	}
	return resolved;
}
async function resolveChannelIngressState(input) {
	const [dm, pairingStore, group, commandOwner, commandGroup, routeFacts, eventOriginMatched] = await Promise.all([
		resolveIngressAllowlist({
			input,
			rawEntries: input.allowlists.dm,
			context: "dm"
		}),
		resolveIngressAllowlist({
			input,
			rawEntries: input.allowlists.pairingStore,
			context: "dm"
		}),
		resolveIngressAllowlist({
			input,
			rawEntries: input.allowlists.group,
			context: "group"
		}),
		resolveIngressAllowlist({
			input,
			rawEntries: input.allowlists.commandOwner,
			context: "command"
		}),
		resolveIngressAllowlist({
			input,
			rawEntries: input.allowlists.commandGroup,
			context: "command"
		}),
		resolveRouteFacts(input),
		originSubjectMatched(input)
	]);
	return {
		channelId: input.channelId,
		accountId: input.accountId,
		conversationKind: input.conversation.kind,
		event: {
			kind: input.event.kind,
			authMode: input.event.authMode,
			mayPair: input.event.mayPair,
			hasOriginSubject: input.event.originSubject != null,
			originSubjectMatched: eventOriginMatched
		},
		mentionFacts: input.mentionFacts,
		routeFacts,
		allowlists: {
			dm,
			pairingStore,
			group,
			commandOwner,
			commandGroup
		}
	};
}
//#endregion
//#region src/channels/message-access/runtime.ts
function shouldReadStore(params) {
	return params.conversationKind === "direct" && params.dmPolicy !== "allowlist" && params.dmPolicy !== "open";
}
/**
* Merge configured direct, group, and pairing-store allowlists into the
* effective lists consumed by sender and context-visibility checks.
*/
function resolveChannelIngressEffectiveAllowFromLists(params) {
	const allowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : void 0;
	const groupAllowFrom = Array.isArray(params.groupAllowFrom) ? params.groupAllowFrom : void 0;
	return {
		effectiveAllowFrom: normalizeStringEntries(mergeDmAllowFromSources({
			allowFrom,
			storeAllowFrom: Array.isArray(params.storeAllowFrom) ? params.storeAllowFrom : void 0,
			dmPolicy: params.dmPolicy ?? void 0
		})),
		effectiveGroupAllowFrom: normalizeStringEntries(resolveGroupAllowFromSources({
			allowFrom,
			groupAllowFrom,
			fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? void 0
		}))
	};
}
/**
* Read pairing-store allowlist entries when a direct-message policy permits
* store fallback.
*/
async function readChannelIngressStoreAllowFromForDmPolicy(params) {
	if (params.shouldRead === false || params.dmPolicy === "allowlist" || params.dmPolicy === "open") return [];
	return await (params.readStore ?? ((provider, accountId) => readChannelAllowFromStore(provider, process.env, accountId)))(params.provider, params.accountId).catch(() => []);
}
async function readStoreAllowFrom(params) {
	if (!shouldReadStore({
		conversationKind: params.conversation.kind,
		dmPolicy: params.policy.dmPolicy
	})) return [];
	return [...(params.readStoreAllowFrom ? await params.readStoreAllowFrom({
		channelId: params.channelId,
		accountId: params.accountId,
		dmPolicy: params.policy.dmPolicy
	}).catch(() => []) : params.useDefaultPairingStore ? await readChannelIngressStoreAllowFromForDmPolicy({
		provider: params.channelId,
		accountId: params.accountId,
		dmPolicy: params.policy.dmPolicy
	}) : []) ?? []];
}
function commandRequested(policy) {
	return policy.command != null;
}
function normalizeChannelId(id) {
	const trimmed = id.trim();
	if (!trimmed) throw new Error("Channel ingress channel id must be non-empty.");
	return trimmed;
}
function findIngressGate(params) {
	return params.ingress.graph.gates.find((gate) => gate.phase === params.phase && gate.kind === params.kind);
}
function findSenderGate(ingress, isGroup) {
	return findIngressGate({
		ingress,
		phase: "sender",
		kind: isGroup ? "groupSender" : "dmSender"
	});
}
function useAccessGroupsFromConfig(params) {
	return params.useAccessGroups ?? params.cfg?.commands?.useAccessGroups !== false;
}
function channelIngressCommand(params = {}) {
	if (params.requested === false) return;
	const { requested: _requested, cfg, ...command } = params;
	return {
		...command,
		useAccessGroups: useAccessGroupsFromConfig({
			useAccessGroups: params.useAccessGroups,
			cfg
		}),
		allowTextCommands: params.allowTextCommands ?? false,
		hasControlCommand: params.hasControlCommand ?? true
	};
}
function channelIngressEvent(params = {}) {
	const isGroup = params.isGroup ?? false;
	return {
		kind: params.kind ?? "message",
		authMode: params.authMode ?? "inbound",
		mayPair: params.mayPair ?? !isGroup,
		...params.originSubject ? { originSubject: params.originSubject } : {}
	};
}
function resolveCommandInput(params) {
	if (params.command === false || params.command == null) return;
	return channelIngressCommand({
		...params.command,
		useAccessGroups: params.command.useAccessGroups ?? params.useAccessGroups
	});
}
function resolveResolverPolicy(params) {
	return {
		dmPolicy: params.input.dmPolicy ?? params.base.defaultDmPolicy ?? "pairing",
		groupPolicy: params.input.groupPolicy ?? params.base.defaultGroupPolicy ?? "disabled",
		groupAllowFromFallbackToAllowFrom: params.input.policy?.groupAllowFromFallbackToAllowFrom ?? params.base.groupAllowFromFallbackToAllowFrom,
		mutableIdentifierMatching: params.input.policy?.mutableIdentifierMatching ?? params.base.mutableIdentifierMatching,
		...params.input.policy?.activation ? { activation: params.input.policy.activation } : {}
	};
}
/**
* Create a reusable ingress resolver for one channel account and identity
* descriptor.
*/
function createChannelIngressResolver(base) {
	const resolve = async (input, eventDefaults) => {
		const isGroup = input.conversation.kind !== "direct";
		const useAccessGroups = useAccessGroupsFromConfig({
			useAccessGroups: base.useAccessGroups,
			cfg: base.cfg
		});
		return await resolveChannelMessageIngress({
			channelId: base.channelId,
			accountId: base.accountId,
			identity: base.identity,
			subject: input.subject,
			conversation: input.conversation,
			event: channelIngressEvent({
				isGroup,
				...eventDefaults,
				...input.event
			}),
			policy: resolveResolverPolicy({
				base,
				input
			}),
			allowFrom: input.allowFrom,
			groupAllowFrom: input.groupAllowFrom,
			route: input.route,
			routeFacts: input.routeFacts,
			accessGroups: base.accessGroups ?? base.cfg?.accessGroups,
			accessGroupMembership: [...base.accessGroupMembership ?? [], ...input.accessGroupMembership ?? []],
			resolveAccessGroupMembership: base.resolveAccessGroupMembership,
			accessGroupMatchedAllowFromEntry: base.accessGroupMatchedAllowFromEntry,
			providerMissingFallbackApplied: input.providerMissingFallbackApplied,
			mentionFacts: input.mentionFacts,
			readStoreAllowFrom: base.readStoreAllowFrom,
			useDefaultPairingStore: base.useDefaultPairingStore,
			command: resolveCommandInput({
				command: input.command,
				useAccessGroups
			})
		});
	};
	return {
		message: async (input) => await resolve(input),
		command: async (input) => await resolve(input, {
			authMode: "command",
			mayPair: false
		}),
		event: async (input) => await resolve(input, { mayPair: false })
	};
}
/**
* Resolve one inbound event using a simple stable subject identity descriptor.
*/
async function resolveStableChannelMessageIngress(params) {
	return await createChannelIngressResolver({
		...params,
		identity: defineStableChannelIngressIdentity(params.identity)
	}).message(params);
}
function routeDescriptors(route) {
	if (!route) return [];
	if (Array.isArray(route)) return [...route];
	return [route];
}
/**
* Collect optional route descriptors while dropping false, null, and undefined
* entries.
*/
function channelIngressRoutes(...routes) {
	return routes.filter((route) => Boolean(route));
}
function routeDescriptorMatch(descriptor) {
	const matched = descriptor.matched ?? descriptor.allowed ?? descriptor.enabled !== false;
	return {
		matched,
		matchedEntryIds: matched && descriptor.matchId ? [descriptor.matchId] : []
	};
}
function routeFact(params) {
	return {
		id: params.id,
		kind: params.kind ?? "route",
		gate: params.gate,
		effect: params.effect,
		precedence: params.precedence ?? 0,
		senderPolicy: params.senderPolicy ?? "inherit",
		senderAllowFrom: params.senderAllowFrom,
		senderAllowFromSource: params.senderAllowFromSource,
		match: params.match
	};
}
function routeFactDefaults(descriptor) {
	return {
		id: descriptor.id,
		...descriptor.kind ? { kind: descriptor.kind } : {},
		...descriptor.precedence !== void 0 ? { precedence: descriptor.precedence } : {},
		...descriptor.senderPolicy ? { senderPolicy: descriptor.senderPolicy } : {},
		...descriptor.senderAllowFrom != null ? { senderAllowFrom: [...descriptor.senderAllowFrom] } : {},
		...descriptor.senderAllowFromSource ? { senderAllowFromSource: descriptor.senderAllowFromSource } : {},
		match: routeDescriptorMatch(descriptor)
	};
}
function routeFactsFromDescriptors(route) {
	return routeDescriptors(route).flatMap((descriptor) => {
		if (descriptor.configured === false) return [];
		const defaults = routeFactDefaults(descriptor);
		if (descriptor.enabled === false) return [routeFact({
			...defaults,
			gate: "disabled",
			effect: "block-dispatch"
		})];
		if (descriptor.allowed !== void 0) return [routeFact({
			...defaults,
			gate: descriptor.allowed ? "matched" : "not-matched",
			effect: descriptor.allowed ? "allow" : "block-dispatch"
		})];
		if (descriptor.senderPolicy !== "deny-when-empty" && descriptor.senderAllowFrom == null && descriptor.senderAllowFromSource == null) return [];
		return [routeFact({
			...defaults,
			kind: descriptor.senderPolicy === "deny-when-empty" ? defaults.kind : "routeSender",
			gate: "matched",
			effect: "allow",
			senderPolicy: descriptor.senderPolicy === "deny-when-empty" ? "deny-when-empty" : defaults.senderPolicy
		})];
	});
}
function routeDescriptorForGate(params) {
	const baseGateId = params.gate.id.endsWith(":sender") ? params.gate.id.slice(0, -7) : params.gate.id;
	return params.descriptors.find((descriptor) => descriptor.id === params.gate.id || descriptor.id === baseGateId);
}
function projectRouteAccess(params) {
	const descriptors = routeDescriptors(params.route);
	const routeBlock = params.ingress.graph.gates.find((entry) => entry.phase === "route" && entry.effect === "block-dispatch");
	if (routeBlock) {
		const descriptor = routeDescriptorForGate({
			descriptors,
			gate: routeBlock
		});
		return {
			allowed: routeBlock.allowed,
			reasonCode: routeBlock.reasonCode,
			...descriptor?.blockReason ? { reason: descriptor.blockReason } : {},
			gate: routeBlock
		};
	}
	const routeSenderReplacement = descriptors.find((descriptor) => descriptor.senderPolicy === "replace" && descriptor.blockReason);
	const senderBlock = params.ingress.graph.gates.find((entry) => entry.phase === "sender" && entry.effect === "block-dispatch");
	if (routeSenderReplacement && senderBlock) return {
		allowed: false,
		reasonCode: senderBlock.reasonCode,
		reason: routeSenderReplacement.blockReason,
		gate: senderBlock
	};
	const gate = params.ingress.graph.gates.find((entry) => entry.phase === "route");
	if (gate) return {
		allowed: gate.allowed,
		reasonCode: gate.reasonCode,
		gate
	};
	return { allowed: true };
}
function projectSenderAccess(params) {
	const gate = findSenderGate(params.ingress, params.isGroup);
	const reasonCode = !gate && params.isGroup && params.ingress.reasonCode === "route_sender_empty" && params.effectiveGroupAllowFrom.length === 0 ? "group_policy_empty_allowlist" : gate?.reasonCode ?? params.ingress.reasonCode;
	const decision = reasonCode === "dm_policy_pairing_required" ? "pairing" : gate?.allowed === true ? "allow" : "block";
	return {
		allowed: decision === "allow",
		decision,
		reasonCode,
		...gate ? { gate } : {},
		effectiveAllowFrom: params.effectiveAllowFrom,
		effectiveGroupAllowFrom: params.effectiveGroupAllowFrom,
		providerMissingFallbackApplied: params.providerMissingFallbackApplied ?? false
	};
}
function projectCommandAccess(params) {
	const gate = findIngressGate({
		ingress: params.ingress,
		phase: "command",
		kind: "command"
	});
	return {
		requested: commandRequested(params.policy),
		authorized: commandRequested(params.policy) ? gate?.allowed === true : false,
		shouldBlockControlCommand: gate?.command?.shouldBlockControlCommand === true,
		reasonCode: gate?.reasonCode ?? params.ingress.reasonCode,
		...gate ? { gate } : {}
	};
}
function projectActivationAccess(params) {
	const gate = findIngressGate({
		ingress: params.ingress,
		phase: "activation",
		kind: "mention"
	});
	return {
		ran: gate != null,
		allowed: gate?.allowed === true,
		shouldSkip: gate?.activation?.shouldSkip === true,
		reasonCode: gate?.reasonCode ?? params.ingress.reasonCode,
		...gate?.activation?.effectiveWasMentioned !== void 0 ? { effectiveWasMentioned: gate.activation.effectiveWasMentioned } : {},
		...gate?.activation?.shouldBypassMention !== void 0 ? { shouldBypassMention: gate.activation.shouldBypassMention } : {},
		...gate ? { gate } : {}
	};
}
function commandOwnerAllowFrom(params) {
	if (params.command?.commandOwnerAllowFrom != null) return params.command.commandOwnerAllowFrom;
	if (!params.isGroup) return params.effectiveAllowFrom;
	return params.command?.groupOwnerAllowFrom === "none" ? [] : params.configuredAllowFrom;
}
function commandGroupAllowFrom(params) {
	if (params.isGroup) return params.effectiveCommandGroupAllowFrom;
	return params.command?.directGroupAllowFrom === "effective" ? params.effectiveCommandGroupAllowFrom : [];
}
function accessGroupMatchedEntry(params) {
	const entry = params.accessGroupMatchedAllowFromEntry ?? params.subject.stableId;
	return entry == null ? null : String(entry);
}
function appendAccessGroupMatchedEntry(params) {
	return params.matchedEntry && params.allowlist.accessGroups.matched.length > 0 ? Array.from(new Set([...params.entries, params.matchedEntry])) : params.entries;
}
/**
* Resolve sender, route, command, event, and activation gates for one inbound
* channel event.
*/
async function resolveChannelMessageIngress(params) {
	const channelId = normalizeChannelId(params.channelId);
	const adapter = createIdentityAdapter(params.identity);
	const subject = createIdentitySubject(params.identity, params.subject);
	const routeFacts = [...routeFactsFromDescriptors(params.route), ...params.routeFacts ?? []];
	const storeAllowFrom = await readStoreAllowFrom({
		...params,
		channelId
	});
	const rawAllowFrom = normalizeStringEntries(params.allowFrom ?? []);
	const rawStoreAllowFrom = normalizeStringEntries(storeAllowFrom);
	const rawGroupAllowFrom = normalizeStringEntries(params.groupAllowFrom ?? []);
	const normalizeEffective = (entries, context) => normalizeEffectiveEntries({
		adapter,
		accountId: params.accountId,
		entries,
		context
	});
	const [normalizedAllowFrom, normalizedStoreAllowFrom, normalizedGroupAllowFrom] = await Promise.all([
		normalizeEffective(rawAllowFrom, "dm"),
		normalizeEffective(rawStoreAllowFrom, "dm"),
		normalizeEffective(rawGroupAllowFrom, "group")
	]);
	const accessGroupMembership = [...await resolveRuntimeAccessGroupMembershipFacts({
		input: params,
		channelId,
		names: allReferencedAccessGroupNames([
			rawAllowFrom,
			rawGroupAllowFrom,
			rawStoreAllowFrom,
			params.command?.commandOwnerAllowFrom ?? [],
			...routeFacts.map((route) => route.senderAllowFrom ?? [])
		])
	}), ...params.accessGroupMembership ?? []];
	const baseEffective = resolveChannelIngressEffectiveAllowFromLists({
		allowFrom: normalizedAllowFrom,
		groupAllowFrom: normalizedGroupAllowFrom,
		storeAllowFrom: normalizedStoreAllowFrom,
		dmPolicy: params.policy.dmPolicy,
		groupAllowFromFallbackToAllowFrom: params.policy.groupAllowFromFallbackToAllowFrom
	});
	const rawEffective = resolveChannelIngressEffectiveAllowFromLists({
		allowFrom: rawAllowFrom,
		groupAllowFrom: rawGroupAllowFrom,
		storeAllowFrom: rawStoreAllowFrom,
		dmPolicy: params.policy.dmPolicy,
		groupAllowFromFallbackToAllowFrom: params.policy.groupAllowFromFallbackToAllowFrom
	});
	const rawCommandGroup = resolveChannelIngressEffectiveAllowFromLists({
		allowFrom: rawAllowFrom,
		groupAllowFrom: rawGroupAllowFrom,
		dmPolicy: params.policy.dmPolicy,
		groupAllowFromFallbackToAllowFrom: params.command?.commandGroupAllowFromFallbackToAllowFrom ?? params.policy.groupAllowFromFallbackToAllowFrom
	});
	const isGroup = params.conversation.kind !== "direct";
	const policy = {
		...params.policy,
		...params.command !== void 0 ? { command: params.command } : {}
	};
	const state = await resolveChannelIngressState({
		channelId,
		accountId: params.accountId,
		subject,
		conversation: params.conversation,
		adapter,
		accessGroups: params.accessGroups,
		accessGroupMembership,
		routeFacts,
		mentionFacts: params.mentionFacts,
		event: params.event,
		allowlists: {
			dm: rawAllowFrom,
			group: rawEffective.effectiveGroupAllowFrom,
			pairingStore: rawStoreAllowFrom,
			commandOwner: commandOwnerAllowFrom({
				command: params.command,
				isGroup,
				configuredAllowFrom: rawAllowFrom,
				effectiveAllowFrom: rawEffective.effectiveAllowFrom
			}),
			commandGroup: commandGroupAllowFrom({
				command: params.command,
				isGroup,
				effectiveCommandGroupAllowFrom: rawCommandGroup.effectiveGroupAllowFrom
			})
		}
	});
	const ingress = decideChannelIngress(state, policy);
	const matchedAccessGroupEntry = accessGroupMatchedEntry(params);
	return {
		state,
		ingress,
		senderAccess: projectSenderAccess({
			ingress,
			isGroup,
			effectiveAllowFrom: appendAccessGroupMatchedEntry({
				entries: baseEffective.effectiveAllowFrom,
				allowlist: state.allowlists.dm,
				matchedEntry: matchedAccessGroupEntry
			}),
			effectiveGroupAllowFrom: appendAccessGroupMatchedEntry({
				entries: baseEffective.effectiveGroupAllowFrom,
				allowlist: state.allowlists.group,
				matchedEntry: matchedAccessGroupEntry
			}),
			providerMissingFallbackApplied: params.providerMissingFallbackApplied
		}),
		routeAccess: projectRouteAccess({
			ingress,
			route: params.route
		}),
		commandAccess: projectCommandAccess({
			ingress,
			policy
		}),
		activationAccess: projectActivationAccess({ ingress })
	};
}
//#endregion
export { resolveChannelMessageIngress as a, defineStableChannelIngressIdentity as c, resolveChannelIngressEffectiveAllowFromLists as i, decideChannelIngress as l, createChannelIngressResolver as n, resolveStableChannelMessageIngress as o, readChannelIngressStoreAllowFromForDmPolicy as r, resolveChannelIngressState as s, channelIngressRoutes as t };
