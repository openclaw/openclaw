//#region extensions/oc-path/cli-registration.ts
function registerOcPathCli(api) {
	api.registerCli(async ({ program }) => {
		const { registerPathCli } = await import("./cli-D0R1Phva.js");
		registerPathCli(program);
	}, { descriptors: [{
		name: "path",
		description: "Inspect and edit workspace files via oc:// paths",
		hasSubcommands: true
	}] });
}
//#endregion
export { registerOcPathCli as t };
