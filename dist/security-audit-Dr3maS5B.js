import { a as readChannelAllowFromStore } from "./pairing-store-jPMfFWFn.js";
import { r as resolveNativeSkillsEnabled } from "./commands-BZM3rtIy.js";
import "./conversation-runtime-guwDSNIo.js";
import "./native-command-config-runtime-DjDvteb8.js";
import { r as normalizeTelegramAllowFromEntry, t as isNumericTelegramSenderUserId } from "./allow-from-Byf7JKVc.js";
//#region extensions/telegram/src/security-audit.ts
function normalizeOptionalString(value) {
	const normalized = value?.trim();
	return normalized ? normalized : void 0;
}
function collectInvalidTelegramAllowFromEntries(params) {
	if (!Array.isArray(params.entries)) return;
	for (const entry of params.entries) {
		const normalized = normalizeTelegramAllowFromEntry(entry);
		if (!normalized || normalized === "*") continue;
		if (!isNumericTelegramSenderUserId(normalized)) params.target.add(normalized);
	}
}
function appendInvalidTelegramAllowFromFinding(findings, invalidTelegramAllowFromEntries) {
	if (invalidTelegramAllowFromEntries.size === 0) return;
	const examples = Array.from(invalidTelegramAllowFromEntries).slice(0, 5);
	const more = invalidTelegramAllowFromEntries.size > examples.length ? ` (+${invalidTelegramAllowFromEntries.size - examples.length} more)` : "";
	findings.push({
		checkId: "channels.telegram.allowFrom.invalid_entries",
		severity: "warn",
		title: "Telegram allowlist contains non-numeric entries",
		detail: `Telegram sender authorization requires numeric Telegram user IDs. Found non-numeric allowFrom entries: ${examples.join(", ")}${more}.`,
		remediation: "Replace @username entries with numeric Telegram user IDs (use setup to resolve), then re-run the audit."
	});
}
async function collectTelegramSecurityAuditFindings(params) {
	const findings = [];
	const telegramCfg = params.account.config ?? {};
	const accountId = normalizeOptionalString(params.accountId) ?? params.account.accountId ?? "default";
	const invalidTelegramAllowFromEntries = /* @__PURE__ */ new Set();
	collectInvalidTelegramAllowFromEntries({
		entries: Array.isArray(telegramCfg.allowFrom) ? telegramCfg.allowFrom : [],
		target: invalidTelegramAllowFromEntries
	});
	if (params.cfg.commands?.text === false) {
		appendInvalidTelegramAllowFromFinding(findings, invalidTelegramAllowFromEntries);
		return findings;
	}
	const defaultGroupPolicy = params.cfg.channels?.defaults?.groupPolicy;
	const groupPolicy = telegramCfg.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
	const groups = telegramCfg.groups;
	const groupsConfigured = Boolean(groups) && Object.keys(groups ?? {}).length > 0;
	if (!(groupPolicy === "open" || groupPolicy === "allowlist" && groupsConfigured)) {
		appendInvalidTelegramAllowFromFinding(findings, invalidTelegramAllowFromEntries);
		return findings;
	}
	const storeAllowFrom = await readChannelAllowFromStore("telegram", process.env, accountId).catch(() => []);
	const storeHasWildcard = storeAllowFrom.some((value) => (normalizeOptionalString(value) ?? "") === "*");
	collectInvalidTelegramAllowFromEntries({
		entries: storeAllowFrom,
		target: invalidTelegramAllowFromEntries
	});
	const groupAllowFrom = Array.isArray(telegramCfg.groupAllowFrom) ? telegramCfg.groupAllowFrom : [];
	const groupAllowFromHasWildcard = groupAllowFrom.some((value) => (normalizeOptionalString(String(value)) ?? "") === "*");
	collectInvalidTelegramAllowFromEntries({
		entries: groupAllowFrom,
		target: invalidTelegramAllowFromEntries
	});
	let anyGroupOverride = false;
	if (groups) for (const value of Object.values(groups)) {
		if (!value || typeof value !== "object") continue;
		const group = value;
		const allowFrom = Array.isArray(group.allowFrom) ? group.allowFrom : [];
		if (allowFrom.length > 0) {
			anyGroupOverride = true;
			collectInvalidTelegramAllowFromEntries({
				entries: allowFrom,
				target: invalidTelegramAllowFromEntries
			});
		}
		const topics = group.topics;
		if (!topics || typeof topics !== "object") continue;
		for (const topicValue of Object.values(topics)) {
			if (!topicValue || typeof topicValue !== "object") continue;
			const topic = topicValue;
			const topicAllow = Array.isArray(topic.allowFrom) ? topic.allowFrom : [];
			if (topicAllow.length > 0) anyGroupOverride = true;
			collectInvalidTelegramAllowFromEntries({
				entries: topicAllow,
				target: invalidTelegramAllowFromEntries
			});
		}
	}
	const hasAnySenderAllowlist = storeAllowFrom.length > 0 || groupAllowFrom.length > 0 || anyGroupOverride;
	appendInvalidTelegramAllowFromFinding(findings, invalidTelegramAllowFromEntries);
	if (storeHasWildcard || groupAllowFromHasWildcard) {
		findings.push({
			checkId: "channels.telegram.groups.allowFrom.wildcard",
			severity: "critical",
			title: "Telegram group allowlist contains wildcard",
			detail: "Telegram group sender allowlist contains \"*\", which allows any group member to run /… commands and control directives.",
			remediation: "Remove \"*\" from channels.telegram.groupAllowFrom and pairing store; prefer explicit numeric Telegram user IDs."
		});
		return findings;
	}
	if (!hasAnySenderAllowlist) {
		const skillsEnabled = resolveNativeSkillsEnabled({
			providerId: "telegram",
			providerSetting: telegramCfg.commands?.nativeSkills,
			globalSetting: params.cfg.commands?.nativeSkills
		});
		findings.push({
			checkId: "channels.telegram.groups.allowFrom.missing",
			severity: "critical",
			title: "Telegram group commands have no sender allowlist",
			detail: `Telegram group access is enabled but no sender allowlist is configured; this allows any group member to invoke /… commands` + (skillsEnabled ? " (including skill commands)." : "."),
			remediation: "Approve yourself via pairing (recommended), or set channels.telegram.groupAllowFrom (or per-group groups.<id>.allowFrom)."
		});
	}
	return findings;
}
//#endregion
export { collectTelegramSecurityAuditFindings as t };
