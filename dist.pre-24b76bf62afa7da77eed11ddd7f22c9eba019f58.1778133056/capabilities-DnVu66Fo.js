//#region src/music-generation/capabilities.ts
function resolveMusicGenerationMode(params) {
	return (params.inputImageCount ?? 0) > 0 ? "edit" : "generate";
}
function listSupportedMusicGenerationModes(provider) {
	const modes = ["generate"];
	if (provider.capabilities.edit?.enabled) modes.push("edit");
	return modes;
}
function resolveMusicGenerationModeCapabilities(params) {
	const mode = resolveMusicGenerationMode(params);
	const capabilities = params.provider?.capabilities;
	if (!capabilities) return {
		mode,
		capabilities: void 0
	};
	if (mode === "generate") return {
		mode,
		capabilities: capabilities.generate
	};
	return {
		mode,
		capabilities: capabilities.edit
	};
}
//#endregion
export { resolveMusicGenerationModeCapabilities as n, listSupportedMusicGenerationModes as t };
