import { s as init_session_key, t as DEFAULT_AGENT_ID } from "./session-key-BwICpQs5.js";
import { O as resolveStateDir, S as init_paths } from "./logger-D1gzveLR.js";
import { n as init_subsystem, t as createSubsystemLogger } from "./subsystem-0lZt3jI5.js";
import { c as init_utils, g as resolveUserPath } from "./utils-DknlDzAi.js";
import { t as init_retry } from "./retry-CyJj_oar.js";
import path from "node:path";
import fs from "node:fs";
import fs$1 from "node:fs/promises";
//#region src/shared/pid-alive.ts
function isValidPid(pid) {
	return Number.isInteger(pid) && pid > 0;
}
/**
* Check if a process is a zombie on Linux by reading /proc/<pid>/status.
* Returns false on non-Linux platforms or if the proc file can't be read.
*/
function isZombieProcess(pid) {
	if (process.platform !== "linux") return false;
	try {
		return fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^State:\s+(\S)/m)?.[1] === "Z";
	} catch {
		return false;
	}
}
function isPidAlive(pid) {
	if (!isValidPid(pid)) return false;
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	if (isZombieProcess(pid)) return false;
	return true;
}
/**
* Read the process start time (field 22 "starttime") from /proc/<pid>/stat.
* Returns the value in clock ticks since system boot, or null on non-Linux
* platforms or if the proc file can't be read.
*
* This is used to detect PID recycling: if two readings for the same PID
* return different starttimes, the PID has been reused by a different process.
*/
function getProcessStartTime(pid) {
	if (process.platform !== "linux") return null;
	if (!isValidPid(pid)) return null;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const commEndIndex = stat.lastIndexOf(")");
		if (commEndIndex < 0) return null;
		const fields = stat.slice(commEndIndex + 1).trimStart().split(/\s+/);
		const starttime = Number(fields[19]);
		return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/shared/process-scoped-map.ts
function resolveProcessScopedMap(key) {
	const proc = process;
	const existing = proc[key];
	if (existing) return existing;
	const created = /* @__PURE__ */ new Map();
	proc[key] = created;
	return created;
}
//#endregion
//#region src/plugin-sdk/file-lock.ts
const HELD_LOCKS = resolveProcessScopedMap(Symbol.for("openclaw.fileLockHeldLocks"));
function computeDelayMs(retries, attempt) {
	const base = Math.min(retries.maxTimeout, Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt));
	const jitter = retries.randomize ? 1 + Math.random() : 1;
	return Math.min(retries.maxTimeout, Math.round(base * jitter));
}
async function readLockPayload(lockPath) {
	try {
		const raw = await fs$1.readFile(lockPath, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") return null;
		return {
			pid: parsed.pid,
			createdAt: parsed.createdAt
		};
	} catch {
		return null;
	}
}
async function resolveNormalizedFilePath(filePath) {
	const resolved = path.resolve(filePath);
	const dir = path.dirname(resolved);
	await fs$1.mkdir(dir, { recursive: true });
	try {
		const realDir = await fs$1.realpath(dir);
		return path.join(realDir, path.basename(resolved));
	} catch {
		return resolved;
	}
}
async function isStaleLock(lockPath, staleMs) {
	const payload = await readLockPayload(lockPath);
	if (payload?.pid && !isPidAlive(payload.pid)) return true;
	if (payload?.createdAt) {
		const createdAt = Date.parse(payload.createdAt);
		if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleMs) return true;
	}
	try {
		const stat = await fs$1.stat(lockPath);
		return Date.now() - stat.mtimeMs > staleMs;
	} catch {
		return true;
	}
}
async function releaseHeldLock(normalizedFile) {
	const current = HELD_LOCKS.get(normalizedFile);
	if (!current) return;
	current.count -= 1;
	if (current.count > 0) return;
	HELD_LOCKS.delete(normalizedFile);
	await current.handle.close().catch(() => void 0);
	await fs$1.rm(current.lockPath, { force: true }).catch(() => void 0);
}
/** Acquire a re-entrant process-local file lock backed by a `.lock` sidecar file. */
async function acquireFileLock(filePath, options) {
	const normalizedFile = await resolveNormalizedFilePath(filePath);
	const lockPath = `${normalizedFile}.lock`;
	const held = HELD_LOCKS.get(normalizedFile);
	if (held) {
		held.count += 1;
		return {
			lockPath,
			release: () => releaseHeldLock(normalizedFile)
		};
	}
	const attempts = Math.max(1, options.retries.retries + 1);
	for (let attempt = 0; attempt < attempts; attempt += 1) try {
		const handle = await fs$1.open(lockPath, "wx");
		await handle.writeFile(JSON.stringify({
			pid: process.pid,
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		}, null, 2), "utf8");
		HELD_LOCKS.set(normalizedFile, {
			count: 1,
			handle,
			lockPath
		});
		return {
			lockPath,
			release: () => releaseHeldLock(normalizedFile)
		};
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
		if (await isStaleLock(lockPath, options.stale)) {
			await fs$1.rm(lockPath, { force: true }).catch(() => void 0);
			continue;
		}
		if (attempt >= attempts - 1) break;
		await new Promise((resolve) => setTimeout(resolve, computeDelayMs(options.retries, attempt)));
	}
	throw new Error(`file lock timeout for ${normalizedFile}`);
}
/** Run an async callback while holding a file lock, always releasing the lock afterward. */
async function withFileLock(filePath, options, fn) {
	const lock = await acquireFileLock(filePath, options);
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}
//#endregion
//#region src/agents/auth-profiles/constants.ts
init_subsystem();
const AUTH_PROFILE_FILENAME = "auth-profiles.json";
const LEGACY_AUTH_FILENAME = "auth.json";
const QWEN_CLI_PROFILE_ID = "qwen-portal:qwen-cli";
const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";
const AUTH_STORE_LOCK_OPTIONS = {
	retries: {
		retries: 10,
		factor: 2,
		minTimeout: 100,
		maxTimeout: 1e4,
		randomize: true
	},
	stale: 3e4
};
const EXTERNAL_CLI_SYNC_TTL_MS = 900 * 1e3;
const EXTERNAL_CLI_NEAR_EXPIRY_MS = 600 * 1e3;
const log$5 = createSubsystemLogger("agents/auth-profiles");
//#endregion
//#region src/agents/agent-paths.ts
init_paths();
init_session_key();
init_utils();
function resolveOpenClawAgentDir(env = process.env) {
	const override = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
	if (override) return resolveUserPath(override, env);
	return resolveUserPath(path.join(resolveStateDir(env), "agents", DEFAULT_AGENT_ID, "agent"), env);
}
//#endregion
//#region src/providers/kilocode-shared.ts
const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
//#endregion
//#region src/agents/ollama-defaults.ts
const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
const OLLAMA_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const OLLAMA_SHOW_CONCURRENCY$1 = 8;
/**
* Derive the Ollama native API base URL from a configured base URL.
*
* Users typically configure `baseUrl` with a `/v1` suffix (e.g.
* `http://192.168.20.14:11434/v1`) for the OpenAI-compatible endpoint.
* The native Ollama API lives at the root (e.g. `/api/tags`), so we
* strip the `/v1` suffix when present.
*/
function resolveOllamaApiBase(configuredBaseUrl) {
	if (!configuredBaseUrl) return OLLAMA_DEFAULT_BASE_URL;
	return configuredBaseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}
async function queryOllamaContextWindow(apiBase, modelName) {
	try {
		const response = await fetch(`${apiBase}/api/show`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: modelName }),
			signal: AbortSignal.timeout(3e3)
		});
		if (!response.ok) return;
		const data = await response.json();
		if (!data.model_info) return;
		for (const [key, value] of Object.entries(data.model_info)) if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value)) {
			const contextWindow = Math.floor(value);
			if (contextWindow > 0) return contextWindow;
		}
		return;
	} catch {
		return;
	}
}
async function enrichOllamaModelsWithContext(apiBase, models, opts) {
	const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? OLLAMA_SHOW_CONCURRENCY$1));
	const enriched = [];
	for (let index = 0; index < models.length; index += concurrency) {
		const batch = models.slice(index, index + concurrency);
		const batchResults = await Promise.all(batch.map(async (model) => ({
			...model,
			contextWindow: await queryOllamaContextWindow(apiBase, model.name)
		})));
		enriched.push(...batchResults);
	}
	return enriched;
}
/** Heuristic: treat models with "r1", "reasoning", or "think" in the name as reasoning models. */
function isReasoningModelHeuristic(modelId) {
	return /r1|reasoning|think|reason/i.test(modelId);
}
/** Build a ModelDefinitionConfig for an Ollama model with default values. */
function buildOllamaModelDefinition(modelId, contextWindow) {
	return {
		id: modelId,
		name: modelId,
		reasoning: isReasoningModelHeuristic(modelId),
		input: ["text"],
		cost: OLLAMA_DEFAULT_COST,
		contextWindow: contextWindow ?? 128e3,
		maxTokens: OLLAMA_DEFAULT_MAX_TOKENS
	};
}
/** Fetch the model list from a running Ollama instance. */
async function fetchOllamaModels(baseUrl) {
	try {
		const apiBase = resolveOllamaApiBase(baseUrl);
		const response = await fetch(`${apiBase}/api/tags`, { signal: AbortSignal.timeout(5e3) });
		if (!response.ok) return {
			reachable: true,
			models: []
		};
		return {
			reachable: true,
			models: ((await response.json()).models ?? []).filter((m) => m.name)
		};
	} catch {
		return {
			reachable: false,
			models: []
		};
	}
}
//#endregion
//#region src/agents/huggingface-models.ts
init_subsystem();
createSubsystemLogger("huggingface-models");
//#endregion
//#region src/agents/kilocode-models.ts
init_subsystem();
createSubsystemLogger("kilocode-models");
`${KILOCODE_BASE_URL}`;
//#endregion
//#region src/agents/self-hosted-provider-defaults.ts
const SELF_HOSTED_DEFAULT_CONTEXT_WINDOW = 128e3;
const SELF_HOSTED_DEFAULT_MAX_TOKENS = 8192;
const SELF_HOSTED_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const SGLANG_PROVIDER_LABEL = "SGLang";
//#endregion
//#region src/agents/venice-models.ts
init_retry();
init_subsystem();
createSubsystemLogger("venice-models");
//#endregion
//#region src/agents/vercel-ai-gateway.ts
init_subsystem();
createSubsystemLogger("agents/vercel-ai-gateway");
//#endregion
//#region src/agents/vllm-defaults.ts
const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
const VLLM_PROVIDER_LABEL = "vLLM";
const VLLM_DEFAULT_API_KEY_ENV_VAR = "VLLM_API_KEY";
const VLLM_MODEL_PLACEHOLDER = "meta-llama/Meta-Llama-3-8B-Instruct";
//#endregion
//#region src/agents/models-config.providers.discovery.ts
init_subsystem();
const log = createSubsystemLogger("agents/model-providers");
const OLLAMA_SHOW_CONCURRENCY = 8;
const OLLAMA_SHOW_MAX_MODELS = 200;
async function discoverOllamaModels(baseUrl, opts) {
	if (process.env.VITEST || false) return [];
	try {
		const apiBase = resolveOllamaApiBase(baseUrl);
		const response = await fetch(`${apiBase}/api/tags`, { signal: AbortSignal.timeout(5e3) });
		if (!response.ok) {
			if (!opts?.quiet) log.warn(`Failed to discover Ollama models: ${response.status}`);
			return [];
		}
		const data = await response.json();
		if (!data.models || data.models.length === 0) {
			log.debug("No Ollama models found on local instance");
			return [];
		}
		const modelsToInspect = data.models.slice(0, OLLAMA_SHOW_MAX_MODELS);
		if (modelsToInspect.length < data.models.length && !opts?.quiet) log.warn(`Capping Ollama /api/show inspection to ${OLLAMA_SHOW_MAX_MODELS} models (received ${data.models.length})`);
		return (await enrichOllamaModelsWithContext(apiBase, modelsToInspect, { concurrency: OLLAMA_SHOW_CONCURRENCY })).map((model) => ({
			id: model.name,
			name: model.name,
			reasoning: isReasoningModelHeuristic(model.name),
			input: ["text"],
			cost: OLLAMA_DEFAULT_COST,
			contextWindow: model.contextWindow ?? 128e3,
			maxTokens: OLLAMA_DEFAULT_MAX_TOKENS
		}));
	} catch (error) {
		if (!opts?.quiet) log.warn(`Failed to discover Ollama models: ${String(error)}`);
		return [];
	}
}
async function discoverOpenAICompatibleLocalModels(params) {
	if (process.env.VITEST || false) return [];
	const url = `${params.baseUrl.trim().replace(/\/+$/, "")}/models`;
	try {
		const trimmedApiKey = params.apiKey?.trim();
		const response = await fetch(url, {
			headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : void 0,
			signal: AbortSignal.timeout(5e3)
		});
		if (!response.ok) {
			log.warn(`Failed to discover ${params.label} models: ${response.status}`);
			return [];
		}
		const models = (await response.json()).data ?? [];
		if (models.length === 0) {
			log.warn(`No ${params.label} models found on local instance`);
			return [];
		}
		return models.map((model) => ({ id: typeof model.id === "string" ? model.id.trim() : "" })).filter((model) => Boolean(model.id)).map((model) => {
			const modelId = model.id;
			return {
				id: modelId,
				name: modelId,
				reasoning: isReasoningModelHeuristic(modelId),
				input: ["text"],
				cost: SELF_HOSTED_DEFAULT_COST,
				contextWindow: params.contextWindow ?? 128e3,
				maxTokens: params.maxTokens ?? 8192
			};
		});
	} catch (error) {
		log.warn(`Failed to discover ${params.label} models: ${String(error)}`);
		return [];
	}
}
async function buildOllamaProvider(configuredBaseUrl, opts) {
	const models = await discoverOllamaModels(configuredBaseUrl, opts);
	return {
		baseUrl: resolveOllamaApiBase(configuredBaseUrl),
		api: "ollama",
		models
	};
}
async function buildVllmProvider(params) {
	const baseUrl = (params?.baseUrl?.trim() || "http://127.0.0.1:8000/v1").replace(/\/+$/, "");
	return {
		baseUrl,
		api: "openai-completions",
		models: await discoverOpenAICompatibleLocalModels({
			baseUrl,
			apiKey: params?.apiKey,
			label: VLLM_PROVIDER_LABEL
		})
	};
}
async function buildSglangProvider(params) {
	const baseUrl = (params?.baseUrl?.trim() || "http://127.0.0.1:30000/v1").replace(/\/+$/, "");
	return {
		baseUrl,
		api: "openai-completions",
		models: await discoverOpenAICompatibleLocalModels({
			baseUrl,
			apiKey: params?.apiKey,
			label: SGLANG_PROVIDER_LABEL
		})
	};
}
//#endregion
//#region src/infra/json-file.ts
function loadJsonFile(pathname) {
	try {
		if (!fs.existsSync(pathname)) return;
		const raw = fs.readFileSync(pathname, "utf8");
		return JSON.parse(raw);
	} catch {
		return;
	}
}
function saveJsonFile(pathname, data) {
	const dir = path.dirname(pathname);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	fs.writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	fs.chmodSync(pathname, 384);
}
//#endregion
//#region src/agents/auth-profiles/paths.ts
init_utils();
function resolveAuthStorePath(agentDir) {
	const resolved = resolveUserPath(agentDir ?? resolveOpenClawAgentDir());
	return path.join(resolved, AUTH_PROFILE_FILENAME);
}
function resolveLegacyAuthStorePath(agentDir) {
	const resolved = resolveUserPath(agentDir ?? resolveOpenClawAgentDir());
	return path.join(resolved, LEGACY_AUTH_FILENAME);
}
function resolveAuthStorePathForDisplay(agentDir) {
	const pathname = resolveAuthStorePath(agentDir);
	return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}
function ensureAuthStoreFile(pathname) {
	if (fs.existsSync(pathname)) return;
	saveJsonFile(pathname, {
		version: 1,
		profiles: {}
	});
}
//#endregion
export { withFileLock as A, AUTH_STORE_LOCK_OPTIONS as C, QWEN_CLI_PROFILE_ID as D, MINIMAX_CLI_PROFILE_ID as E, getProcessStartTime as M, isPidAlive as N, log$5 as O, resolveOpenClawAgentDir as S, EXTERNAL_CLI_SYNC_TTL_MS as T, buildOllamaModelDefinition as _, loadJsonFile as a, resolveOllamaApiBase as b, buildSglangProvider as c, VLLM_DEFAULT_BASE_URL as d, VLLM_MODEL_PLACEHOLDER as f, SELF_HOSTED_DEFAULT_MAX_TOKENS as g, SELF_HOSTED_DEFAULT_COST as h, resolveLegacyAuthStorePath as i, resolveProcessScopedMap as j, acquireFileLock as k, buildVllmProvider as l, SELF_HOSTED_DEFAULT_CONTEXT_WINDOW as m, resolveAuthStorePath as n, saveJsonFile as o, VLLM_PROVIDER_LABEL as p, resolveAuthStorePathForDisplay as r, buildOllamaProvider as s, ensureAuthStoreFile as t, VLLM_DEFAULT_API_KEY_ENV_VAR as u, enrichOllamaModelsWithContext as v, EXTERNAL_CLI_NEAR_EXPIRY_MS as w, OLLAMA_DEFAULT_BASE_URL as x, fetchOllamaModels as y };
