//#region extensions/synology-chat/src/security-audit.ts
function collectSynologyChatSecurityAuditFindings(params) {
	if (!params.account.dangerouslyAllowNameMatching) return [];
	const accountId = params.accountId?.trim() || params.account.accountId || "default";
	return [{
		checkId: "channels.synology-chat.reply.dangerous_name_matching_enabled",
		severity: "info",
		title: `Synology Chat dangerous name matching is enabled${params.orderedAccountIds.length > 1 || params.hasExplicitAccountPath ? ` (account: ${accountId})` : ""}`,
		detail: "dangerouslyAllowNameMatching=true re-enables mutable username/nickname matching for reply delivery. This is a break-glass compatibility mode, not a hardened default.",
		remediation: "Prefer stable numeric Synology Chat user IDs for reply delivery, then disable dangerouslyAllowNameMatching."
	}];
}
//#endregion
export { collectSynologyChatSecurityAuditFindings as t };
