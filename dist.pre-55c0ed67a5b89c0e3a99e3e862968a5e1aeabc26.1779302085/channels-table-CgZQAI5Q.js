//#region src/commands/status-all/channel-issues.ts
function groupChannelIssuesByChannel(issues) {
	const byChannel = /* @__PURE__ */ new Map();
	for (const issue of issues) {
		const key = issue.channel;
		const list = byChannel.get(key);
		if (list) list.push(issue);
		else byChannel.set(key, [issue]);
	}
	return byChannel;
}
//#endregion
//#region src/commands/status-all/channels-table.ts
const statusChannelsTableColumns = [
	{
		key: "Channel",
		header: "Channel",
		minWidth: 10
	},
	{
		key: "Enabled",
		header: "Enabled",
		minWidth: 7
	},
	{
		key: "State",
		header: "State",
		minWidth: 8
	},
	{
		key: "Detail",
		header: "Detail",
		flex: true,
		minWidth: 24
	}
];
function buildStatusChannelsTableRows(params) {
	const channelIssuesByChannel = groupChannelIssuesByChannel(params.channelIssues);
	const formatIssueMessage = params.formatIssueMessage ?? ((message) => message);
	return params.rows.map((row) => {
		const issues = channelIssuesByChannel.get(row.id) ?? [];
		const effectiveState = row.state === "off" ? "off" : issues.length > 0 ? "warn" : row.state;
		const issueSuffix = issues.length > 0 ? ` · ${params.warn(`gateway: ${formatIssueMessage(issues[0]?.message ?? "issue")}`)}` : "";
		return {
			Channel: row.label,
			Enabled: row.enabled ? params.ok("ON") : params.muted("OFF"),
			State: effectiveState === "ok" ? params.ok("OK") : effectiveState === "warn" ? params.warn("WARN") : effectiveState === "off" ? params.muted("OFF") : params.accentDim("SETUP"),
			Detail: `${row.detail}${issueSuffix}`
		};
	});
}
//#endregion
export { statusChannelsTableColumns as n, groupChannelIssuesByChannel as r, buildStatusChannelsTableRows as t };
