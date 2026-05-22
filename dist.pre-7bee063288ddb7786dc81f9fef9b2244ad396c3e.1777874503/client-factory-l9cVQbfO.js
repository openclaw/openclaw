//#region extensions/codex/src/app-server/client-factory.ts
const defaultCodexAppServerClientFactory = (startOptions, authProfileId, agentDir) => import("./shared-client-CLYBR2tH.js").then(({ getSharedCodexAppServerClient }) => getSharedCodexAppServerClient({
	startOptions,
	authProfileId,
	agentDir
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
