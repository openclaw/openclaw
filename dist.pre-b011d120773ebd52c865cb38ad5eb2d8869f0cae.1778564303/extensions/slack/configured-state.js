//#region extensions/slack/configured-state.ts
const SLACK_CONFIGURED_ENV_KEYS = [
	"SLACK_APP_TOKEN",
	"SLACK_BOT_TOKEN",
	"SLACK_USER_TOKEN"
];
function hasSlackConfiguredState(params) {
	return SLACK_CONFIGURED_ENV_KEYS.some((key) => typeof params.env?.[key] === "string" && params.env[key]?.trim().length > 0);
}
//#endregion
export { hasSlackConfiguredState };
