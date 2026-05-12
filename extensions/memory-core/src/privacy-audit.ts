import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryProviderStatus } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { OpenClawConfig } from "./cli.host.runtime.js";

export type MemoryPrivacySeverity = "info" | "warning" | "action";

export type MemoryPrivacyFinding = {
  severity: MemoryPrivacySeverity;
  code: string;
  message: string;
};

export type MemoryPrivacyArtifact = {
  kind: "memory-file" | "memory-directory" | "dreaming-artifact" | "index" | "sessions";
  path: string;
  exists: boolean;
  files?: number;
  bytes?: number;
};

export type MemoryEmbeddingPrivacy = {
  provider: string;
  model?: string;
  classification: "local" | "remote" | "none" | "unknown";
};

export type MemoryPrivacyReport = {
  agentId: string;
  workspaceDir?: string;
  embedding: MemoryEmbeddingPrivacy;
  transcriptPersistence: {
    sessionsSourceEnabled: boolean;
    sessionsDir: string;
    files: number;
  };
  artifacts: MemoryPrivacyArtifact[];
  findings: MemoryPrivacyFinding[];
};

type FileStatSummary = {
  exists: boolean;
  files?: number;
  bytes?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

async function summarizePath(targetPath: string): Promise<FileStatSummary> {
  let stat;
  try {
    stat = await fs.stat(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
  if (stat.isFile()) {
    return { exists: true, files: 1, bytes: stat.size };
  }
  if (!stat.isDirectory()) {
    return { exists: true, files: 0, bytes: 0 };
  }
  let files = 0;
  let bytes = 0;
  const stack = [targetPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += (await fs.stat(entryPath)).size;
        } catch {
          // Keep audit best-effort when a file disappears during the scan.
        }
      }
    }
  }
  return { exists: true, files, bytes };
}

function classifyEmbeddingProvider(provider: string): MemoryEmbeddingPrivacy["classification"] {
  const normalized = provider.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "disabled") {
    return "none";
  }
  if (
    ["local", "ollama", "lmstudio", "node-llama", "qmd", "builtin-local", "localai"].includes(
      normalized,
    )
  ) {
    return "local";
  }
  if (
    [
      "openai",
      "gemini",
      "google",
      "voyage",
      "mistral",
      "bedrock",
      "amazon-bedrock",
      "remote",
    ].includes(normalized)
  ) {
    return "remote";
  }
  return "unknown";
}

function resolveAgentMemorySearchConfig(
  cfg: OpenClawConfig,
  agentId: string,
): Record<string, unknown> {
  const defaults = asRecord(cfg.agents?.defaults?.memorySearch);
  const agent = cfg.agents?.list?.find(
    (entry: { id?: string; memorySearch?: unknown }) => entry.id === agentId,
  );
  return {
    ...defaults,
    ...asRecord(agent?.memorySearch),
  };
}

export async function buildMemoryPrivacyReport(params: {
  cfg: OpenClawConfig;
  agentId: string;
  status: MemoryProviderStatus;
  sessionsDir: string;
}): Promise<MemoryPrivacyReport> {
  const { cfg, agentId, status, sessionsDir } = params;
  const provider = status.requestedProvider ?? status.provider;
  const embedding: MemoryEmbeddingPrivacy = {
    provider,
    ...(status.model ? { model: status.model } : {}),
    classification: classifyEmbeddingProvider(provider),
  };

  const artifacts: MemoryPrivacyArtifact[] = [];
  const workspaceDir = status.workspaceDir;
  if (workspaceDir) {
    for (const item of [
      { kind: "memory-file" as const, path: path.join(workspaceDir, "MEMORY.md") },
      { kind: "memory-directory" as const, path: path.join(workspaceDir, "memory") },
      { kind: "dreaming-artifact" as const, path: path.join(workspaceDir, "DREAMS.md") },
      { kind: "dreaming-artifact" as const, path: path.join(workspaceDir, "memory", ".dreams") },
    ]) {
      artifacts.push({ ...item, ...(await summarizePath(item.path)) });
    }
  }
  if (status.dbPath) {
    artifacts.push({ kind: "index", path: status.dbPath, ...(await summarizePath(status.dbPath)) });
  }
  const sessionsSummary = await summarizePath(sessionsDir);
  artifacts.push({ kind: "sessions", path: sessionsDir, ...sessionsSummary });

  const memorySearch = resolveAgentMemorySearchConfig(cfg, agentId);
  const configuredSources = Array.isArray(memorySearch.sources)
    ? memorySearch.sources.filter((entry): entry is string => typeof entry === "string")
    : [];
  const sessionsSourceEnabled =
    status.sources?.includes("sessions") === true || configuredSources.includes("sessions");
  const transcriptPersistence = {
    sessionsSourceEnabled,
    sessionsDir,
    files: sessionsSummary.files ?? 0,
  };

  const findings: MemoryPrivacyFinding[] = [];
  if (embedding.classification === "remote") {
    findings.push({
      severity: "warning",
      code: "remote-embedding-provider",
      message: `Memory embeddings use remote provider "${provider}"; memory text may leave this machine during indexing/search.`,
    });
  } else if (embedding.classification === "local") {
    findings.push({
      severity: "info",
      code: "local-embedding-provider",
      message: `Memory embeddings use local provider "${provider}".`,
    });
  } else if (embedding.classification === "unknown") {
    findings.push({
      severity: "warning",
      code: "unknown-embedding-provider",
      message: `Memory embedding provider "${provider}" could not be classified as local or remote.`,
    });
  }

  const plaintextArtifacts = artifacts.filter(
    (artifact) =>
      artifact.exists &&
      ["memory-file", "memory-directory", "dreaming-artifact", "sessions"].includes(artifact.kind),
  );
  if (plaintextArtifacts.length > 0) {
    findings.push({
      severity: "warning",
      code: "plaintext-memory-artifacts",
      message: "Memory, dreaming, or session artifacts are stored as readable local files.",
    });
  }
  if (artifacts.some((artifact) => artifact.kind === "index" && artifact.exists)) {
    findings.push({
      severity: "warning",
      code: "memory-index-present",
      message: "A memory index exists on disk and may reveal keywords or semantic metadata.",
    });
  }
  if (sessionsSourceEnabled || transcriptPersistence.files > 0) {
    findings.push({
      severity: "warning",
      code: "session-transcripts-present",
      message:
        "Session transcripts are enabled or present and may contain long-form conversation history.",
    });
  }
  if (plaintextArtifacts.length > 0) {
    findings.push({
      severity: "action",
      code: "encrypted-backup-available",
      message:
        "Use `openclaw memory export --encrypted` to create an encrypted backup before moving or archiving memory.",
    });
  }

  return {
    agentId,
    ...(workspaceDir ? { workspaceDir } : {}),
    embedding,
    transcriptPersistence,
    artifacts,
    findings,
  };
}
