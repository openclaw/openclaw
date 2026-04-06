type StatusProvider = {
  id: string;
  model: string;
};

export function resolveInitialMemoryDirty(params: {
  hasMemorySource: boolean;
  statusOnly: boolean;
  hasIndexedMeta: boolean;
}): boolean {
  return params.hasMemorySource && (params.statusOnly ? !params.hasIndexedMeta : true);
}

export function resolveStatusProviderInfo(params: {
  provider: StatusProvider | null;
  providerInitialized: boolean;
  requestedProvider: string;
  configuredModel?: string;
}): {
  provider: string;
  model?: string;
  searchMode: "hybrid" | "fts-only";
} {
  if (params.provider) {
    return {
      provider: params.provider.id,
      model: params.provider.model,
      searchMode: "hybrid",
    };
  }
  if (params.providerInitialized) {
    return {
      provider: "none",
      model: undefined,
      searchMode: "fts-only",
    };
  }
  return {
    provider: params.requestedProvider,
    model: params.configuredModel || undefined,
    searchMode: "hybrid",
  };
}
