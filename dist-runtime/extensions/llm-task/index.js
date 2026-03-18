import "../../provider-env-vars-BfZUtZAn.js";
import "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import { n as init_tmp_openclaw_dir, r as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../paths-DAoqckDF.js";
import { Gm as formatXHighModelHint, Km as normalizeThinkLevel, f as formatThinkingLevels, jn as runEmbeddedPiAgent, p as supportsXHighThinking } from "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import path from "node:path";
import fs from "node:fs/promises";
import Ajv from "ajv";
import { Type } from "@sinclair/typebox";
//#region src/plugin-sdk/llm-task.ts
init_tmp_openclaw_dir();
//#endregion
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
			const primary = typeof defaultsModel === "string" ? defaultsModel.trim() : defaultsModel?.primary?.trim() ?? void 0;
			const primaryProvider = typeof primary === "string" ? primary.split("/")[0] : void 0;
			const primaryModel = typeof primary === "string" ? primary.split("/").slice(1).join("/") : void 0;
			const provider = typeof params.provider === "string" && params.provider.trim() || typeof pluginCfg.defaultProvider === "string" && pluginCfg.defaultProvider.trim() || primaryProvider || void 0;
			const model = typeof params.model === "string" && params.model.trim() || typeof pluginCfg.defaultModel === "string" && pluginCfg.defaultModel.trim() || primaryModel || void 0;
			const authProfileId = typeof params.authProfileId === "string" && params.authProfileId.trim() || typeof pluginCfg.defaultAuthProfileId === "string" && pluginCfg.defaultAuthProfileId.trim() || void 0;
			const modelKey = toModelKey(provider, model);
			if (!provider || !model || !modelKey) throw new Error(`provider/model could not be resolved (provider=${String(provider ?? "")}, model=${String(model ?? "")})`);
			const allowed = Array.isArray(pluginCfg.allowedModels) ? pluginCfg.allowedModels : void 0;
			if (allowed && allowed.length > 0 && !allowed.includes(modelKey)) throw new Error(`Model not allowed by llm-task plugin config: ${modelKey}. Allowed models: ${allowed.join(", ")}`);
			const thinkingRaw = typeof params.thinking === "string" && params.thinking.trim() ? params.thinking : void 0;
			const thinkLevel = thinkingRaw ? normalizeThinkLevel(thinkingRaw) : void 0;
			if (thinkingRaw && !thinkLevel) throw new Error(`Invalid thinking level "${thinkingRaw}". Use one of: ${formatThinkingLevels(provider, model)}.`);
			if (thinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) throw new Error(`Thinking level "xhigh" is only supported for ${formatXHighModelHint()}.`);
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
			let tmpDir = null;
			try {
				tmpDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-llm-task-"));
				const text = collectText((await runEmbeddedPiAgent({
					sessionId: `llm-task-${Date.now()}`,
					sessionFile: path.join(tmpDir, "session.json"),
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
				})).payloads);
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
					const validate = new Ajv.default({
						allErrors: true,
						strict: false
					}).compile(schema);
					if (!validate(parsed)) {
						const msg = validate.errors?.map((e) => `${e.instancePath || "<root>"} ${e.message || "invalid"}`).join("; ") ?? "invalid";
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
			} finally {
				if (tmpDir) try {
					await fs.rm(tmpDir, {
						recursive: true,
						force: true
					});
				} catch {}
			}
		}
	};
}
//#endregion
//#region extensions/llm-task/index.ts
function register(api) {
	api.registerTool(createLlmTaskTool(api), { optional: true });
}
//#endregion
export { register as default };
