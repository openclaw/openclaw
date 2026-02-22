import { homedir } from "node:os";
import { join } from "node:path";

export type DoclingRagConfig = {
  enabled: boolean;
  doclingPath?: string;
  dbPath: string;
  embedding: {
    provider: "openai";
    model: string;
    apiKey: string;
  };
  chunkSize: number;
  chunkOverlap: number;
};

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_CHUNK_OVERLAP = 100;

function resolveDefaultDbPath(): string {
  return join(homedir(), ".openclaw", "docling-rag", "docs.db");
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

export function parseConfig(value: unknown): DoclingRagConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      enabled: true,
      dbPath: resolveDefaultDbPath(),
      embedding: {
        provider: "openai",
        model: DEFAULT_MODEL,
        apiKey: process.env.OPENAI_API_KEY ?? "",
      },
      chunkSize: DEFAULT_CHUNK_SIZE,
      chunkOverlap: DEFAULT_CHUNK_OVERLAP,
    };
  }
  const cfg = value as Record<string, unknown>;
  const embedding = cfg.embedding as Record<string, unknown> | undefined;
  const apiKey =
    (typeof embedding?.apiKey === "string" ? resolveEnvVars(embedding.apiKey) : null) ??
    process.env.OPENAI_API_KEY ??
    "";
  const model =
    (typeof embedding?.model === "string" ? embedding.model : null) ?? DEFAULT_MODEL;
  return {
    enabled: cfg.enabled !== false,
    doclingPath: typeof cfg.doclingPath === "string" ? cfg.doclingPath : undefined,
    dbPath:
      typeof cfg.dbPath === "string" ? cfg.dbPath : resolveDefaultDbPath(),
    embedding: {
      provider: "openai",
      model,
      apiKey,
    },
    chunkSize:
      typeof cfg.chunkSize === "number" && cfg.chunkSize > 0
        ? Math.floor(cfg.chunkSize)
        : DEFAULT_CHUNK_SIZE,
    chunkOverlap:
      typeof cfg.chunkOverlap === "number" && cfg.chunkOverlap >= 0
        ? Math.floor(cfg.chunkOverlap)
        : DEFAULT_CHUNK_OVERLAP,
  };
}
