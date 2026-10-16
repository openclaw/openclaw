type MemorySearchSource = "memory" | "sessions";

const DEFAULT_SOURCES: MemorySearchSource[] = ["memory"];

function normalizeSources(
  sources: readonly MemorySearchSource[] | undefined,
  sessionMemoryEnabled: boolean,
): MemorySearchSource[] {
  const input = sources?.length ? sources : DEFAULT_SOURCES;
  const normalized = [
    ...new Set(
      input.filter(
        (source) => source === "memory" || (source === "sessions" && sessionMemoryEnabled),
      ),
    ),
  ];
  return normalized.length > 0 ? normalized : [...DEFAULT_SOURCES];
}

/** Resolve query and indexed sources from already-selected memory policy facts. */
export function resolveMemorySearchSourcePolicy(params: {
  configuredSources?: readonly MemorySearchSource[];
  rememberAcrossConversations: boolean;
  configuredSessionMemory: boolean;
}): {
  sources: MemorySearchSource[];
  searchSources: MemorySearchSource[];
  sessionMemory: boolean;
  sessionSourceExcluded: boolean;
} {
  const { configuredSources, rememberAcrossConversations, configuredSessionMemory } = params;
  const sessionMemory = rememberAcrossConversations || configuredSessionMemory;
  const searchSources = normalizeSources(configuredSources, sessionMemory);
  const sources = normalizeSources(
    rememberAcrossConversations ? [...searchSources, "sessions"] : configuredSources,
    sessionMemory,
  );
  const sessionSourceExcluded =
    configuredSources?.includes("sessions") === true && !searchSources.includes("sessions");
  return { sources, searchSources, sessionMemory, sessionSourceExcluded };
}
