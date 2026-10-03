import type { MemoryCallerAuthority } from "openclaw/plugin-sdk/memory-host-search";
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
  loadCombinedSessionStoreForGatewayMock: Mock;
  searchMemoryWiki: typeof searchMemoryWiki;
};

/**
 * Registers sessionless caller coverage through real provider acquisition, the legacy
 * adapter, and Memory Core's session visibility owner.
 */
export function registerSessionlessAgentScopeQueryTests(params: SessionScopeTestParams): void {
  it.each([
    { caller: "library or CLI", memoryContext: undefined },
    {
      caller: "Gateway host",
      memoryContext: { authority: { kind: "host", operation: "wiki.search" } },
    },
    {
      caller: "Gateway operator",
      memoryContext: {
        authority: { kind: "operator", scopes: ["operator.read"], connId: "operator-connection" },
      },
    },
  ] satisfies ReadonlyArray<{
    caller: string;
    memoryContext?: { authority: MemoryCallerAuthority };
  }>)(
    "keeps an explicit agent's own session hits for a sessionless $caller search",
    async ({ memoryContext }) => {
      const { config } = await params.createQueryVault({
        initialize: true,
        config: {
          search: { backend: "shared", corpus: "memory" },
        },
      });
      params.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
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
      const manager = params.createMemoryManager({
        searchResults: [
          {
            path: "sessions/visible-session.jsonl",
            startLine: 1,
            endLine: 2,
            score: 30,
            snippet: "visible transcript",
            source: "sessions",
          },
          {
            path: "sessions/main/main-private.jsonl",
            startLine: 1,
            endLine: 2,
            score: 25,
            snippet: "other agent transcript",
            source: "sessions",
          },
          {
            path: "sessions/secondary/unlisted-session.jsonl",
            startLine: 1,
            endLine: 2,
            score: 22,
            snippet: "unlisted own transcript",
            source: "sessions",
          },
          {
            path: "sessions/other-session.jsonl",
            startLine: 3,
            endLine: 4,
            score: 20,
            snippet: "other transcript",
            source: "sessions",
          },
          {
            path: "MEMORY.md",
            startLine: 5,
            endLine: 6,
            score: 10,
            snippet: "durable memory",
            source: "memory",
          },
        ],
      });
      params.getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

      const appConfig = params.createAppConfig();
      const results = await params.searchMemoryWiki({
        config,
        appConfig,
        agentId: "secondary",
        ...(memoryContext ? { memoryContext: { ...memoryContext, assertCurrent() {} } } : {}),
        query: "transcript",
        maxResults: 10,
      });

      expect(params.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(appConfig, {
        agentId: "secondary",
      });
      expect(results.map((result) => result.path)).toEqual([
        "sessions/visible-session.jsonl",
        "sessions/secondary/unlisted-session.jsonl",
        "MEMORY.md",
      ]);
    },
  );
}
