import "./agent-scope-rw2bYM9R.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-DdvF1onI.js";
import { r as hasAmbiguousGatewayAuthModeConfig } from "./auth-mode-policy-DAHU23nY.js";
import { t as buildWorkspaceSkillStatus } from "./skills-status-ClxLAFsT.js";
import { n as maybeArchiveLegacyClawdBrowserProfileResidue, t as detectLegacyClawdBrowserProfileResidue } from "./doctor-browser-DMOxvNle.js";
import { n as hasConfiguredCommandOwners } from "./doctor-command-owner-DVSXJvZ9.js";
import { i as disableUnavailableSkillsInConfig, t as collectUnavailableAgentSkills } from "./doctor-skills-UGfcJgpZ.js";
import path from "node:path";
//#region src/flows/health-check-registry.ts
const REGISTRY = /* @__PURE__ */ new Map();
var HealthCheckRegistrationError = class extends Error {
	constructor(checkId) {
		super(`health check already registered: ${checkId}`);
		this.checkId = checkId;
		this.code = "OC_DOCTOR_DUPLICATE_CHECK";
		this.name = "HealthCheckRegistrationError";
	}
};
function registerHealthCheck(check) {
	if (REGISTRY.has(check.id)) throw new HealthCheckRegistrationError(check.id);
	REGISTRY.set(check.id, check);
}
function listHealthChecks() {
	return [...REGISTRY.values()];
}
function getHealthCheck(id) {
	return REGISTRY.get(id);
}
//#endregion
//#region src/flows/doctor-core-checks.ts
const BROWSER_CLAWD_PROFILE_RESIDUE_CHECK_ID = "core/doctor/browser-clawd-profile-residue";
const FINAL_CONFIG_VALIDATION_CHECK_ID = "core/doctor/final-config-validation";
function configValidationIssuesToHealthFindings(issues) {
	return issues.map((issue) => ({
		checkId: FINAL_CONFIG_VALIDATION_CHECK_ID,
		severity: "error",
		message: issue.message,
		path: issue.path || "<root>"
	}));
}
const gatewayConfigCheck = {
	id: "core/doctor/gateway-config",
	kind: "core",
	description: "openclaw.jsonc gateway block is set and unambiguous.",
	source: "doctor",
	async detect(ctx) {
		const findings = [];
		if (!ctx.cfg.gateway?.mode) findings.push({
			checkId: "core/doctor/gateway-config",
			severity: "warning",
			message: "gateway.mode is unset; gateway start will be blocked.",
			path: "gateway.mode",
			fixHint: "Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`."
		});
		if (ctx.cfg.gateway?.mode !== "remote" && hasAmbiguousGatewayAuthModeConfig(ctx.cfg)) findings.push({
			checkId: "core/doctor/gateway-config",
			severity: "warning",
			message: "gateway.auth.token and gateway.auth.password are both configured while gateway.auth.mode is unset; auth selection is ambiguous.",
			path: "gateway.auth.mode",
			fixHint: "Set an explicit mode: `openclaw config set gateway.auth.mode token` or `... password`."
		});
		return findings;
	}
};
const commandOwnerCheck = {
	id: "core/doctor/command-owner",
	kind: "core",
	description: "An owner account is configured for owner-only commands.",
	source: "doctor",
	async detect(ctx) {
		if (hasConfiguredCommandOwners(ctx.cfg)) return [];
		return [{
			checkId: "core/doctor/command-owner",
			severity: "info",
			message: "No command owner is configured. Owner-only commands (/diagnostics, /export-trajectory, /config, exec approvals) have no allowed sender.",
			path: "commands.ownerAllowFrom",
			fixHint: "Set commands.ownerAllowFrom to your channel user id, e.g. `openclaw config set commands.ownerAllowFrom '[\"telegram:123456789\"]'`."
		}];
	}
};
const workspaceStatusCheck = {
	id: "core/doctor/workspace-status",
	kind: "core",
	description: "Workspace directory exists and has no legacy duplicates.",
	source: "doctor",
	async detect(ctx) {
		const { detectLegacyWorkspaceDirs } = await import("./doctor-workspace-BtCKf3Yw.js");
		const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
		const legacy = detectLegacyWorkspaceDirs({ workspaceDir });
		if (legacy.legacyDirs.length === 0) return [];
		return [{
			checkId: "core/doctor/workspace-status",
			severity: "info",
			message: `Detected ${legacy.legacyDirs.length} legacy workspace director${legacy.legacyDirs.length === 1 ? "y" : "ies"} alongside the active workspace.`,
			path: workspaceDir,
			fixHint: "Inspect the legacy directories and migrate or remove them; see `openclaw doctor` for the detailed migration prompt."
		}];
	}
};
const skillsReadinessCheck = {
	id: "core/doctor/skills-readiness",
	kind: "core",
	description: "Allowed skills are usable in the current runtime environment.",
	source: "doctor",
	async detect(ctx, scope) {
		return filterUnavailableSkillsForScope(detectUnavailableSkills(ctx.cfg), scope?.paths).map(unavailableSkillToFinding);
	},
	async repair(ctx, findings) {
		const unavailable = filterUnavailableSkillsForScope(detectUnavailableSkills(ctx.cfg), findings.map((finding) => finding.path));
		if (unavailable.length === 0) return { changes: [] };
		return {
			config: disableUnavailableSkillsInConfig(ctx.cfg, unavailable),
			changes: unavailable.map((skill) => `Disabled unavailable skill ${skill.name}.`),
			effects: unavailable.map((skill) => ({
				kind: "config",
				action: ctx.dryRun === true ? "would-disable-skill" : "disable-skill",
				target: skillReadinessPath(skill),
				dryRunSafe: true
			}))
		};
	}
};
function unavailableSkillToFinding(skill) {
	return {
		checkId: "core/doctor/skills-readiness",
		severity: "warning",
		message: `${skill.name} is allowed but unavailable: ${formatMissingSkillSummary(skill)}.`,
		path: skillReadinessPath(skill),
		fixHint: "Install/configure the missing requirement, or run `openclaw doctor --fix` to disable unused unavailable skills."
	};
}
function filterUnavailableSkillsForScope(unavailable, paths) {
	const scopedPaths = new Set(paths?.filter((path) => path !== void 0) ?? []);
	if (scopedPaths.size === 0) return [...unavailable];
	return unavailable.filter((skill) => scopedPaths.has(skillReadinessPath(skill)));
}
function skillReadinessPath(skill) {
	return `skills.entries.${skill.skillKey}.enabled`;
}
function browserResidueDeps(ctx) {
	return ctx.configPath ? { configDir: path.dirname(ctx.configPath) } : {};
}
function browserResidueFinding(residue) {
	return {
		checkId: BROWSER_CLAWD_PROFILE_RESIDUE_CHECK_ID,
		severity: "warning",
		message: `Legacy managed browser profile residue was found at ${residue.legacyProfileDir}.`,
		path: residue.legacyProfileDir,
		ocPath: "oc://state/browser/clawd",
		fixHint: "Run `openclaw doctor --fix` to archive the stale clawd profile safely instead of deleting it in place."
	};
}
function formatWouldArchiveBrowserResidue(residue) {
	return [
		"Would archive legacy clawd managed browser profile residue.",
		`- legacy profile: ${residue.legacyProfileDir}`,
		`- canonical profile: ${residue.canonicalUserDataDir}`
	].join("\n");
}
const browserClawdProfileResidueCheck = {
	id: BROWSER_CLAWD_PROFILE_RESIDUE_CHECK_ID,
	kind: "core",
	description: "Legacy clawd managed browser profile residue has been archived after the OpenClaw rename.",
	source: "doctor",
	async detect(ctx, scope) {
		const residue = await detectLegacyClawdBrowserProfileResidue(ctx.cfg, browserResidueDeps(ctx));
		if (!residue) return [];
		const scopedPaths = new Set(scope?.paths ?? []);
		if (scopedPaths.size > 0 && !scopedPaths.has(residue.legacyProfileDir)) return [];
		return [browserResidueFinding(residue)];
	},
	async repair(ctx) {
		const residue = await detectLegacyClawdBrowserProfileResidue(ctx.cfg, browserResidueDeps(ctx));
		if (!residue) return {
			status: "skipped",
			reason: "legacy clawd browser profile residue no longer exists",
			changes: []
		};
		const effect = {
			kind: "state",
			action: ctx.dryRun === true ? "would-archive-legacy-browser-profile-residue" : "archive-legacy-browser-profile-residue",
			target: residue.legacyProfileDir,
			dryRunSafe: false
		};
		if (ctx.dryRun === true) return {
			changes: [formatWouldArchiveBrowserResidue(residue)],
			effects: [effect]
		};
		const result = await maybeArchiveLegacyClawdBrowserProfileResidue(ctx.cfg, browserResidueDeps(ctx));
		if (result.changes.length === 0 && result.warnings.length > 0) return {
			status: "failed",
			reason: result.warnings.join("; "),
			changes: [],
			warnings: result.warnings,
			effects: []
		};
		return {
			changes: result.changes,
			warnings: result.warnings,
			effects: result.changes.length > 0 ? [effect] : []
		};
	}
};
const finalConfigValidationCheck = {
	id: FINAL_CONFIG_VALIDATION_CHECK_ID,
	kind: "core",
	description: "Active openclaw.jsonc parses and conforms to the config schema.",
	source: "doctor",
	async detect() {
		const { readConfigFileSnapshot } = await import("./config/config.js");
		const snap = await readConfigFileSnapshot();
		if (!snap.exists || snap.valid) return [];
		return configValidationIssuesToHealthFindings(snap.issues);
	}
};
let registered = false;
function registerCoreHealthChecks() {
	if (registered) return;
	registerHealthCheck(gatewayConfigCheck);
	registerHealthCheck(commandOwnerCheck);
	registerHealthCheck(workspaceStatusCheck);
	registerHealthCheck(skillsReadinessCheck);
	registerHealthCheck(browserClawdProfileResidueCheck);
	registerHealthCheck(finalConfigValidationCheck);
	registered = true;
}
function detectUnavailableSkills(cfg) {
	const agentId = resolveDefaultAgentId(cfg);
	return collectUnavailableAgentSkills(buildWorkspaceSkillStatus(resolveAgentWorkspaceDir(cfg, agentId), {
		config: cfg,
		agentId
	}));
}
function formatMissingSkillSummary(skill) {
	const missing = [];
	if (skill.missing.bins.length > 0) missing.push(`bins: ${skill.missing.bins.join(", ")}`);
	if (skill.missing.anyBins.length > 0) missing.push(`any bins: ${skill.missing.anyBins.join(", ")}`);
	if (skill.missing.env.length > 0) missing.push(`env: ${skill.missing.env.join(", ")}`);
	if (skill.missing.config.length > 0) missing.push(`config: ${skill.missing.config.join(", ")}`);
	if (skill.missing.os.length > 0) missing.push(`os: ${skill.missing.os.join(", ")}`);
	return missing.join("; ") || "unknown requirement";
}
//#endregion
//#region src/flows/doctor-error-message.ts
const ERR_MESSAGE_MAX_LEN = 256;
function scrubDoctorErrorMessage(err) {
	const raw = err instanceof Error ? err.message : String(err);
	let stripped = "";
	for (let index = 0; index < raw.length; index++) {
		const code = raw.charCodeAt(index);
		if (code > 31 && code !== 127) stripped += raw.charAt(index);
	}
	if (stripped.length <= ERR_MESSAGE_MAX_LEN) return stripped;
	return `${stripped.slice(0, ERR_MESSAGE_MAX_LEN - 3)}...`;
}
//#endregion
//#region src/flows/health-checks.ts
const HEALTH_FINDING_SEVERITY_RANK = {
	info: 0,
	warning: 1,
	error: 2
};
function parseHealthFindingSeverity(input) {
	if (input === "info" || input === "warning" || input === "error") return input;
	return null;
}
function healthFindingMeetsSeverity(finding, severityMin) {
	return HEALTH_FINDING_SEVERITY_RANK[finding.severity] >= HEALTH_FINDING_SEVERITY_RANK[severityMin];
}
//#endregion
//#region src/flows/doctor-lint-flow.ts
async function runDoctorLintChecks(ctx, opts = {}) {
	const all = opts.checks ?? listHealthChecks();
	const skip = opts.skipIds instanceof Set ? opts.skipIds : new Set(opts.skipIds ?? []);
	const only = opts.onlyIds instanceof Set ? opts.onlyIds : new Set(opts.onlyIds ?? []);
	const selected = all.filter((c) => {
		if (only.size > 0 && !only.has(c.id)) return false;
		if (skip.has(c.id)) return false;
		return true;
	});
	const findings = [];
	for (const check of selected) try {
		const out = await check.detect(ctx);
		for (const f of out) findings.push(f);
	} catch (err) {
		findings.push({
			checkId: check.id,
			severity: "error",
			message: `health check threw: ${scrubDoctorErrorMessage(err)}`
		});
	}
	findings.sort(compareFindings);
	return {
		findings,
		checksRun: selected.length,
		checksSkipped: all.length - selected.length
	};
}
function compareFindings(a, b) {
	const sevDelta = HEALTH_FINDING_SEVERITY_RANK[b.severity] - HEALTH_FINDING_SEVERITY_RANK[a.severity];
	if (sevDelta !== 0) return sevDelta;
	const idDelta = a.checkId.localeCompare(b.checkId);
	if (idDelta !== 0) return idDelta;
	return (a.path ?? "").localeCompare(b.path ?? "");
}
function exitCodeFromFindings(findings, severityMin = "warning") {
	return findings.some((f) => healthFindingMeetsSeverity(f, severityMin)) ? 1 : 0;
}
//#endregion
export { configValidationIssuesToHealthFindings as a, listHealthChecks as c, parseHealthFindingSeverity as i, registerHealthCheck as l, runDoctorLintChecks as n, registerCoreHealthChecks as o, healthFindingMeetsSeverity as r, getHealthCheck as s, exitCodeFromFindings as t };
