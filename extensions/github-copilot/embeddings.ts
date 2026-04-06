import {
  DEFAULT_COPILOT_API_BASE_URL,
  resolveCopilotApiToken,
} from "openclaw/plugin-sdk/github-copilot-token";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveFirstGithubToken } from "./auth.js";

const COPILOT_EMBEDDING_PROVIDER_ID = "github-copilot";

/**
 * Preferred embedding models in order. The first available model wins.
 */
const PREFERRED_MODELS = [
  "text-embedding-3-small",
  "text-embedding-3-large",
  "text-embedding-ada-002",
] as const;

const COPILOT_HEADERS_STATIC: Record<string, string> = {
  "Content-Type": "application/json",
  "Editor-Version": "vscode/1.96.2",
  "User-Agent": "GitHubCopilotChat/0.26.7",
};

function buildSsrfPolicy(baseUrl: string): SsrFPolicy | undefined {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return { allowedHostnames: [parsed.hostname] };
  } catch {
    return undefined;
  }
}

type CopilotModelEntry = {
  id: string;
  supported_endpoints?: string[];
};

type CopilotModelsResponse = {
  data?: CopilotModelEntry[];
};

type CopilotEmbeddingDataEntry = {
  embedding: number[];
  index: number;
};

type CopilotEmbeddingResponse = {
  data?: CopilotEmbeddingDataEntry[];
  model?: string;
};

function isCopilotSetupError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  // All Copilot-specific setup failures should allow auto-selection to
  // fall through to the next provider (e.g. OpenAI). This covers: missing
  // GitHub token, token exchange failures, no embedding models on the plan,
  // model discovery errors, and user-pinned model not available on Copilot.
  return (
    err.message.includes("No GitHub token available") ||
    err.message.includes("Copilot token exchange failed") ||
    err.message.includes("No embedding models available") ||
    err.message.includes("GitHub Copilot model discovery") ||
    err.message.includes("GitHub Copilot embedding model")
  );
}

async function discoverEmbeddingModels(params: {
  baseUrl: string;
  copilotToken: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<string[]> {
  const url = `${params.baseUrl.replace(/\/$/, "")}/models`;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "GET",
      headers: {
        ...COPILOT_HEADERS_STATIC,
        Authorization: `Bearer ${params.copilotToken}`,
      },
    },
    policy: params.ssrfPolicy,
    auditContext: "memory-remote",
  });
  try {
    if (!response.ok) {
      throw new Error(
        `GitHub Copilot model discovery HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as CopilotModelsResponse;
    const allModels = Array.isArray(body.data) ? body.data : [];
    // Filter for embedding models. The Copilot API may list embedding models
    // with an explicit /v1/embeddings endpoint, or with an empty
    // supported_endpoints array. Match both: endpoint-declared embedding
    // models and models whose ID indicates embedding capability.
    const models = allModels.filter(
      (m) =>
        m.supported_endpoints?.some((ep) => ep.includes("embeddings")) || /\bembedding/i.test(m.id),
    );
    return models.map((m) => m.id);
  } finally {
    await release();
  }
}

function pickBestModel(available: string[], userModel?: string): string {
  if (userModel) {
    const normalized = userModel.trim();
    // Strip the provider prefix if users set "github-copilot/model-name".
    const stripped = normalized.startsWith(`${COPILOT_EMBEDDING_PROVIDER_ID}/`)
      ? normalized.slice(`${COPILOT_EMBEDDING_PROVIDER_ID}/`.length)
      : normalized;
    if (available.length === 0) {
      throw new Error("No embedding models available from GitHub Copilot");
    }
    if (!available.includes(stripped)) {
      throw new Error(
        `GitHub Copilot embedding model "${stripped}" is not available. Available: ${available.join(", ")}`,
      );
    }
    return stripped;
  }
  for (const preferred of PREFERRED_MODELS) {
    if (available.includes(preferred)) {
      return preferred;
    }
  }
  if (available.length > 0) {
    return available[0];
  }
  throw new Error("No embedding models available from GitHub Copilot");
}

function sanitizeAndNormalizeEmbedding(vec: number[]): number[] {
  const sanitized = vec.map((value) => (Number.isFinite(value) ? value : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
  if (magnitude < 1e-10) {
    return sanitized;
  }
  return sanitized.map((value) => value / magnitude);
}

// Note: the Copilot token is captured at creation time. Copilot tokens are
// short-lived (~30 min) so long-lived sessions may hit 401s. This matches
// how other embedding providers capture API keys at creation. A token
// refresh mechanism can be added if this becomes a practical issue.
async function createCopilotEmbeddingProvider(params: {
  baseUrl: string;
  copilotToken: string;
  model: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<MemoryEmbeddingProvider> {
  const embeddingsUrl = `${params.baseUrl.replace(/\/$/, "")}/embeddings`;
  const headers: Record<string, string> = {
    ...COPILOT_HEADERS_STATIC,
    Authorization: `Bearer ${params.copilotToken}`,
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) {
      return [];
    }
    const { response, release } = await fetchWithSsrFGuard({
      url: embeddingsUrl,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({ model: params.model, input: texts }),
      },
      policy: params.ssrfPolicy,
      auditContext: "memory-remote",
    });
    try {
      if (!response.ok) {
        throw new Error(
          `GitHub Copilot embeddings HTTP ${response.status}: ${await response.text()}`,
        );
      }
      const body = (await response.json()) as CopilotEmbeddingResponse;
      if (!Array.isArray(body.data)) {
        throw new Error("GitHub Copilot embeddings response missing data[]");
      }
      return body.data
        .toSorted((a, b) => a.index - b.index)
        .map((entry) => sanitizeAndNormalizeEmbedding(entry.embedding));
    } finally {
      await release();
    }
  };

  return {
    id: COPILOT_EMBEDDING_PROVIDER_ID,
    model: params.model,
    embedQuery: async (text: string) => {
      const [result] = await embedBatch([text]);
      if (!result) {
        throw new Error("GitHub Copilot embeddings returned no vectors for query");
      }
      return result;
    },
    embedBatch,
  };
}

export const githubCopilotMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: COPILOT_EMBEDDING_PROVIDER_ID,
  transport: "remote",
  autoSelectPriority: 15,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: (err: unknown) => isCopilotSetupError(err),
  create: async (options) => {
    const { githubToken } = resolveFirstGithubToken({
      agentDir: options.agentDir,
      env: process.env,
    });
    if (!githubToken) {
      throw new Error("No GitHub token available for Copilot embedding provider");
    }

    const { token: copilotToken, baseUrl: resolvedBaseUrl } = await resolveCopilotApiToken({
      githubToken,
    });
    const baseUrl = resolvedBaseUrl || DEFAULT_COPILOT_API_BASE_URL;
    const ssrfPolicy = buildSsrfPolicy(baseUrl);

    // Always discover models even when the user pins one: this validates
    // the Copilot token and confirms the plan supports embeddings before
    // we attempt any embedding requests.
    const availableModels = await discoverEmbeddingModels({
      baseUrl,
      copilotToken,
      ssrfPolicy,
    });

    const userModel = options.model?.trim() || undefined;
    const model = pickBestModel(availableModels, userModel);

    const provider = await createCopilotEmbeddingProvider({
      baseUrl,
      copilotToken,
      model,
      ssrfPolicy,
    });

    return {
      provider,
      runtime: {
        id: COPILOT_EMBEDDING_PROVIDER_ID,
        cacheKeyData: {
          provider: COPILOT_EMBEDDING_PROVIDER_ID,
          baseUrl,
          model,
        },
      },
    };
  },
};
