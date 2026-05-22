//#region extensions/msteams/src/oauth.shared.ts
const MSTEAMS_OAUTH_REDIRECT_URI = "http://localhost:8086/oauth2callback";
const MSTEAMS_OAUTH_CALLBACK_PORT = 8086;
const MSTEAMS_OAUTH_CALLBACK_PATH = "/oauth2callback";
const MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS = 1e4;
const MSTEAMS_DEFAULT_DELEGATED_SCOPES = [
	"ChatMessage.Send",
	"ChannelMessage.Send",
	"Chat.ReadWrite",
	"offline_access"
];
function buildMSTeamsAuthEndpoint(tenantId) {
	return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`;
}
function buildMSTeamsTokenEndpoint(tenantId) {
	return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}
//#endregion
export { MSTEAMS_OAUTH_REDIRECT_URI as a, MSTEAMS_OAUTH_CALLBACK_PORT as i, MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS as n, buildMSTeamsAuthEndpoint as o, MSTEAMS_OAUTH_CALLBACK_PATH as r, buildMSTeamsTokenEndpoint as s, MSTEAMS_DEFAULT_DELEGATED_SCOPES as t };
