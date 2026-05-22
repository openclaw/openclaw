//#region extensions/codex/src/app-server/client-factory.ts
const defaultCodexAppServerClientFactory = (startOptions, authProfileId, agentDir, config) => import("./shared-client-C754sdEb.js").then(({ getSharedCodexAppServerClient }) => getSharedCodexAppServerClient({
	startOptions,
	authProfileId,
	agentDir,
	config
}));
function createCodexAppServerClientFactoryTestHooks(setFactory) {
	return {
		setCodexAppServerClientFactoryForTests(factory) {
			setFactory(factory);
		},
		resetCodexAppServerClientFactoryForTests() {
			setFactory(defaultCodexAppServerClientFactory);
		}
	};
}
//#endregion
export { defaultCodexAppServerClientFactory as n, createCodexAppServerClientFactoryTestHooks as t };
