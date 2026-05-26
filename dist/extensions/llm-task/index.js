import { c as normalizeOptionalString } from "../../string-coerce-LndEvhRk.js";
import { n as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-C5ctwRKD.js";
import { r as withTempWorkspace } from "../../private-temp-workspace-CS7i2diZ.js";
import { t as validateJsonSchemaValue } from "../../schema-validator-Cf8K6s7f.js";
import { b as resolveModelRefFromString, i as buildModelAliasIndex } from "../../model-selection-shared-Dh1KrVmr.js";
import "../../string-coerce-runtime-Ce59bOpy.js";
import { t as definePluginEntry } from "../../plugin-entry-CJpThfKg.js";
import "../../json-schema-runtime-ChD6ubGI.js";
import "../../agent-runtime-C0lBBqMR.js";
import "../../api-tFe0R5q1.js";
import path from "node:path";
import { Type } from "typebox";
//#region extensions/llm-task/src/llm-task-tool.ts
function stripCodeFences(s) {
	const trimmed = s.trim();
	const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (m) return (m[1] ?? "").trim();
	return trimmed;
}
function collectText(payloads) {
	return (payloads ?? []).filter((p) => !p.isError && typeof p.text === "string").map((p) => p.text ?? "").join("\n").trim();
}
function toModelKey(provider, model) {
	const p = provider?.trim();
	const m = model?.trim();
	if (!p || !m) return;
	return `${p}/${m}`;
}
function stripDuplicateProviderPrefix(provider, model) {
	const p = provider?.trim();
	const m = model?.trim();
	if (!p || !m) return m || void 0;
	const prefix = `${p}/`;
	return m.startsWith(prefix) ? m.slice(prefix.length) : m;
}
function resolveLlmTaskModelRef(params) {
	const defaultProvider = normalizeOptionalString(params.provider) ?? normalizeOptionalString(params.api.runtime.agent.defaults.provider);
	const rawModel = normalizeOptionalString(params.rawModel);
	if (!rawModel || !defaultProvider) return {
		provider: params.provider,
		model: stripDuplicateProviderPrefix(params.provider, rawModel)
	};
	const cfg = params.api.config;
	const resolved = resolveModelRefFromString({
		cfg,
		raw: rawModel,
		defaultProvider,
		aliasIndex: cfg ? buildModelAliasIndex({
			cfg,
			defaultProvider
		}) : void 0
	});
	if (!resolved) return {
		provider: params.provider,
		model: stripDuplicateProviderPrefix(params.provider, rawModel)
	};
	return resolved.ref;
}
function formatThinkingPolicy(policy) {
	return policy.levels.map((level) => level.label).join(", ");
}
function supportsThinkingPolicyLevel(policy, level) {
	return !!level && policy.levels.some((entry) => entry.id === level);
}
function createLlmTaskTool(api) {
	return {
		name: "llm-task",
		label: "LLM Task",
		description: "Run a generic JSON-only LLM task and return schema-validated JSON. Designed for orchestration from Lobster workflows via openclaw.invoke.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Task instruction for the LLM." }),
			input: Type.Optional(Type.Unknown({ description: "Optional input payload for the task." })),
			schema: Type.Optional(Type.Unknown({ description: "Optional JSON Schema to validate the returned JSON." })),
			provider: Type.Optional(Type.String({ description: "Provider override (e.g. openai-codex, anthropic)." })),
			model: Type.Optional(Type.String({ description: "Model id override." })),
			thinking: Type.Optional(Type.String({ description: "Thinking level override." })),
			authProfileId: Type.Optional(Type.String({ description: "Auth profile override." })),
			temperature: Type.Optional(Type.Number({ description: "Best-effort temperature override." })),
			maxTokens: Type.Optional(Type.Number({ description: "Best-effort maxTokens override." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Timeout for the LLM run." }))
		}),
		async execute(_id, params) {
			const prompt = typeof params.prompt === "string" ? params.prompt : "";
			if (!prompt.trim()) throw new Error("prompt required");
			const pluginCfg = api.pluginConfig ?? {};
			const defaultsModel = api.config?.agents?.defaults?.model;
			const primary = typeof defaultsModel === "string" ? normalizeOptionalString(defaultsModel) : normalizeOptionalString(defaultsModel?.primary);
			const primaryProvider = typeof primary === "string" ? primary.split("/")[0] : void 0;
			const primaryModel = typeof primary === "string" ? primary.split("/").slice(1).join("/") : void 0;
			const { provider: resolvedProvider, model } = resolveLlmTaskModelRef({
				api,
				provider: typeof params.provider === "string" && params.provider.trim() || typeof pluginCfg.defaultProvider === "string" && pluginCfg.defaultProvider.trim() || primaryProvider || void 0,
				rawModel: typeof params.model === "string" && params.model.trim() || typeof pluginCfg.defaultModel === "string" && pluginCfg.defaultModel.trim() || primaryModel || void 0
			});
			const provider = resolvedProvider;
			const authProfileId = typeof params.authProfileId === "string" && params.authProfileId.trim() || typeof pluginCfg.defaultAuthProfileId === "string" && pluginCfg.defaultAuthProfileId.trim() || void 0;
			const modelKey = toModelKey(provider, model);
			if (!provider || !model || !modelKey) throw new Error(`provider/model could not be resolved (provider=${provider ?? ""}, model=${model ?? ""})`);
			const allowed = Array.isArray(pluginCfg.allowedModels) ? pluginCfg.allowedModels : void 0;
			if (allowed && allowed.length > 0 && !allowed.includes(modelKey)) throw new Error(`Model not allowed by llm-task plugin config: ${modelKey}. Allowed models: ${allowed.join(", ")}`);
			const thinkingRaw = typeof params.thinking === "string" && params.thinking.trim() ? params.thinking : void 0;
			let thinkLevel = void 0;
			if (thinkingRaw) {
				const thinkingPolicy = api.runtime.agent.resolveThinkingPolicy({
					provider,
					model
				});
				const thinkingLevelsHint = formatThinkingPolicy(thinkingPolicy);
				thinkLevel = api.runtime.agent.normalizeThinkingLevel(thinkingRaw);
				if (!thinkLevel) throw new Error(`Invalid thinking level "${thinkingRaw}". Use one of: ${thinkingLevelsHint}.`);
				if (!supportsThinkingPolicyLevel(thinkingPolicy, thinkLevel)) throw new Error(`Thinking level "${thinkLevel}" is not supported for ${provider}/${model}. Use one of: ${thinkingLevelsHint}.`);
			}
			const timeoutMs = (typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : void 0) || (typeof pluginCfg.timeoutMs === "number" && pluginCfg.timeoutMs > 0 ? pluginCfg.timeoutMs : void 0) || 3e4;
			const streamParams = {
				temperature: typeof params.temperature === "number" ? params.temperature : void 0,
				maxTokens: typeof params.maxTokens === "number" ? params.maxTokens : typeof pluginCfg.maxTokens === "number" ? pluginCfg.maxTokens : void 0
			};
			const input = params.input;
			let inputJson;
			try {
				inputJson = JSON.stringify(input ?? null, null, 2);
			} catch {
				throw new Error("input must be JSON-serializable");
			}
			const fullPrompt = `${[
				"You are a JSON-only function.",
				"Return ONLY a valid JSON value.",
				"Do not wrap in markdown fences.",
				"Do not include commentary.",
				"Do not call tools."
			].join(" ")}\n\nTASK:\n${prompt}\n\nINPUT_JSON:\n${inputJson}\n`;
			return await withTempWorkspace({
				rootDir: resolvePreferredOpenClawTmpDir(),
				prefix: "openclaw-llm-task-"
			}, async ({ dir: tmpDir }) => {
				const sessionId = `llm-task-${Date.now()}`;
				const sessionFile = path.join(tmpDir, "session.json");
				const result = await api.runtime.agent.runEmbeddedPiAgent({
					sessionId,
					sessionFile,
					workspaceDir: api.config?.agents?.defaults?.workspace ?? process.cwd(),
					config: api.config,
					prompt: fullPrompt,
					timeoutMs,
					runId: `llm-task-${Date.now()}`,
					provider,
					model,
					authProfileId,
					authProfileIdSource: authProfileId ? "user" : "auto",
					thinkLevel,
					streamParams,
					disableTools: true
				});
				const text = collectText(typeof result === "object" && result !== null && "payloads" in result ? result.payloads : void 0);
				if (!text) throw new Error("LLM returned empty output");
				const raw = stripCodeFences(text);
				let parsed;
				try {
					parsed = JSON.parse(raw);
				} catch {
					throw new Error("LLM returned invalid JSON");
				}
				const schema = params.schema;
				if (schema && typeof schema === "object" && !Array.isArray(schema)) {
					const validation = validateJsonSchemaValue({
						schema,
						cacheKey: "llm-task.result",
						value: parsed,
						cache: false
					});
					if (!validation.ok) {
						const msg = validation.errors.map((error) => error.text).join("; ") || "invalid";
						throw new Error(`LLM JSON did not match schema: ${msg}`);
					}
				}
				return {
					content: [{
						type: "text",
						text: JSON.stringify(parsed, null, 2)
					}],
					details: {
						json: parsed,
						provider,
						model
					}
				};
			});
		}
	};
}
//#endregion
//#region extensions/llm-task/index.ts
var llm_task_default = definePluginEntry({
	id: "llm-task",
	name: "LLM Task",
	description: "Optional tool for structured subtask execution",
	register(api) {
		api.registerTool(createLlmTaskTool(api), { optional: true });
	}
});
//#endregion
export { llm_task_default as default };
