//#region extensions/codex/doctor-contract-api.ts
const sessionRouteStateOwners = [{
	id: "codex",
	label: "Codex",
	providerIds: [
		"codex",
		"codex-cli",
		"openai-codex"
	],
	runtimeIds: ["codex", "codex-cli"],
	cliSessionKeys: ["codex-cli"],
	authProfilePrefixes: [
		"codex:",
		"codex-cli:",
		"openai-codex:"
	]
}];
//#endregion
export { sessionRouteStateOwners };
