//#region extensions/codex/harness.ts
const DEFAULT_CODEX_HARNESS_PROVIDER_IDS = new Set(["codex"]);
function createCodexAppServerAgentHarness(options) {
	const providerIds = new Set([...options?.providerIds ?? DEFAULT_CODEX_HARNESS_PROVIDER_IDS].map((id) => id.trim().toLowerCase()));
	return {
		id: options?.id ?? "codex",
		label: options?.label ?? "Codex agent harness",
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
			const { runCodexAppServerAttempt } = await import("./run-attempt-DSYgRhrH.js");
			return runCodexAppServerAttempt(params, {
				pluginConfig: options?.pluginConfig,
				nativeHookRelay: { enabled: true }
			});
		},
		runSideQuestion: async (params) => {
			const { runCodexAppServerSideQuestion } = await import("./side-question-jYfz_XEG.js");
			return runCodexAppServerSideQuestion(params, { pluginConfig: options?.pluginConfig });
		},
		compact: async (params) => {
			const { maybeCompactCodexAppServerSession } = await import("./compact-BuCAflwa.js");
			return maybeCompactCodexAppServerSession(params, { pluginConfig: options?.pluginConfig });
		},
		reset: async (params) => {
			if (params.sessionFile) {
				const { clearCodexAppServerBinding } = await import("./session-binding-BjWJkugX.js");
				await clearCodexAppServerBinding(params.sessionFile);
			}
		},
		dispose: async () => {
			const { clearSharedCodexAppServerClientAndWait } = await import("./shared-client-CLtJ8uno.js");
			await clearSharedCodexAppServerClientAndWait();
		}
	};
}
//#endregion
export { createCodexAppServerAgentHarness as t };
