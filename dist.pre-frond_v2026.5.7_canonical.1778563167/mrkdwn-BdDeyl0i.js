//#region extensions/slack/src/monitor/mrkdwn.ts
function escapeSlackMrkdwn(value) {
	return value.replaceAll("\\", "\\\\").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/([*_`~])/g, "\\$1");
}
//#endregion
export { escapeSlackMrkdwn as t };
