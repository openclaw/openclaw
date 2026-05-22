//#region extensions/slack/src/truncate.ts
function truncateSlackText(value, max) {
	const trimmed = value.trim();
	if (trimmed.length <= max) return trimmed;
	if (max <= 1) return trimmed.slice(0, max);
	return `${trimmed.slice(0, max - 1)}…`;
}
//#endregion
//#region extensions/slack/src/limits.ts
const SLACK_TEXT_LIMIT = 8e3;
//#endregion
export { truncateSlackText as n, SLACK_TEXT_LIMIT as t };
