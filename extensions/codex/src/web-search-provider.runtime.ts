import {
  readStringParam,
  resolveSearchTimeoutSeconds,
  type SearchConfigRecord,
  type WebSearchProviderToolExecutionContext,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-search";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import {
  runBoundedCodexAppServerTurn,
  type CodexBoundedTurnOptions,
} from "./app-server/bounded-turn.js";
import { projectCodexWebSearchItem } from "./app-server/web-search-item.js";
import { buildCodexNativeWebSearchThreadConfig } from "./app-server/web-search.js";

type WebSearchProviderContext = Parameters<WebSearchProviderPlugin["createTool"]>[0];

export async function executeCodexWebSearchProviderTool(
  ctx: WebSearchProviderContext,
  args: Record<string, unknown>,
  executionContext: WebSearchProviderToolExecutionContext | undefined,
  options: CodexBoundedTurnOptions,
): Promise<Record<string, unknown>> {
  const query = readStringParam(args, "query", { required: true });
  const start = Date.now();
  const result = await runBoundedCodexAppServerTurn({
    config: ctx.config,
    model: { mode: "live-default" },
    modelProvider: "openai",
    timeoutMs: resolveSearchTimeoutSeconds(ctx.searchConfig as SearchConfigRecord) * 1_000,
    signal: executionContext?.signal,
    assertCurrent: executionContext?.assertCurrent,
    agentDir: ctx.agentDir,
    options,
    taskLabel: "hosted search",
    developerInstructions:
      "You are OpenClaw's bounded web-search worker. You must use Codex hosted web_search to answer the user's search query. Return a concise grounded answer with source URLs. Do not call other tools, edit files, or ask follow-up questions.",
    input: [{ type: "text", text: query, text_elements: [] }],
    requiredModalities: ["text"],
    isolation: "private-stdio",
    threadConfig: buildCodexNativeWebSearchThreadConfig(ctx.config),
  });
  const searches = result.items
    .filter((item) => item.type === "webSearch")
    .map(projectCodexWebSearchItem);
  if (searches.length === 0) {
    throw new Error("Codex hosted search completed without invoking web search.");
  }
  return {
    query,
    provider: "codex",
    model: result.model,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "codex",
      wrapped: true,
    },
    content: wrapWebContent(result.text, "web_search"),
    searches,
  };
}
