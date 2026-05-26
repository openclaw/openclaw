//#region extensions/codex/src/app-server/client-factory.ts
const defaultCodexAppServerClientFactory = (startOptions, authProfileId, agentDir, config) => import("./shared-client-DUjDL6O1.js").then(({ getSharedCodexAppServerClient }) => getSharedCodexAppServerClient({
	startOptions,
	authProfileId,
	agentDir,
	config
}));
//#endregion
export { defaultCodexAppServerClientFactory as t };
