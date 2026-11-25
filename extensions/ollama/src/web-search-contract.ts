import type { WebSearchProviderToolDefinition } from "openclaw/plugin-sdk/provider-web-search-contract";
import { WEB_SEARCH_QUERY_COUNT_PROPERTIES } from "openclaw/plugin-sdk/provider-web-search-contract";

export const OLLAMA_WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the web using Ollama's web search API. Returns titles, URLs, and snippets from the configured Ollama host.";

export const OLLAMA_WEB_SEARCH_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    ...WEB_SEARCH_QUERY_COUNT_PROPERTIES,
  },
  required: ["query"],
  additionalProperties: false,
} as const satisfies WebSearchProviderToolDefinition["parameters"];
