import { a as readChannelAllowFromStore } from "./pairing-store-Ck_jPbH4.js";
import { i as normalizeAllowFromList, t as coerceNativeSetting } from "./channel-policy-fOi0H-_f.js";
import { n as resolveNativeCommandsEnabled, r as resolveNativeSkillsEnabled } from "./commands-BdbDuS5f.js";
import "./conversation-runtime-BgnAM9ys.js";
import "./native-command-config-runtime-CD-pZ0w0.js";
//#region extensions/slack/src/security-audit.ts
async function collectSlackSecurityAuditFindings(params) {
	const findings = [];
	const slackCfg = params.account.config ?? {};
	const accountId = params.accountId?.trim() || params.account.accountId || "default";
	if (!(slackCfg.slashCommand?.enabled === true || resolveNativeCommandsEnabled({
		providerId: "slack",
		providerSetting: coerceNativeSetting(slackCfg.commands?.native),
		globalSetting: params.cfg.commands?.native
	}) || resolveNativeSkillsEnabled({
		providerId: "slack",
		providerSetting: coerceNativeSetting(slackCfg.commands?.nativeSkills),
		globalSetting: params.cfg.commands?.nativeSkills
	}))) return findings;
	if (!(params.cfg.commands?.useAccessGroups !== false)) {
		findings.push({
			checkId: "channels.slack.commands.slash.useAccessGroups_off",
			severity: "critical",
			title: "Slack slash commands bypass access groups",
			detail: "Slack slash/native commands are enabled while commands.useAccessGroups=false; this can allow unrestricted /… command execution from channels/users you didn't explicitly authorize.",
			remediation: "Set commands.useAccessGroups=true (recommended)."
		});
		return findings;
	}
	const allowFromRaw = slackCfg.allowFrom;
	const legacyAllowFromRaw = params.account.dm?.allowFrom;
	const allowFrom = Array.isArray(allowFromRaw) ? allowFromRaw : Array.isArray(legacyAllowFromRaw) ? legacyAllowFromRaw : [];
	const storeAllowFrom = await readChannelAllowFromStore("slack", process.env, accountId).catch(() => []);
	const ownerAllowFromConfigured = normalizeAllowFromList([...allowFrom, ...storeAllowFrom]).length > 0;
	const channels = slackCfg.channels ?? {};
	const hasAnyChannelUsersAllowlist = Object.values(channels).some((value) => {
		if (!value || typeof value !== "object") return false;
		const channel = value;
		return Array.isArray(channel.users) && channel.users.length > 0;
	});
	if (!ownerAllowFromConfigured && !hasAnyChannelUsersAllowlist) findings.push({
		checkId: "channels.slack.commands.slash.no_allowlists",
		severity: "warn",
		title: "Slack slash commands have no allowlists",
		detail: "Slack slash/native commands are enabled, but neither an owner allowFrom list nor any channels.<id>.users allowlist is configured; /… commands will be rejected for everyone.",
		remediation: "Approve yourself via pairing (recommended), or set channels.slack.allowFrom and/or channels.slack.channels.<id>.users."
	});
	return findings;
}
//#endregion
export { collectSlackSecurityAuditFindings as t };
