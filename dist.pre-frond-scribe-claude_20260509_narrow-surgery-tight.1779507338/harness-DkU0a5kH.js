//#region extensions/codex/harness.ts
const DEFAULT_CODEX_HARNESS_PROVIDER_IDS = new Set(["codex"]);
const CODEX_APP_SERVER_CONTEXT_ENGINE_HOST_CAPABILITIES = [
	"bootstrap",
	"assemble-before-prompt",
	"after-turn",
	"maintain",
	"compact",
	"runtime-llm-complete",
	"thread-bootstrap-projection"
];
function createCodexAppServerAgentHarness(options) {
	const providerIds = new Set([...options?.providerIds ?? DEFAULT_CODEX_HARNESS_PROVIDER_IDS].map((id) => id.trim().toLowerCase()));
	return {
		id: options?.id ?? "codex",
		label: options?.label ?? "Codex agent harness",
		contextEngineHostCapabilities: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST_CAPABILITIES,
		deliveryDefaults: { sourceVisibleReplies: "message_tool" },
		supports: (ctx) => {
			const provider = ctx.provider.trim().toLowerCase();
			if (providerIds.has(provider)) return {
				supported: true,
				priority: 100
			};
			return {
				supported: false,
				reason: `provider is not one of: ${[...providerIds].toSorted().join(", ")}`
			};
		},
		runAttempt: async (params) => {
			const { runCodexAppServerAttempt } = await import("./run-attempt-CIBBSPEp.js");
			return runCodexAppServerAttempt(params, {
				pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
				nativeHookRelay: { enabled: true }
			});
		},
		runSideQuestion: async (params) => {
			const { runCodexAppServerSideQuestion } = await import("./side-question-CarKbiHi.js");
			return runCodexAppServerSideQuestion(params, {
				pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
				nativeHookRelay: { enabled: true }
			});
		},
		compact: async (params) => {
			const { maybeCompactCodexAppServerSession } = await import("./compact-BlZROVJB.js");
			return maybeCompactCodexAppServerSession(params, { pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig });
		},
		reset: async (params) => {
			if (params.sessionFile) {
				const { clearCodexAppServerBinding } = await import("./session-binding-jCrStDIF.js");
				await clearCodexAppServerBinding(params.sessionFile);
			}
		},
		dispose: async () => {
			const { clearSharedCodexAppServerClientAndWait } = await import("./shared-client-OvOkS5Q2.js");
			await clearSharedCodexAppServerClientAndWait();
		}
	};
}
//#endregion
export { createCodexAppServerAgentHarness as t };
