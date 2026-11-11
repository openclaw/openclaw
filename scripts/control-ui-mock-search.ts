import type {
  WebSearchStatusResult,
  WebSearchTestResult,
} from "../packages/gateway-protocol/src/schema/web-search.ts";

/** One managed route and one provider that still needs a key, shaped like `webSearch.status`. */
export function buildSearchMocks(configHash: string): {
  "webSearch.status": WebSearchStatusResult;
  "webSearch.test": WebSearchTestResult;
  "plugins.credentials.inspect": { baseHash: string; credential: { kind: "missing" } };
} {
  return {
    "webSearch.status": {
      enabled: true,
      provider: null,
      agentId: "main",
      model: { provider: "openai", id: "gpt-5.5", runtime: "openclaw", runtimeLabel: "OpenClaw" },
      route: {
        kind: "managed",
        provider: "parallel-free",
        label: "Parallel Search (Free)",
        testable: true,
      },
      providers: [
        {
          id: "brave",
          pluginId: "brave",
          label: "Brave Search",
          hint: "Structured results · country/language/time filters",
          configured: false,
          installed: true,
          available: true,
          requiresCredential: true,
          credentialSource: "missing",
          configPath: ["plugins", "entries", "brave", "config", "webSearch"],
          credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
          credential: {
            path: ["plugins", "entries", "brave", "config", "webSearch", "apiKey"],
            label: "Brave Search API key",
            envVars: ["BRAVE_API_KEY"],
          },
          docsUrl: "https://docs.openclaw.ai/tools/brave-search",
          signupUrl: "https://brave.com/search/api/",
        },
        {
          id: "parallel-free",
          pluginId: "parallel",
          label: "Parallel Search (Free)",
          hint: "Free web search via Parallel's hosted Search MCP — no API key required",
          configured: true,
          installed: true,
          available: true,
          requiresCredential: false,
          credentialSource: "none",
          configPath: [],
          docsUrl: "https://docs.openclaw.ai/tools/parallel-search",
        },
      ],
    },
    "plugins.credentials.inspect": { baseHash: configHash, credential: { kind: "missing" } },
    "webSearch.test": {
      provider: "parallel-free",
      latencyMs: 642,
      status: "ok",
      results: [
        {
          title: "Web search",
          url: "https://docs.openclaw.ai/tools/web",
          snippet: "Configure web search providers and verify them from Settings.",
        },
        {
          title: "Parallel Search",
          url: "https://docs.openclaw.ai/tools/parallel-search",
          snippet: "Use Parallel's hosted search with or without an API key.",
        },
      ],
    },
  };
}
