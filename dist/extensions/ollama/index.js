import { n as isWSL2Sync } from "../../wsl-2-jVkfxN.js";
import { r as describeImagesWithModel, t as describeImageWithModel } from "../../image-runtime-Dye6Uj6e.js";
import "../../media-understanding-C_qxfCIa.js";
import { a as buildOpenAICompatibleReplayPolicy } from "../../provider-replay-helpers-BHVsUct1.js";
import "../../runtime-env-BtvWnLRh.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { r as OPENAI_COMPATIBLE_REPLAY_HOOKS } from "../../provider-model-shared-DtsPmvDx.js";
import { n as buildApiKeyCredential } from "../../provider-auth-helpers-BZ5Z8RV6.js";
import "../../provider-auth-BtRKd5us.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-DWa7yCpn.js";
import "../../defaults-Ct4-oW82.js";
import { i as buildOllamaProvider, l as queryOllamaModelShowInfo, r as buildOllamaModelDefinition, t as readProviderBaseUrl } from "../../provider-base-url-CrecHiog.js";
import { i as promptAndConfigureOllama, n as configureOllamaNonInteractive, r as ensureOllamaModelPulled } from "../../setup-fXWhcJhl.js";
import { d as resolveConfiguredOllamaProviderConfig, l as isOllamaCompatProvider, o as createConfiguredOllamaCompatStreamWrapper, s as createConfiguredOllamaStreamFn } from "../../stream-DcS_ejJS.js";
import "../../api-FTzA6POj.js";
import { n as resolveThinkingProfile } from "../../provider-policy-api-B-HOzv3B.js";
import { i as shouldUseSyntheticOllamaAuth, n as OLLAMA_PROVIDER_ID, r as resolveOllamaDiscoveryResult, t as OLLAMA_DEFAULT_API_KEY } from "../../discovery-shared-ROvQIBGQ.js";
import { n as createOllamaEmbeddingProvider, t as DEFAULT_OLLAMA_EMBEDDING_MODEL } from "../../embedding-provider-CvVtKgB6.js";
import { t as createOllamaWebSearchProvider } from "../../web-search-provider-qpePEaOb.js";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region extensions/ollama/src/media-understanding-provider.ts
const ollamaMediaUnderstandingProvider = {
	id: OLLAMA_PROVIDER_ID,
	capabilities: ["image"],
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel
};
//#endregion
//#region extensions/ollama/src/memory-embedding-adapter.ts
const ollamaMemoryEmbeddingProviderAdapter = {
	id: "ollama",
	defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
	transport: "remote",
	authProviderId: "ollama",
	create: async (options) => {
		const { provider, client } = await createOllamaEmbeddingProvider({
			...options,
			provider: "ollama",
			fallback: "none"
		});
		return {
			provider,
			runtime: {
				id: "ollama",
				inlineBatchTimeoutMs: 10 * 6e4,
				cacheKeyData: {
					provider: "ollama",
					model: client.model
				}
			}
		};
	}
};
//#endregion
//#region extensions/ollama/src/wsl2-crash-loop-check.ts
const execFileAsync = promisify(execFile);
const SYSTEMCTL_TIMEOUT_MS = 5e3;
const WSL_CUDA_MARKERS = [
	"/dev/dxg",
	"/usr/lib/wsl/lib/nvidia-smi",
	"/usr/lib/wsl/lib/libcuda.so.1",
	"/usr/local/cuda"
];
function parseSystemctlShowProperties(stdout) {
	const properties = /* @__PURE__ */ new Map();
	for (const line of stdout.split(/\r?\n/u)) {
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		properties.set(line.slice(0, separator), line.slice(separator + 1));
	}
	return properties;
}
async function isOllamaEnabledWithRestartAlways() {
	try {
		const { stdout } = await execFileAsync("systemctl", [
			"show",
			"ollama.service",
			"--property=UnitFileState,Restart",
			"--no-pager"
		], { timeout: SYSTEMCTL_TIMEOUT_MS });
		const properties = parseSystemctlShowProperties(stdout);
		return properties.get("UnitFileState") === "enabled" && properties.get("Restart") === "always";
	} catch {
		return false;
	}
}
async function hasWslCuda() {
	for (const marker of WSL_CUDA_MARKERS) try {
		await access(marker);
		return true;
	} catch {}
	return false;
}
async function checkWsl2CrashLoopRisk(logger) {
	try {
		if (!isWSL2Sync()) return;
		if (!await isOllamaEnabledWithRestartAlways()) return;
		if (!await hasWslCuda()) return;
		logger.warn([
			"[ollama] WSL2 crash-loop risk: ollama.service is enabled with Restart=always and CUDA is visible.",
			"On WSL2, GPU-backed Ollama can pin host memory while loading a model.",
			"Hyper-V memory reclaim cannot always reclaim those pinned pages, so Windows can terminate and restart the WSL2 VM.",
			"",
			"Common evidence: repeated WSL2 reboots, high CPU in app.slice at startup, and SIGTERM from systemd rather than the Linux OOM killer.",
			"See: https://github.com/ollama/ollama/issues/11317",
			"",
			"Mitigation:",
			"  1. Disable autostart: sudo systemctl disable ollama",
			"  2. Add [experimental] autoMemoryReclaim=disabled to %USERPROFILE%\\.wslconfig on Windows, then run wsl --shutdown",
			"  3. Set OLLAMA_KEEP_ALIVE=5m in the Ollama service environment or start ollama serve manually when needed"
		].join("\n"));
	} catch {}
}
//#endregion
//#region extensions/ollama/index.ts
function usesOllamaOpenAICompatTransport(model) {
	return model.api === "openai-completions" && isOllamaCompatProvider({
		provider: typeof model.provider === "string" ? model.provider : void 0,
		baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : void 0,
		api: "openai-completions"
	});
}
function buildNativeOllamaReplayPolicy() {
	return {
		...buildOpenAICompatibleReplayPolicy("openai-completions", { sanitizeToolCallIds: false }),
		sanitizeToolCallIds: false
	};
}
const dynamicModelCache = /* @__PURE__ */ new Map();
function buildDynamicCacheKey(provider, baseUrl) {
	return `${provider}\0${baseUrl ?? ""}`;
}
function hasOllamaDiscoverySignal(providerConfig) {
	return Boolean(process.env.OLLAMA_API_KEY?.trim()) || shouldUseSyntheticOllamaAuth(providerConfig) || Boolean(providerConfig?.apiKey);
}
function toDynamicOllamaModel(params) {
	const input = (params.model.input ?? ["text"]).filter((value) => value === "text" || value === "image");
	return {
		id: params.model.id,
		name: params.model.name ?? params.model.id,
		provider: params.provider,
		api: "ollama",
		baseUrl: readProviderBaseUrl(params.providerConfig) ?? "",
		reasoning: params.model.reasoning ?? false,
		input: input.length > 0 ? input : ["text"],
		cost: params.model.cost ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: params.model.contextWindow ?? 8192,
		maxTokens: params.model.maxTokens ?? 8192,
		...params.model.compat ? { compat: params.model.compat } : {},
		...params.model.params ? { params: params.model.params } : {}
	};
}
async function resolveRequestedDynamicOllamaModel(params) {
	const showInfo = await queryOllamaModelShowInfo(readProviderBaseUrl(params.providerConfig) ?? "http://127.0.0.1:11434", params.modelId);
	if (typeof showInfo.contextWindow !== "number" && (showInfo.capabilities?.length ?? 0) === 0) return;
	return toDynamicOllamaModel({
		provider: params.provider,
		providerConfig: params.providerConfig,
		model: buildOllamaModelDefinition(params.modelId, showInfo.contextWindow, showInfo.capabilities)
	});
}
var ollama_default = definePluginEntry({
	id: "ollama",
	name: "Ollama Provider",
	description: "Bundled Ollama provider plugin",
	register(api) {
		if (api.registrationMode === "full") checkWsl2CrashLoopRisk(api.logger);
		api.registerMemoryEmbeddingProvider(ollamaMemoryEmbeddingProviderAdapter);
		api.registerMediaUnderstandingProvider(ollamaMediaUnderstandingProvider);
		const startupPluginConfig = api.pluginConfig ?? {};
		const resolveCurrentPluginConfig = (config) => {
			const runtimePluginConfig = resolvePluginConfigObject(config, "ollama");
			if (runtimePluginConfig) return runtimePluginConfig;
			return config ? {} : startupPluginConfig;
		};
		api.registerWebSearchProvider(createOllamaWebSearchProvider());
		api.registerProvider({
			id: OLLAMA_PROVIDER_ID,
			label: "Ollama",
			docsPath: "/providers/ollama",
			envVars: ["OLLAMA_API_KEY"],
			auth: [{
				id: "local",
				label: "Ollama",
				hint: "Cloud and local open models",
				kind: "custom",
				run: async (ctx) => {
					const result = await promptAndConfigureOllama({
						cfg: ctx.config,
						env: ctx.env,
						opts: ctx.opts,
						prompter: ctx.prompter,
						secretInputMode: ctx.secretInputMode,
						allowSecretRefPrompt: ctx.allowSecretRefPrompt
					});
					return {
						profiles: [{
							profileId: "ollama:default",
							credential: buildApiKeyCredential(OLLAMA_PROVIDER_ID, result.credential, void 0, result.credentialMode ? {
								secretInputMode: result.credentialMode,
								config: ctx.config
							} : void 0)
						}],
						configPatch: result.config
					};
				},
				runNonInteractive: async (ctx) => {
					return await configureOllamaNonInteractive({
						nextConfig: ctx.config,
						opts: {
							customBaseUrl: ctx.opts.customBaseUrl,
							customModelId: ctx.opts.customModelId
						},
						runtime: ctx.runtime,
						agentDir: ctx.agentDir
					});
				}
			}],
			catalog: {
				order: "late",
				run: async (ctx) => await resolveOllamaDiscoveryResult({
					ctx,
					pluginConfig: resolveCurrentPluginConfig(ctx.config),
					buildProvider: buildOllamaProvider
				})
			},
			wizard: {
				setup: {
					choiceId: "ollama",
					choiceLabel: "Ollama",
					choiceHint: "Cloud and local open models",
					groupId: "ollama",
					groupLabel: "Ollama",
					groupHint: "Cloud and local open models",
					methodId: "local",
					modelSelection: {
						promptWhenAuthChoiceProvided: true,
						allowKeepCurrent: false
					}
				},
				modelPicker: {
					label: "Ollama (custom)",
					hint: "Detect models from a local or remote Ollama instance",
					methodId: "local"
				}
			},
			onModelSelected: async ({ config, model, prompter }) => {
				if (!model.startsWith("ollama/")) return;
				await ensureOllamaModelPulled({
					config,
					model,
					prompter
				});
			},
			createStreamFn: ({ config, model, provider }) => {
				return createConfiguredOllamaStreamFn({
					model,
					providerBaseUrl: readProviderBaseUrl(resolveConfiguredOllamaProviderConfig({
						config,
						providerId: provider
					}))
				});
			},
			...OPENAI_COMPATIBLE_REPLAY_HOOKS,
			buildReplayPolicy: (ctx) => ctx.modelApi === "ollama" ? buildNativeOllamaReplayPolicy() : buildOpenAICompatibleReplayPolicy(ctx.modelApi),
			contributeResolvedModelCompat: ({ model }) => usesOllamaOpenAICompatTransport(model) ? { supportsUsageInStreaming: true } : void 0,
			resolveReasoningOutputMode: () => "native",
			resolveThinkingProfile,
			wrapStreamFn: createConfiguredOllamaCompatStreamWrapper,
			createEmbeddingProvider: async ({ config, model, provider: embeddingProvider, remote }) => {
				const { provider, client } = await createOllamaEmbeddingProvider({
					config,
					remote,
					model: model || "nomic-embed-text",
					provider: embeddingProvider || "ollama"
				});
				return {
					...provider,
					client
				};
			},
			matchesContextOverflowError: ({ errorMessage }) => /\bollama\b.*(?:context length|too many tokens|context window)/i.test(errorMessage) || /\btruncating input\b.*\btoo long\b/i.test(errorMessage),
			resolveSyntheticAuth: ({ provider, providerConfig }) => {
				if (!shouldUseSyntheticOllamaAuth(providerConfig)) return;
				return {
					apiKey: OLLAMA_DEFAULT_API_KEY,
					source: `models.providers.${provider ?? "ollama"} (synthetic local key)`,
					mode: "api-key"
				};
			},
			shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) => resolvedApiKey?.trim() === OLLAMA_DEFAULT_API_KEY,
			prepareDynamicModel: async (ctx) => {
				const providerConfig = resolveConfiguredOllamaProviderConfig({
					config: ctx.config,
					providerId: ctx.provider
				});
				if (!hasOllamaDiscoverySignal(providerConfig)) return;
				const baseUrl = readProviderBaseUrl(providerConfig);
				const provider = await buildOllamaProvider(baseUrl, { quiet: true });
				const dynamicModels = (provider.models ?? []).map((model) => toDynamicOllamaModel({
					provider: ctx.provider,
					providerConfig: provider,
					model
				}));
				if (!dynamicModels.some((model) => model.id === ctx.modelId)) {
					const requestedModel = await resolveRequestedDynamicOllamaModel({
						provider: ctx.provider,
						providerConfig: provider,
						modelId: ctx.modelId
					});
					if (requestedModel) dynamicModels.push(requestedModel);
				}
				dynamicModelCache.set(buildDynamicCacheKey(ctx.provider, baseUrl), dynamicModels);
			},
			resolveDynamicModel: (ctx) => {
				const providerConfig = resolveConfiguredOllamaProviderConfig({
					config: ctx.config,
					providerId: ctx.provider
				});
				return dynamicModelCache.get(buildDynamicCacheKey(ctx.provider, readProviderBaseUrl(providerConfig)))?.find((model) => model.id === ctx.modelId);
			},
			buildUnknownModelHint: () => "Ollama requires authentication to be registered as a provider. Set OLLAMA_API_KEY=\"ollama-local\" (any value works) or run \"openclaw configure\". See: https://docs.openclaw.ai/providers/ollama"
		});
	}
});
//#endregion
export { ollama_default as default };
