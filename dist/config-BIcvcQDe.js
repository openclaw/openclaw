import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
//#region extensions/memory-lancedb/config.ts
const MEMORY_CATEGORIES = [
	"preference",
	"fact",
	"decision",
	"entity",
	"other"
];
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_CAPTURE_MAX_CHARS = 500;
const DEFAULT_RECALL_MAX_CHARS = 1e3;
const LEGACY_STATE_DIRS = [];
function resolveDefaultDbPath() {
	const home = homedir();
	const preferred = join(home, ".openclaw", "memory", "lancedb");
	try {
		if (fs.existsSync(preferred)) return preferred;
	} catch {}
	for (const legacy of LEGACY_STATE_DIRS) {
		const candidate = join(home, legacy, "memory", "lancedb");
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {}
	}
	return preferred;
}
const DEFAULT_DB_PATH = resolveDefaultDbPath();
const EMBEDDING_DIMENSIONS = {
	"text-embedding-3-small": 1536,
	"text-embedding-3-large": 3072
};
const EMBEDDING_CONFIG_KEYS = [
	"provider",
	"apiKey",
	"model",
	"baseUrl",
	"dimensions"
];
function assertAllowedKeys(value, allowed, label) {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length === 0) return;
	throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}
function vectorDimsForModel(model) {
	const dims = EMBEDDING_DIMENSIONS[model];
	if (!dims) throw new Error(`Unsupported embedding model: ${model}`);
	return dims;
}
function resolveEnvVars(value) {
	return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
		const envValue = process.env[envVar];
		if (!envValue) throw new Error(`Environment variable ${envVar} is not set`);
		return envValue;
	});
}
function resolveEmbeddingModel(embedding) {
	const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
	if (typeof embedding.dimensions !== "number") vectorDimsForModel(model);
	return model;
}
const memoryConfigSchema = {
	parse(value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("memory config required");
		const cfg = value;
		assertAllowedKeys(cfg, [
			"embedding",
			"dreaming",
			"dbPath",
			"autoCapture",
			"autoRecall",
			"captureMaxChars",
			"recallMaxChars",
			"storageOptions"
		], "memory config");
		const embedding = cfg.embedding;
		if (!embedding || typeof embedding !== "object" || Array.isArray(embedding)) throw new Error("embedding config required");
		assertAllowedKeys(embedding, [...EMBEDDING_CONFIG_KEYS], "embedding config");
		if (Object.keys(embedding).length === 0) throw new Error("embedding config must include at least one setting");
		const model = resolveEmbeddingModel(embedding);
		const provider = typeof embedding.provider === "string" ? embedding.provider.trim() : "openai";
		if (!provider) throw new Error("embedding.provider must not be empty");
		const captureMaxChars = typeof cfg.captureMaxChars === "number" ? Math.floor(cfg.captureMaxChars) : void 0;
		const recallMaxChars = typeof cfg.recallMaxChars === "number" ? Math.floor(cfg.recallMaxChars) : void 0;
		if (typeof captureMaxChars === "number" && (captureMaxChars < 100 || captureMaxChars > 1e4)) throw new Error("captureMaxChars must be between 100 and 10000");
		if (typeof recallMaxChars === "number" && (recallMaxChars < 100 || recallMaxChars > 1e4)) throw new Error("recallMaxChars must be between 100 and 10000");
		const dreaming = cfg.dreaming === void 0 ? void 0 : cfg.dreaming && typeof cfg.dreaming === "object" && !Array.isArray(cfg.dreaming) ? cfg.dreaming : (() => {
			throw new Error("dreaming config must be an object");
		})();
		let storageOptions;
		const storageOpts = cfg.storageOptions;
		if (storageOpts !== void 0 && storageOpts !== null) {
			if (!storageOpts || typeof storageOpts !== "object" || Array.isArray(storageOpts)) throw new Error("storageOptions must be an object");
			storageOptions = {};
			for (const [key, value] of Object.entries(storageOpts)) {
				if (typeof value !== "string") throw new Error(`storageOptions.${key} must be a string`);
				storageOptions[key] = resolveEnvVars(value);
			}
		}
		return {
			embedding: {
				provider,
				model,
				apiKey: typeof embedding.apiKey === "string" ? resolveEnvVars(embedding.apiKey) : void 0,
				baseUrl: typeof embedding.baseUrl === "string" ? resolveEnvVars(embedding.baseUrl) : void 0,
				dimensions: typeof embedding.dimensions === "number" ? embedding.dimensions : void 0
			},
			dreaming,
			dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
			autoCapture: cfg.autoCapture === true,
			autoRecall: cfg.autoRecall !== false,
			captureMaxChars: captureMaxChars ?? 500,
			recallMaxChars: recallMaxChars ?? 1e3,
			...storageOptions ? { storageOptions } : {}
		};
	},
	uiHints: {
		"embedding.provider": {
			label: "Embedding Provider",
			placeholder: "openai",
			help: "Memory embedding provider adapter to use (for example openai, github-copilot, ollama)"
		},
		"embedding.apiKey": {
			label: "OpenAI API Key",
			sensitive: true,
			placeholder: "sk-proj-...",
			help: "Optional API key override for OpenAI-compatible embeddings; omit to use configured provider auth"
		},
		"embedding.baseUrl": {
			label: "Base URL",
			placeholder: "https://api.openai.com/v1",
			help: "Optional provider or OpenAI-compatible embedding endpoint base URL",
			advanced: true
		},
		"embedding.dimensions": {
			label: "Dimensions",
			placeholder: "1536",
			help: "Vector dimensions for custom models (required for non-standard models)",
			advanced: true
		},
		"embedding.model": {
			label: "Embedding Model",
			placeholder: DEFAULT_MODEL,
			help: "OpenAI embedding model to use"
		},
		dbPath: {
			label: "Database Path",
			placeholder: "~/.openclaw/memory/lancedb",
			advanced: true,
			help: "Local filesystem path or cloud storage URI (s3://, gs://) for LanceDB database"
		},
		autoCapture: {
			label: "Auto-Capture",
			help: "Automatically capture important information from conversations"
		},
		autoRecall: {
			label: "Auto-Recall",
			help: "Automatically inject relevant memories into context"
		},
		captureMaxChars: {
			label: "Capture Max Chars",
			help: "Maximum message length eligible for auto-capture",
			advanced: true,
			placeholder: String(500)
		},
		recallMaxChars: {
			label: "Recall Query Max Chars",
			help: "Maximum prompt/query length embedded for memory recall. Lower for small local embedding models.",
			advanced: true,
			placeholder: String(DEFAULT_RECALL_MAX_CHARS)
		},
		storageOptions: {
			label: "Storage Options",
			sensitive: true,
			advanced: true,
			help: "Storage configuration options (access_key, secret_key, endpoint, etc.); supports ${ENV_VAR} values"
		}
	}
};
//#endregion
export { vectorDimsForModel as a, memoryConfigSchema as i, DEFAULT_RECALL_MAX_CHARS as n, MEMORY_CATEGORIES as r, DEFAULT_CAPTURE_MAX_CHARS as t };
