//#region extensions/anthropic/doctor-contract-api.ts
const legacyConfigRules = [];
const sessionRouteStateOwners = [{
	id: "anthropic",
	label: "Anthropic",
	providerIds: ["anthropic", "claude-cli"],
	runtimeIds: ["claude-cli"],
	cliSessionKeys: ["claude-cli"],
	authProfilePrefixes: ["anthropic:", "claude-cli:"]
}];
//#endregion
export { legacyConfigRules, sessionRouteStateOwners };
