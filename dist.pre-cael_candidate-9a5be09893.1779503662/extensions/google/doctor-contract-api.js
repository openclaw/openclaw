//#region extensions/google/doctor-contract-api.ts
const sessionRouteStateOwners = [{
	id: "google",
	label: "Google",
	providerIds: [
		"google",
		"google-antigravity",
		"google-gemini-cli",
		"google-vertex"
	],
	runtimeIds: ["google-gemini-cli"],
	cliSessionKeys: ["google-gemini-cli", "gemini-cli"],
	authProfilePrefixes: [
		"google:",
		"google-antigravity:",
		"google-gemini-cli:",
		"google-vertex:",
		"gemini-cli:"
	]
}];
//#endregion
export { sessionRouteStateOwners };
