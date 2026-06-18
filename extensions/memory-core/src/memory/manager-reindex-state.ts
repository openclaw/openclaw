// Memory Core plugin module implements manager reindex state behavior.
import {
  hashText,
  normalizeExtraMemoryPaths,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

// Stored FTS payload format identity. Bump when chunks_fts.text semantics change so
// existing clean indexes from older builds get rebuilt instead of silently serving
// stale rows. Current value: chunk text is prefixed with `${entry.path}\n` so filename/
// date tokens participate in MATCH ranking; older indexes wrote chunk body only.
export const MEMORY_FTS_TEXT_FORMAT_PATH_PREFIXED_V1 = "path-prefixed-v1";
export const MEMORY_FTS_TEXT_FORMAT_CURRENT = MEMORY_FTS_TEXT_FORMAT_PATH_PREFIXED_V1;

export type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  sources?: MemorySource[];
  scopeHash?: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
  ftsTokenizer?: string;
  ftsTextFormat?: string;
};

export type MemoryIndexIdentityState =
  | {
      status: "valid";
    }
  | {
      status: "missing";
      reason: string;
    }
  | {
      status: "mismatched";
      reason: string;
    };

export type MemoryIndexProviderIdentity = {
  provider: string;
  model: string;
  providerKey: string;
};

export function resolveMemoryIndexProviderIdentities(params: {
  provider: { id: string; model: string } | null;
  cacheKeyData?: Record<string, unknown>;
  aliases?: Array<{ model: string; cacheKeyData: Record<string, unknown> }>;
}): MemoryIndexProviderIdentity[] {
  const provider = params.provider ?? { id: "none", model: "fts-only" };
  const candidates = [
    {
      model: provider.model,
      cacheKeyData: params.cacheKeyData ?? { provider: provider.id, model: provider.model },
    },
    ...(params.provider ? (params.aliases ?? []) : []),
  ];
  const seen = new Set<string>();
  const identities: MemoryIndexProviderIdentity[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const providerKey = hashText(JSON.stringify(candidate.cacheKeyData));
    const key = `${candidate.model}\u0000${providerKey}`;
    if ((index > 0 && !candidate.model) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    identities.push({
      provider: provider.id,
      model: candidate.model,
      providerKey,
    });
  }
  return identities;
}

export function resolveConfiguredSourcesForMeta(sources: Iterable<MemorySource>): MemorySource[] {
  const normalized = Array.from(sources)
    .filter((source): source is MemorySource => source === "memory" || source === "sessions")
    .toSorted((left, right) => left.localeCompare(right));
  return normalized.length > 0 ? normalized : ["memory"];
}

function normalizeMetaSources(meta: MemoryIndexMeta): MemorySource[] {
  if (!Array.isArray(meta.sources)) {
    // Backward compatibility for older indexes that did not persist sources.
    return ["memory"];
  }
  const normalized = Array.from(
    new Set(
      meta.sources.filter(
        (source): source is MemorySource => source === "memory" || source === "sessions",
      ),
    ),
  ).toSorted((left, right) => left.localeCompare(right));
  return normalized.length > 0 ? normalized : ["memory"];
}

function configuredMetaSourcesDiffer(params: {
  meta: MemoryIndexMeta;
  configuredSources: MemorySource[];
}): boolean {
  const metaSources = normalizeMetaSources(params.meta);
  if (metaSources.length !== params.configuredSources.length) {
    return true;
  }
  return metaSources.some((source, index) => source !== params.configuredSources[index]);
}

export function resolveConfiguredScopeHash(params: {
  workspaceDir: string;
  extraPaths?: string[];
  multimodal: {
    enabled: boolean;
    modalities: string[];
    maxFileBytes: number;
  };
}): string {
  const extraPaths = normalizeExtraMemoryPaths(params.workspaceDir, params.extraPaths)
    .map((value) => value.replace(/\\/g, "/"))
    .toSorted();
  return hashText(
    JSON.stringify({
      extraPaths,
      multimodal: {
        enabled: params.multimodal.enabled,
        modalities: [...params.multimodal.modalities].toSorted(),
        maxFileBytes: params.multimodal.maxFileBytes,
      },
    }),
  );
}

export function isMemoryIndexIdentityDirty(params: {
  meta: MemoryIndexMeta | null;
  provider: { id: string; model: string } | null;
  providerKey?: string;
  providerAliases?: Array<Pick<MemoryIndexProviderIdentity, "model" | "providerKey">>;
  providerKeyKnown?: boolean;
  configuredSources: MemorySource[];
  configuredScopeHash: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorReady: boolean;
  hasIndexedChunks?: boolean;
  ftsTokenizer: string;
  ftsTextFormat?: string;
}): boolean {
  return resolveMemoryIndexIdentityState(params).status !== "valid";
}

// Returns true when meta is mismatched against the configured identity *only* because
// of the persisted FTS text-format payload version. Provider/model/scope/tokenizer
// mismatches still return false so callers preserve the existing pause-and-wait
// behavior for semantically incompatible indexes; only the FTS payload format is
// safe to self-heal automatically because rebuilding it never throws away embeddings
// or user data — it just re-emits chunks_fts.text in the current shape.
export function isMemoryIndexFtsTextFormatOnlyMismatch(params: {
  meta: MemoryIndexMeta | null;
  provider: { id: string; model: string } | null;
  providerKey?: string;
  providerAliases?: Array<Pick<MemoryIndexProviderIdentity, "model" | "providerKey">>;
  providerKeyKnown?: boolean;
  configuredSources: MemorySource[];
  configuredScopeHash: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorReady: boolean;
  hasIndexedChunks?: boolean;
  ftsTokenizer: string;
  ftsTextFormat?: string;
}): boolean {
  if (!params.meta) {
    return false;
  }
  if (resolveMemoryIndexIdentityState(params).status !== "mismatched") {
    return false;
  }
  // Re-run identity with the configured FTS text format pinned to whatever the index
  // already has. If everything else is fine, only ftsTextFormat differs.
  const probe = resolveMemoryIndexIdentityState({
    ...params,
    ftsTextFormat: params.meta.ftsTextFormat ?? "legacy-body-only",
  });
  return probe.status === "valid";
}

export function resolveMemoryIndexIdentityState(params: {
  meta: MemoryIndexMeta | null;
  provider: { id: string; model: string } | null;
  providerKey?: string;
  providerAliases?: Array<Pick<MemoryIndexProviderIdentity, "model" | "providerKey">>;
  providerKeyKnown?: boolean;
  configuredSources: MemorySource[];
  configuredScopeHash: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorReady: boolean;
  hasIndexedChunks?: boolean;
  ftsTokenizer: string;
  ftsTextFormat?: string;
}): MemoryIndexIdentityState {
  const { meta } = params;
  if (!meta) {
    return { status: "missing", reason: "index metadata is missing" };
  }
  const expectedModel = params.provider?.model?.trim() || "fts-only";
  const matchingModelIdentities = [
    { model: expectedModel, providerKey: params.providerKey },
    ...(params.providerAliases ?? []),
  ].filter((identity) => identity.model === meta.model);
  if (matchingModelIdentities.length === 0) {
    return {
      status: "mismatched",
      reason: `index was built for model ${meta.model}, expected ${expectedModel}`,
    };
  }
  const expectedProvider = params.provider ? params.provider.id : "none";
  if (meta.provider !== expectedProvider) {
    return {
      status: "mismatched",
      reason: `index was built for provider ${meta.provider}, expected ${expectedProvider}`,
    };
  }
  if (
    params.providerKeyKnown !== false &&
    !matchingModelIdentities.some((identity) => identity.providerKey === meta.providerKey)
  ) {
    return {
      status: "mismatched",
      reason: "index provider settings changed",
    };
  }
  if (
    configuredMetaSourcesDiffer({
      meta,
      configuredSources: params.configuredSources,
    })
  ) {
    return {
      status: "mismatched",
      reason: "index sources changed",
    };
  }
  if (meta.scopeHash !== params.configuredScopeHash) {
    return {
      status: "mismatched",
      reason: "index scope changed",
    };
  }
  if (meta.chunkTokens !== params.chunkTokens || meta.chunkOverlap !== params.chunkOverlap) {
    return {
      status: "mismatched",
      reason: "index chunking changed",
    };
  }
  if (params.vectorReady && params.hasIndexedChunks !== false && !meta.vectorDims) {
    return {
      status: "mismatched",
      reason: "index vector dimensions are missing",
    };
  }
  if ((meta.ftsTokenizer ?? "unicode61") !== params.ftsTokenizer) {
    return {
      status: "mismatched",
      reason: "index FTS tokenizer changed",
    };
  }
  // Old indexes wrote chunk body only into chunks_fts.text; the current format prefixes
  // the path so filename/date tokens MATCH. Without rebuilding, filename queries on
  // upgraded clean indexes would still return textScore: 0 — see issue #94102.
  const expectedFtsTextFormat = params.ftsTextFormat ?? MEMORY_FTS_TEXT_FORMAT_CURRENT;
  if ((meta.ftsTextFormat ?? "legacy-body-only") !== expectedFtsTextFormat) {
    return {
      status: "mismatched",
      reason: "index FTS text format changed",
    };
  }
  return { status: "valid" };
}
