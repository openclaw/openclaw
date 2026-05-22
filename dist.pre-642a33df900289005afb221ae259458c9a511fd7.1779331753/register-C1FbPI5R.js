import { r as registerHealthCheck } from "./health-check-registry-C91n923I.js";
import "./health-BDl3Vg9h.js";
import JSON5 from "json5";
import { basename, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
//#region extensions/policy/src/policy-state.ts
const RESERVED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
function policyDocumentHash(policy) {
	return sha256(stableJson(policy));
}
function policyWorkspaceHash(evidence) {
	return sha256(stableJson(evidence));
}
function policyFindingsHash(findings) {
	return sha256(stableJson(findings));
}
function policyAttestationHash(input) {
	return sha256(stableJson(input));
}
function createPolicyAttestation(input) {
	const workspaceHash = policyWorkspaceHash(input.evidence);
	const findingsHash = policyFindingsHash(input.findings);
	return {
		checkedAt: input.checkedAt,
		...input.policyHash === void 0 ? {} : { policy: {
			path: input.policyPath,
			hash: input.policyHash
		} },
		workspace: {
			scope: "policy",
			hash: workspaceHash
		},
		findingsHash,
		attestationHash: policyAttestationHash({
			ok: input.ok,
			policyHash: input.policyHash,
			workspaceHash,
			findingsHash
		})
	};
}
function collectPolicyEvidence(cfg) {
	return { channels: scanPolicyChannels(cfg) };
}
function scanPolicyChannels(cfg) {
	return Object.entries(configuredChannels(cfg)).filter(([id]) => !RESERVED_CHANNEL_CONFIG_KEYS.has(id)).toSorted(([a], [b]) => a.localeCompare(b)).map(([id, value]) => {
		const entry = {
			id,
			provider: id,
			source: `oc://openclaw.config/channels/${id}`
		};
		if (isRecord$1(value) && typeof value.enabled === "boolean") entry.enabled = value.enabled;
		return entry;
	});
}
function configuredChannels(cfg) {
	return isRecord$1(cfg.channels) ? cfg.channels : {};
}
function sha256(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord$1(value)) return `{${Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
	return JSON.stringify(value);
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null;
}
//#endregion
//#region extensions/policy/src/doctor/register.ts
const CHECK_IDS = {
	policyAttestationMismatch: "policy/attestation-hash-mismatch",
	policyDeniedChannelProvider: "policy/channels-denied-provider",
	policyHashMismatch: "policy/policy-hash-mismatch",
	policyInvalidFile: "policy/policy-jsonc-invalid",
	policyMissingFile: "policy/policy-jsonc-missing"
};
const POLICY_CHECK_IDS = [
	CHECK_IDS.policyMissingFile,
	CHECK_IDS.policyInvalidFile,
	CHECK_IDS.policyHashMismatch,
	CHECK_IDS.policyAttestationMismatch,
	CHECK_IDS.policyDeniedChannelProvider
];
let registered = false;
const policyEvaluationCache = /* @__PURE__ */ new WeakMap();
function registerPolicyDoctorChecks(host) {
	if (registered) return;
	const registerHealthCheck$1 = host?.registerHealthCheck ?? registerHealthCheck;
	registerHealthCheck$1(policyMissingFileCheck);
	registerHealthCheck$1(policyInvalidFileCheck);
	registerHealthCheck$1(policyHashMismatchCheck);
	registerHealthCheck$1(policyAttestationMismatchCheck);
	registerHealthCheck$1(policyChannelsDeniedProviderCheck);
	registered = true;
}
function evaluatePolicy(ctx) {
	const cached = policyEvaluationCache.get(ctx);
	if (cached !== void 0) return cached;
	const next = evaluatePolicyUncached(ctx);
	policyEvaluationCache.set(ctx, next);
	return next;
}
const policyMissingFileCheck = {
	id: CHECK_IDS.policyMissingFile,
	kind: "plugin",
	description: "The enabled policy extension has a policy file to verify.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingFile);
	}
};
const policyHashMismatchCheck = {
	id: CHECK_IDS.policyHashMismatch,
	kind: "plugin",
	description: "The policy file matches the configured expected hash.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyHashMismatch);
	}
};
const policyAttestationMismatchCheck = {
	id: CHECK_IDS.policyAttestationMismatch,
	kind: "plugin",
	description: "The current policy check matches the accepted attestation.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyAttestationMismatch);
	}
};
const policyInvalidFileCheck = {
	id: CHECK_IDS.policyInvalidFile,
	kind: "plugin",
	description: "The enabled policy file parses before policy checks run.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyInvalidFile);
	}
};
const policyChannelsDeniedProviderCheck = {
	id: CHECK_IDS.policyDeniedChannelProvider,
	kind: "plugin",
	description: "Configured channels satisfy policy deny rules.",
	source: "policy",
	async detect(ctx) {
		return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedChannelProvider);
	},
	async repair(ctx, findings) {
		if (!workspaceRepairsEnabled(ctx)) return workspaceRepairsDisabledResult("channel config");
		const channelIds = channelIdsFromFindings(findings);
		if (channelIds.length === 0) return {
			status: "skipped",
			reason: "no channel findings matched a configurable channel",
			changes: []
		};
		const next = disableChannels(ctx.cfg, channelIds);
		if (next.changed.length === 0) return {
			status: "skipped",
			reason: "matching channels were already disabled or missing",
			changes: []
		};
		return {
			config: next.config,
			changes: next.changed.map((id) => `Disabled channels.${id}.enabled for policy conformance.`)
		};
	}
};
async function evaluatePolicyUncached(ctx) {
	const settings = policySettings(ctx);
	const policyPath = policyDisplayName(ctx);
	const evidence = collectPolicyEvidence(ctx.cfg);
	const findings = [];
	if (!policyChecksEnabled(ctx, settings)) return {
		policyPath,
		evidence,
		expectedAttestationHash: settings.expectedAttestationHash,
		findings,
		attestedFindings: findings
	};
	const policyFile = await readPolicyFile(ctx);
	if (policyFile === null) {
		findings.push({
			checkId: CHECK_IDS.policyMissingFile,
			severity: "warning",
			message: `${policyPath} is missing for the enabled policy extension.`,
			source: "policy",
			path: policyPath,
			fixHint: `Restore ${policyPath} or add the policy artifact for this workspace.`
		});
		return {
			policyPath,
			evidence,
			expectedAttestationHash: settings.expectedAttestationHash,
			findings,
			attestedFindings: findings
		};
	}
	const parsedPolicy = parsePolicyFile(policyFile.raw);
	if (!parsedPolicy.ok) {
		findings.push(policyParseFinding(policyFile.displayName, policyFile.ocDocName, parsedPolicy));
		return {
			policyPath,
			evidence,
			expectedAttestationHash: settings.expectedAttestationHash,
			findings,
			attestedFindings: findings
		};
	}
	const policy = parsedPolicy.value;
	const policyHash = policyDocumentHash(policy);
	const expectedHash = settings.expectedHash;
	if (typeof expectedHash === "string" && expectedHash.trim() !== "" && policyHash !== expectedHash.trim()) {
		findings.push({
			checkId: CHECK_IDS.policyHashMismatch,
			severity: "error",
			message: `${policyFile.displayName} does not match the configured policy hash.`,
			source: "policy",
			path: policyFile.displayName,
			target: `oc://${policyFile.ocDocName}`,
			requirement: "oc://openclaw.config/plugins/entries/policy/config/expectedHash",
			fixHint: `Restore the approved policy artifact or update plugins.entries.policy.config.expectedHash after review.`
		});
		return {
			policyPath,
			policy: {
				value: policy,
				hash: policyHash
			},
			evidence,
			expectedAttestationHash: settings.expectedAttestationHash,
			findings,
			attestedFindings: findings
		};
	}
	const policyFindings = channelFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence);
	const attestationFindings = policyAttestationFindings(policyFile.displayName, policyHash, evidence, policyFindings, settings);
	if (hasPolicyValidationFinding(policyFindings)) findings.push(...policyFindings);
	else if (attestationFindings.length > 0) findings.push(...attestationFindings);
	else findings.push(...policyFindings);
	return {
		policyPath,
		policy: {
			value: policy,
			hash: policyHash
		},
		evidence,
		expectedAttestationHash: settings.expectedAttestationHash,
		findings,
		attestedFindings: policyFindings
	};
}
function policyParseFinding(policyPath, policyDocName, parseError) {
	return {
		checkId: CHECK_IDS.policyInvalidFile,
		severity: "error",
		message: `${policyPath} could not be parsed: ${parseError.message}`,
		source: "policy",
		path: policyPath,
		target: `oc://${policyDocName}`,
		fixHint: `Fix ${policyPath} so policy conformance checks can run.`
	};
}
function findingsForCheck(evaluation, checkId) {
	return evaluation.findings.filter((finding) => finding.checkId === checkId);
}
function hasPolicyValidationFinding(findings) {
	return findings.some((finding) => finding.checkId === CHECK_IDS.policyInvalidFile);
}
function channelFindings(policy, policyPath, policyDocName, evidence) {
	const invalidRules = invalidChannelDenyRuleFindings(policy, policyPath, policyDocName);
	if (invalidRules.length > 0) return invalidRules;
	const denyRules = readChannelDenyRules(policy, policyDocName);
	if (denyRules.length === 0) return [];
	return evidence.channels.flatMap((channel) => {
		if (channel.enabled === false) return [];
		const rule = denyRules.find((candidate) => candidate.when?.provider === channel.provider);
		if (rule === void 0) return [];
		return [{
			checkId: CHECK_IDS.policyDeniedChannelProvider,
			severity: "error",
			message: `Channel '${channel.id}' uses denied provider '${channel.provider}'.`,
			source: "policy",
			path: "openclaw config",
			ocPath: channel.source,
			target: channel.source,
			requirement: rule.requirement,
			fixHint: rule.reason ?? "Disable this channel, remove it from config, or update the policy deny rule."
		}];
	});
}
function policyAttestationFindings(policyPath, policyHash, evidence, findings, settings) {
	const expected = settings.expectedAttestationHash?.trim();
	if (!expected) return [];
	const current = createPolicyAttestation({
		ok: findings.length === 0,
		checkedAt: (/* @__PURE__ */ new Date(0)).toISOString(),
		policyPath,
		policyHash,
		evidence,
		findings: findings.map(toAttestedFinding)
	});
	if (current.attestationHash === expected) return [];
	return [{
		checkId: CHECK_IDS.policyAttestationMismatch,
		severity: "error",
		message: "The current policy check no longer matches the accepted policy attestation.",
		source: "policy",
		path: "policy attestation",
		target: "oc://policy/attestation/current",
		requirement: "oc://openclaw.config/plugins/entries/policy/config/expectedAttestationHash",
		fixHint: `Run policy check, review attestation ${current.attestationHash}, then update plugins.entries.policy.config.expectedAttestationHash and the supervisor/gateway accepted attestation.`
	}];
}
function toAttestedFinding(finding) {
	return {
		checkId: finding.checkId,
		severity: finding.severity,
		message: finding.message,
		...finding.source !== void 0 ? { source: finding.source } : {},
		...finding.path !== void 0 ? { path: finding.path } : {},
		...finding.line !== void 0 ? { line: finding.line } : {},
		...finding.column !== void 0 ? { column: finding.column } : {},
		...finding.ocPath !== void 0 ? { ocPath: finding.ocPath } : {},
		...finding.target !== void 0 ? { target: finding.target } : {},
		...finding.requirement !== void 0 ? { requirement: finding.requirement } : {},
		...finding.fixHint !== void 0 ? { fixHint: finding.fixHint } : {}
	};
}
function invalidChannelDenyRuleFindings(policy, policyPath, policyDocName) {
	if (!isRecord(policy) || !isRecord(policy.channels) || policy.channels.denyRules === void 0) return [];
	if (!Array.isArray(policy.channels.denyRules)) return [{
		checkId: CHECK_IDS.policyInvalidFile,
		severity: "error",
		message: `${policyPath} channels.denyRules must be an array.`,
		source: "policy",
		path: policyPath,
		target: `oc://${policyDocName}/channels/denyRules`,
		fixHint: `Fix ${policyPath} so channel deny rules are an array.`
	}];
	const invalid = policy.channels.denyRules.findIndex((rule) => !isChannelDenyRule(rule));
	if (invalid < 0) return [];
	return [{
		checkId: CHECK_IDS.policyInvalidFile,
		severity: "error",
		message: `${policyPath} channels.denyRules[${invalid}] must define when.provider as a string.`,
		source: "policy",
		path: policyPath,
		target: `oc://${policyDocName}/channels/denyRules/#${invalid}`,
		fixHint: `Fix ${policyPath} so each channel deny rule has a provider match.`
	}];
}
async function readPolicyFile(ctx) {
	const displayName = policyDisplayName(ctx);
	const path = resolveWorkspacePath(ctx, policyPathSetting(ctx));
	try {
		return {
			raw: await (await import("node:fs/promises")).readFile(path, "utf-8"),
			path,
			displayName,
			ocDocName: basename(displayName)
		};
	} catch (err) {
		if (isNotFound(err)) return null;
		throw err;
	}
}
function resolveWorkspacePath(ctx, fileName) {
	if (isAbsolute(fileName)) return fileName;
	return resolve(ctx.cwd ?? process.cwd(), fileName);
}
function isNotFound(err) {
	return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
function parsePolicyFile(raw) {
	try {
		return {
			ok: true,
			value: JSON5.parse(raw)
		};
	} catch (err) {
		return {
			ok: false,
			message: err instanceof Error ? err.message : String(err)
		};
	}
}
function workspaceRepairsEnabled(ctx) {
	return policySettings(ctx).workspaceRepairs === true;
}
function workspaceRepairsDisabledResult(fileName) {
	return {
		status: "skipped",
		reason: "workspace repairs are disabled",
		changes: [],
		warnings: [`Skipped ${fileName} repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace files.`]
	};
}
function readChannelDenyRules(policy, policyDocName) {
	if (!isRecord(policy) || !isRecord(policy.channels) || !Array.isArray(policy.channels.denyRules)) return [];
	return policy.channels.denyRules.map((rule, index) => ({
		rule,
		index
	})).filter((entry) => isChannelDenyRule(entry.rule)).map(({ rule, index }) => {
		const next = {
			when: rule.when,
			requirement: `oc://${policyDocName}/channels/denyRules/#${index}`
		};
		if (rule.id !== void 0) next.id = rule.id;
		if (rule.reason !== void 0) next.reason = rule.reason;
		return next;
	});
}
function isChannelDenyRule(value) {
	return isRecord(value) && (value.id === void 0 || typeof value.id === "string") && (value.reason === void 0 || typeof value.reason === "string") && isRecord(value.when) && typeof value.when.provider === "string";
}
function channelIdsFromFindings(findings) {
	return [...new Set(findings.filter((finding) => finding.checkId === CHECK_IDS.policyDeniedChannelProvider).map((finding) => finding.ocPath?.match(/^oc:\/\/openclaw\.config\/channels\/(.+)$/)?.[1]).filter((id) => id !== void 0 && id !== ""))];
}
function disableChannels(cfg, channelIds) {
	if (!isRecord(cfg.channels)) return {
		config: cfg,
		changed: []
	};
	const channels = { ...cfg.channels };
	const changed = [];
	for (const id of channelIds) {
		const current = channels[id];
		if (!isRecord(current) || current.enabled === false) continue;
		channels[id] = {
			...current,
			enabled: false
		};
		changed.push(id);
	}
	if (changed.length === 0) return {
		config: cfg,
		changed
	};
	return {
		config: {
			...cfg,
			channels
		},
		changed
	};
}
function policySettings(ctx) {
	const pluginConfig = ctx.cfg.plugins?.entries?.["policy"]?.config;
	if (!isRecord(pluginConfig)) return {};
	return pluginConfig;
}
function policyChecksEnabled(ctx, settings) {
	const entry = ctx.cfg.plugins?.entries?.["policy"];
	if (!isRecord(entry) || entry.enabled === false) return false;
	return settings.enabled !== false;
}
function policyPathSetting(ctx) {
	const configured = policySettings(ctx).path;
	return typeof configured === "string" && configured.trim() !== "" ? configured.trim() : "policy.jsonc";
}
function policyDisplayName(ctx) {
	const configured = policyPathSetting(ctx);
	return isAbsolute(configured) ? basename(configured) : configured;
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
//#endregion
export { createPolicyAttestation as i, evaluatePolicy as n, registerPolicyDoctorChecks as r, POLICY_CHECK_IDS as t };
