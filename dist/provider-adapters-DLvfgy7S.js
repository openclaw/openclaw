import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { t as getProviderEnvVars } from "./provider-env-vars-HpAfBQBJ.js";
import { n as listMemoryEmbeddingProviders, r as listRegisteredMemoryEmbeddingProviderAdapters } from "./memory-embedding-provider-runtime-xg7fdvKI.js";
import { E as createLocalEmbeddingProvider, O as DEFAULT_LOCAL_MODEL } from "./memory-core-host-engine-embeddings-C9DVPPfR.js";
import "./memory-core-host-engine-foundation-C4jQcNJ0.js";
import "./provider-env-vars-DSEOb6lo.js";
import "./dreaming-shared-TJ4wErqZ.js";
import fs from "node:fs";
//#region extensions/memory-core/src/memory/provider-adapter-registration.ts
function filterUnregisteredMemoryEmbeddingProviderAdapters(params) {
	const existingIds = new Set(params.registeredAdapters.map((adapter) => adapter.id));
	return params.builtinAdapters.filter((adapter) => !existingIds.has(adapter.id));
}
//#endregion
//#region extensions/memory-core/src/memory/provider-adapters.ts
const NODE_LLAMA_CPP_RUNTIME_PACKAGE = "node-llama-cpp";
function isNodeLlamaCppMissing(err) {
	if (!(err instanceof Error)) return false;
	return err.code === "ERR_MODULE_NOT_FOUND" && err.message.includes(NODE_LLAMA_CPP_RUNTIME_PACKAGE);
}
function listRemoteEmbeddingSetupHints() {
	try {
		return listMemoryEmbeddingProviders().filter((adapter) => adapter.transport === "remote" && typeof adapter.autoSelectPriority === "number").toSorted((a, b) => (a.autoSelectPriority ?? 0) - (b.autoSelectPriority ?? 0)).map((adapter) => `Or set agents.defaults.memorySearch.provider = "${adapter.id}" (remote).`);
	} catch {
		return [];
	}
}
function formatLocalSetupError(err) {
	const detail = formatErrorMessage(err);
	const missing = isNodeLlamaCppMissing(err);
	return [
		"Local embeddings unavailable.",
		missing ? "Reason: optional dependency node-llama-cpp is missing (or failed to install)." : detail ? `Reason: ${detail}` : void 0,
		missing && detail ? `Detail: ${detail}` : null,
		"To enable local embeddings:",
		"1) Use Node 24 (recommended for installs/updates; Node 22 LTS, currently 22.19+, remains supported)",
		missing ? `2) Install ${NODE_LLAMA_CPP_RUNTIME_PACKAGE} next to the OpenClaw package or source checkout` : null,
		`3) If you use pnpm: pnpm approve-builds (select ${NODE_LLAMA_CPP_RUNTIME_PACKAGE}), then pnpm rebuild ${NODE_LLAMA_CPP_RUNTIME_PACKAGE}`,
		...listRemoteEmbeddingSetupHints()
	].filter(Boolean).join("\n");
}
function canAutoSelectLocal(modelPath) {
	const trimmed = modelPath?.trim();
	if (!trimmed) return false;
	if (/^(hf:|https?:)/i.test(trimmed)) return false;
	const resolved = resolveUserPath(trimmed);
	try {
		return fs.statSync(resolved).isFile();
	} catch {
		return false;
	}
}
const builtinMemoryEmbeddingProviderAdapters = [{
	id: "local",
	defaultModel: DEFAULT_LOCAL_MODEL,
	transport: "local",
	autoSelectPriority: 10,
	formatSetupError: formatLocalSetupError,
	shouldContinueAutoSelection: () => true,
	create: async (options) => {
		const provider = await createLocalEmbeddingProvider({
			...options,
			provider: "local",
			fallback: "none"
		});
		return {
			provider,
			runtime: {
				id: "local",
				inlineQueryTimeoutMs: 5 * 6e4,
				inlineBatchTimeoutMs: 10 * 6e4,
				cacheKeyData: {
					provider: "local",
					model: provider.model
				}
			}
		};
	}
}];
function getBuiltinMemoryEmbeddingProviderAdapter(id) {
	return listMemoryEmbeddingProviders().find((adapter) => adapter.id === id);
}
function registerBuiltInMemoryEmbeddingProviders(register) {
	for (const adapter of filterUnregisteredMemoryEmbeddingProviderAdapters({
		builtinAdapters: builtinMemoryEmbeddingProviderAdapters,
		registeredAdapters: listRegisteredMemoryEmbeddingProviderAdapters()
	})) register.registerMemoryEmbeddingProvider(adapter);
}
function getBuiltinMemoryEmbeddingProviderDoctorMetadata(providerId) {
	const adapter = getBuiltinMemoryEmbeddingProviderAdapter(providerId);
	if (!adapter) return null;
	const authProviderId = adapter.authProviderId ?? adapter.id;
	return {
		providerId: adapter.id,
		authProviderId,
		envVars: getProviderEnvVars(authProviderId),
		transport: adapter.transport === "local" ? "local" : "remote",
		autoSelectPriority: adapter.autoSelectPriority
	};
}
function listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata() {
	return listMemoryEmbeddingProviders().filter((adapter) => typeof adapter.autoSelectPriority === "number").toSorted((a, b) => (a.autoSelectPriority ?? 0) - (b.autoSelectPriority ?? 0)).map((adapter) => {
		const authProviderId = adapter.authProviderId ?? adapter.id;
		return {
			providerId: adapter.id,
			authProviderId,
			envVars: getProviderEnvVars(authProviderId),
			transport: adapter.transport === "local" ? "local" : "remote",
			autoSelectPriority: adapter.autoSelectPriority
		};
	});
}
//#endregion
export { registerBuiltInMemoryEmbeddingProviders as i, getBuiltinMemoryEmbeddingProviderDoctorMetadata as n, listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata as r, canAutoSelectLocal as t };
