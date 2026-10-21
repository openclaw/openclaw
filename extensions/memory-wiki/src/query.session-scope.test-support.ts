import { expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../api.js";
import type { MemoryWikiPluginConfig, ResolvedMemoryWikiConfig } from "./config.js";
import type { searchMemoryWiki } from "./query.js";

type SessionScopeTestParams = {
  createQueryVault: (options: {
    initialize: true;
    config: MemoryWikiPluginConfig;
  }) => Promise<{ config: ResolvedMemoryWikiConfig }>;
  /** Config with agent-wide session visibility and agents `main` and `secondary`. */
  createAppConfig: () => OpenClawConfig;
  createMemoryManager: (overrides: {
    searchResults: Array<{
      path: string;
      startLine: number;
      endLine: number;
      score: number;
      snippet: string;
      source: "memory" | "sessions";
    }>;
  }) => unknown;
  getActiveMemorySearchManagerMock: Mock;
  loadCombinedSessionStoreForGatewayAsyncMock: Mock;
  searchMemoryWiki: typeof searchMemoryWiki;
};

// Exercise the legacy adapter and Memory Core's visibility owner, not a mocked filter.
export function registerSessionlessAgentScopeQueryTests(params: SessionScopeTestParams): void {
  it("keeps an explicit agent's own session hits for a sessionless library or CLI search", async () => {
    const { config } = await params.createQueryVault({
      initialize: true,
      config: { search: { backend: "shared", corpus: "memory" } },
    });
    params.loadCombinedSessionStoreForGatewayAsyncMock.mockResolvedValue({
      storePath: "(test)",
      store: {
        "agent:secondary:visible-session": {
          sessionId: "visible-session",
          updatedAt: 1,
          sessionFile: "/tmp/openclaw/visible-session.jsonl",
        },
        "agent:main:main-private": {
          sessionId: "main-private",
          updatedAt: 2,
          sessionFile: "/tmp/openclaw/main-private.jsonl",
        },
      },
    });
    const hit = (
      path: string,
      startLine: number,
      endLine: number,
      score: number,
      snippet: string,
      source: "sessions" | "memory" = "sessions",
    ) => ({ path, startLine, endLine, score, snippet, source });
    const manager = params.createMemoryManager({
      searchResults: [
        hit("sessions/visible-session.jsonl", 1, 2, 30, "visible transcript"),
        hit("sessions/main/main-private.jsonl", 1, 2, 25, "other agent transcript"),
        hit("sessions/secondary/unlisted-session.jsonl", 1, 2, 22, "unlisted own transcript"),
        hit("sessions/other-session.jsonl", 3, 4, 20, "other transcript"),
        hit("MEMORY.md", 5, 6, 10, "durable memory", "memory"),
      ],
    });
    params.getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const appConfig = params.createAppConfig();
    const results = await params.searchMemoryWiki({
      config,
      appConfig,
      agentId: "secondary",
      query: "transcript",
      maxResults: 10,
    });

    expect(params.loadCombinedSessionStoreForGatewayAsyncMock).toHaveBeenCalledWith(appConfig, {
      agentId: "secondary",
    });
    expect(results.map((result) => result.path)).toEqual([
      "sessions/visible-session.jsonl",
      "sessions/secondary/unlisted-session.jsonl",
      "MEMORY.md",
    ]);
  });
}
