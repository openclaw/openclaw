export type MemoryConfig = {
  embedding: {
    provider: "openai";
    model?: string;
    apiKey: string;
  };
  milvus: {
    address: string;
    token?: string;
    ssl?: boolean;
    collectionName?: string;
  };
  autoCapture?: boolean;
  autoRecall?: boolean;
};

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_COLLECTION_NAME = "openclaw_memories";

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export function vectorDimsForModel(model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(`Unsupported embedding model: ${model}`);
  }
  return dims;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function resolveEmbeddingModel(embedding: Record<string, unknown>): string {
  const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
  vectorDimsForModel(model);
  return model;
}

export const memoryConfigSchema = {
  parse(value: unknown): MemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ["embedding", "milvus", "autoCapture", "autoRecall"], "memory config");

    // Validate embedding
    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required");
    }
    assertAllowedKeys(embedding, ["apiKey", "model"], "embedding config");
    const model = resolveEmbeddingModel(embedding);

    // Validate milvus
    const milvus = cfg.milvus as Record<string, unknown> | undefined;
    if (!milvus || typeof milvus.address !== "string") {
      throw new Error("milvus.address is required");
    }
    assertAllowedKeys(milvus, ["address", "token", "ssl", "collectionName"], "milvus config");

    const address = milvus.address;
    // Auto-detect SSL from https:// prefix
    const ssl = typeof milvus.ssl === "boolean" ? milvus.ssl : address.startsWith("https://");

    return {
      embedding: {
        provider: "openai",
        model,
        apiKey: resolveEnvVars(embedding.apiKey),
      },
      milvus: {
        address,
        token: typeof milvus.token === "string" ? resolveEnvVars(milvus.token) : undefined,
        ssl,
        collectionName:
          typeof milvus.collectionName === "string"
            ? milvus.collectionName
            : DEFAULT_COLLECTION_NAME,
      },
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
    };
  },
  uiHints: {
    "embedding.apiKey": {
      label: "OpenAI API Key",
      sensitive: true,
      placeholder: "sk-proj-...",
      help: "API key for OpenAI embeddings (or use ${OPENAI_API_KEY})",
    },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_MODEL,
      help: "OpenAI embedding model to use",
    },
    "milvus.address": {
      label: "Milvus Address",
      placeholder: "https://in03-xxx.serverless.gcp-us-west1.cloud.zilliz.com",
      help: "Milvus server address (local: localhost:19530, Zilliz Cloud: https://...)",
    },
    "milvus.token": {
      label: "Milvus Token",
      sensitive: true,
      placeholder: "your-api-key-or-user:pass",
      help: "API key for Zilliz Cloud, or user:pass for local Milvus (or use ${MILVUS_TOKEN})",
    },
    "milvus.ssl": {
      label: "SSL",
      help: "Enable TLS/SSL (auto-detected from https:// prefix)",
      advanced: true,
    },
    "milvus.collectionName": {
      label: "Collection Name",
      placeholder: DEFAULT_COLLECTION_NAME,
      advanced: true,
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically capture important information from conversations",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories into context",
    },
  },
};
