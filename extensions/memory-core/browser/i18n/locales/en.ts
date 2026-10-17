const en = {
  common: {
    loading: "Loading…",
    enabled: "Enabled",
    disabled: "Disabled",
    na: "n/a",
    unknown: "Unknown",
  },
  memoryPage: {
    memories: {
      searchLabel: "Search memories",
      searchPlaceholder: "Search this agent's memories",
      searchButton: "Search",
      idle: "Search for a person, project, decision, or anything else this agent remembers.",
      searching: "Searching memories…",
      results: "{count} results",
      empty: "No memories matched “{query}”.",
      error: "Memory search failed: {message}",
      retry: "Retry",
      gatewayUpdateRequired: "Update the gateway to search memories from the Control UI.",
      hybridSearch: "hybrid search",
      keywordSearch: "keyword search",
      lineRange: "lines {start}–{end}",
      score: "score {score}",
      sourceMemory: "memory",
      sourceSessions: "sessions",
      fileLoading: "Loading the full memory file…",
      fileError: "Could not load this memory file: {message}",
      fileUnsupported: "This memory file cannot be shown as text.",
    },
    overview: {
      hero: {
        awake: "Memory is awake",
        waking: "Waking memory…",
        hibernating: "Memory is hibernating",
        needsAttention: "Memory needs attention",
        noSearchRuntime: "Host memory search is unavailable",
        noSearchRuntimeDescription:
          "{engine} does not provide a host memory search runtime. Other memory integrations may run independently.",
        activeDescription: "{engine} · {mode}",
        loadingDescription: "Checking this agent's memory engine and dream cycle.",
        offDescription: "Choose a memory engine in Settings to wake it up.",
        disabledDescription: "The selected memory engine is disabled. Re-enable it in Settings.",
        gatewayOffline: "The gateway is offline, so memory status is unavailable.",
        hybridSearch: "hybrid search",
        keywordSearch: "keyword search (no embeddings)",
        openSettings: "Open Settings",
        retry: "Retry",
        refresh: "Refresh status",
      },
      schedule: {
        title: "Sleep schedule",
        lightDescription:
          "Sorts fresh short-term notes and stages promising candidates without changing long-term memory.",
        remDescription:
          "Reflects on themes and recurring ideas across recent activity to strengthen ranking without changing long-term memory.",
        deepDescription:
          "Scores staged candidates, promotes the keepers into long-term memory (MEMORY.md), and writes the dream diary.",
        nextRun: "next {time}",
        lastRun: "last {time}",
        notScheduled: "Not scheduled",
        learnMore: "How dreaming works",
        openDocs: "Open dreaming guide",
      },
      activity: {
        title: "Activity",
        promotedToday: "Promoted today",
        promotedTotal: "Promoted total",
        shortTermCount: "Pending short-term entries",
        phaseHitCount: "Phase signals",
        lightPhaseHitCount: "Light-phase hits",
        remPhaseHitCount: "REM-phase hits",
      },
      health: {
        title: "Engine health",
        provider: "Provider",
        embeddings: "Embeddings",
        runtime: "Embedding runtime",
        healthy: "Ready",
        unavailable: "Unavailable",
        notChecked: "Not checked",
        notCheckedDescription: "Embedding readiness has not been checked yet.",
        checking: "Checking…",
        test: "Test",
        testing: "Testing…",
      },
      shortcuts: {
        title: "Explore memory",
        memories: "Search memories",
        diary: "Read the dream diary",
        settings: "Configure memory",
      },
    },
    dreaming: {
      phases: {
        light: {
          title: "Light phase",
        },
        deep: {
          title: "Deep phase",
        },
        rem: {
          title: "REM phase",
        },
      },
    },
  },
};
export default en;
