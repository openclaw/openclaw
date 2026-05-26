import { t as resolveConfiguredSecretInputString } from "./resolve-configured-secret-input-string-DuewGZmy.js";
import { s as buildCopilotIdeHeaders } from "./copilot-dynamic-headers-CVy4X1Kj.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { o as resolveCopilotApiToken } from "./provider-auth-BtRKd5us.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { C as withRemoteHttpResponse, D as sanitizeAndNormalizeEmbedding, S as buildRemoteBaseUrlPolicy } from "./memory-core-host-engine-embeddings-C9DVPPfR.js";
import "./secret-input-runtime-BxNajKSO.js";
import { t as resolveFirstGithubToken } from "./auth-BXReeF2O.js";
import "./token-DhBIY8GB.js";
//#region extensions/github-copilot/embeddings.ts
const COPILOT_EMBEDDING_PROVIDER_ID = "github-copilot";
/**
* Preferred embedding models in order. The first available model wins.
*/
const PREFERRED_MODELS = [
	"text-embedding-3-small",
	"text-embedding-3-large",
	"text-embedding-ada-002"
];
const COPILOT_HEADERS_STATIC = {
	"Content-Type": "application/json",
	...buildCopilotIdeHeaders()
};
function buildSsrfPolicy(baseUrl) {
	try {
		const parsed = new URL(baseUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
		return { allowedHostnames: [parsed.hostname] };
	} catch {
		return;
	}
}
function isCopilotSetupError(err) {
	if (!(err instanceof Error)) return false;
	return err.message.includes("No GitHub token available") || err.message.includes("Copilot token exchange failed") || err.message.includes("Copilot token response") || err.message.includes("No embedding models available") || err.message.includes("GitHub Copilot model discovery") || err.message.includes("GitHub Copilot embedding model") || err.message.includes("Unexpected response from GitHub Copilot token endpoint");
}
async function discoverEmbeddingModels(params) {
	const { response, release } = await fetchWithSsrFGuard({
		url: `${params.baseUrl.replace(/\/$/, "")}/models`,
		init: {
			method: "GET",
			headers: {
				...COPILOT_HEADERS_STATIC,
				...params.headers,
				Authorization: `Bearer ${params.copilotToken}`
			}
		},
		policy: params.ssrfPolicy,
		auditContext: "memory-remote"
	});
	try {
		if (!response.ok) throw new Error(`GitHub Copilot model discovery HTTP ${response.status}: ${await response.text()}`);
		let payload;
		try {
			payload = await response.json();
		} catch {
			throw new Error("GitHub Copilot model discovery returned invalid JSON");
		}
		return (Array.isArray(payload?.data) ? payload.data ?? [] : []).flatMap((entry) => {
			const id = typeof entry.id === "string" ? entry.id.trim() : "";
			if (!id) return [];
			return (Array.isArray(entry.supported_endpoints) ? entry.supported_endpoints.filter((value) => typeof value === "string") : []).some((ep) => ep.includes("embeddings")) || /\bembedding/i.test(id) ? [id] : [];
		});
	} finally {
		await release();
	}
}
function pickBestModel(available, userModel) {
	if (userModel) {
		const normalized = userModel.trim();
		const stripped = normalized.startsWith(`${COPILOT_EMBEDDING_PROVIDER_ID}/`) ? normalized.slice(`${COPILOT_EMBEDDING_PROVIDER_ID}/`.length) : normalized;
		if (available.length === 0) throw new Error("No embedding models available from GitHub Copilot");
		if (!available.includes(stripped)) throw new Error(`GitHub Copilot embedding model "${stripped}" is not available. Available: ${available.join(", ")}`);
		return stripped;
	}
	for (const preferred of PREFERRED_MODELS) if (available.includes(preferred)) return preferred;
	if (available.length > 0) return available[0];
	throw new Error("No embedding models available from GitHub Copilot");
}
function parseGitHubCopilotEmbeddingPayload(payload, expectedCount) {
	if (!payload || typeof payload !== "object") throw new Error("GitHub Copilot embeddings response missing data[]");
	const data = payload.data;
	if (!Array.isArray(data)) throw new Error("GitHub Copilot embeddings response missing data[]");
	const vectors = Array.from({ length: expectedCount });
	for (const entry of data) {
		if (!entry || typeof entry !== "object") throw new Error("GitHub Copilot embeddings response contains an invalid entry");
		const indexValue = entry.index;
		const embedding = entry.embedding;
		const index = typeof indexValue === "number" ? indexValue : NaN;
		if (!Number.isInteger(index)) throw new Error("GitHub Copilot embeddings response contains an invalid index");
		if (index < 0 || index >= expectedCount) throw new Error("GitHub Copilot embeddings response contains an out-of-range index");
		if (vectors[index] !== void 0) throw new Error("GitHub Copilot embeddings response contains duplicate indexes");
		if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number")) throw new Error("GitHub Copilot embeddings response contains an invalid embedding");
		vectors[index] = sanitizeAndNormalizeEmbedding(embedding);
	}
	for (let index = 0; index < expectedCount; index += 1) if (vectors[index] === void 0) throw new Error("GitHub Copilot embeddings response missing vectors for some inputs");
	return vectors;
}
async function resolveGitHubCopilotEmbeddingSession(client) {
	const token = await resolveCopilotApiToken({
		githubToken: client.githubToken,
		env: client.env,
		fetchImpl: client.fetchImpl
	});
	return {
		baseUrl: client.baseUrl?.trim() || token.baseUrl || "https://api.individual.githubcopilot.com",
		headers: {
			...COPILOT_HEADERS_STATIC,
			...client.headers,
			Authorization: `Bearer ${token.token}`
		}
	};
}
async function createGitHubCopilotEmbeddingProvider(client) {
	const initialSession = await resolveGitHubCopilotEmbeddingSession(client);
	const embed = async (input, signal) => {
		if (input.length === 0) return [];
		const session = await resolveGitHubCopilotEmbeddingSession(client);
		return await withRemoteHttpResponse({
			url: `${session.baseUrl.replace(/\/$/, "")}/embeddings`,
			fetchImpl: client.fetchImpl,
			ssrfPolicy: buildRemoteBaseUrlPolicy(session.baseUrl),
			signal,
			init: {
				method: "POST",
				headers: session.headers,
				body: JSON.stringify({
					model: client.model,
					input
				})
			},
			onResponse: async (response) => {
				if (!response.ok) throw new Error(`GitHub Copilot embeddings HTTP ${response.status}: ${await response.text()}`);
				let payload;
				try {
					payload = await response.json();
				} catch {
					throw new Error("GitHub Copilot embeddings returned invalid JSON");
				}
				return parseGitHubCopilotEmbeddingPayload(payload, input.length);
			}
		});
	};
	return {
		provider: {
			id: COPILOT_EMBEDDING_PROVIDER_ID,
			model: client.model,
			embedQuery: async (text, options) => {
				const [vector] = await embed([text], options?.signal);
				return vector ?? [];
			},
			embedBatch: async (texts, options) => await embed(texts, options?.signal)
		},
		client: {
			...client,
			baseUrl: initialSession.baseUrl
		}
	};
}
const githubCopilotMemoryEmbeddingProviderAdapter = {
	id: COPILOT_EMBEDDING_PROVIDER_ID,
	transport: "remote",
	authProviderId: COPILOT_EMBEDDING_PROVIDER_ID,
	autoSelectPriority: 15,
	allowExplicitWhenConfiguredAuto: true,
	shouldContinueAutoSelection: (err) => isCopilotSetupError(err),
	create: async (options) => {
		const remoteGithubToken = await resolveConfiguredSecretInputString({
			config: options.config,
			env: process.env,
			value: options.remote?.apiKey,
			path: "agents.*.memorySearch.remote.apiKey"
		});
		const { githubToken: profileGithubToken } = await resolveFirstGithubToken({
			agentDir: options.agentDir,
			config: options.config,
			env: process.env
		});
		const githubToken = remoteGithubToken.value || profileGithubToken;
		if (!githubToken) throw new Error("No GitHub token available for Copilot embedding provider");
		const { token: copilotToken, baseUrl: resolvedBaseUrl } = await resolveCopilotApiToken({
			githubToken,
			env: process.env
		});
		const baseUrl = options.remote?.baseUrl?.trim() || resolvedBaseUrl || "https://api.individual.githubcopilot.com";
		const ssrfPolicy = buildSsrfPolicy(baseUrl);
		const model = pickBestModel(await discoverEmbeddingModels({
			baseUrl,
			copilotToken,
			headers: options.remote?.headers,
			ssrfPolicy
		}), options.model?.trim() || void 0);
		const { provider } = await createGitHubCopilotEmbeddingProvider({
			baseUrl,
			env: process.env,
			fetchImpl: fetch,
			githubToken,
			headers: options.remote?.headers,
			model
		});
		return {
			provider,
			runtime: {
				id: COPILOT_EMBEDDING_PROVIDER_ID,
				cacheKeyData: {
					provider: COPILOT_EMBEDDING_PROVIDER_ID,
					baseUrl,
					model
				}
			}
		};
	}
};
//#endregion
export { githubCopilotMemoryEmbeddingProviderAdapter as t };
