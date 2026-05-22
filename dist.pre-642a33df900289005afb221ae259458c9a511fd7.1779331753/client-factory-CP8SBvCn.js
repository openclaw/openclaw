//#region extensions/codex/src/app-server/client-factory.ts
const defaultCodexAppServerClientFactory = (startOptions, authProfileId, agentDir, config) => import("./shared-client-BHV2IXpE.js").then(({ getSharedCodexAppServerClient }) => getSharedCodexAppServerClient({
	startOptions,
	authProfileId,
	agentDir,
	config
}));
//#endregion
export { defaultCodexAppServerClientFactory as t };
