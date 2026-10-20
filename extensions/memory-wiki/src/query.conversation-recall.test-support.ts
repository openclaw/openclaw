import type { MemoryCallerAuthority } from "openclaw/plugin-sdk/memory-host-search";
import { expect, it, vi, type Mock } from "vitest";
import type { MemoryWikiPluginConfig, ResolvedMemoryWikiConfig } from "./config.js";
import type { searchMemoryWiki } from "./query.js";

type ConversationRecallTestParams = {
  createQueryVault: (options: {
    initialize: true;
    config: MemoryWikiPluginConfig;
  }) => Promise<{ config: ResolvedMemoryWikiConfig }>;
  getActiveMemorySearchManagerMock: Mock;
  loadCombinedSessionStoreForGatewayAsyncMock: Mock;
  searchMemoryWiki: typeof searchMemoryWiki;
};

const ANCHOR_SESSION_KEY = "agent:main:telegram:direct:owner";
const RECALL_SESSION_KEY = `${ANCHOR_SESSION_KEY}:active-memory:abcdef123456`;
const CONVERSATION_RECALL = {
  anchorSessionKey: ANCHOR_SESSION_KEY,
  scope: "same-agent-private",
  corpus: "sessions",
} as const;

function createRecallManager() {
  const hit = (path: string, score: number, source: "memory" | "sessions" = "sessions") => ({
    path,
    startLine: 1,
    endLine: 2,
    score,
    snippet: path,
    source,
  });
  return {
    search: vi
      .fn()
      .mockResolvedValue([
        hit("sessions/prior-session.jsonl", 50),
        hit("sessions/current.jsonl", 40),
        hit("sessions/team-session.jsonl", 30),
        hit("sessions/secondary/other-agent.jsonl", 20),
        hit("MEMORY.md", 10, "memory"),
      ]),
    readFile: vi.fn(),
    status: vi.fn().mockReturnValue({ backend: "builtin", provider: "builtin" }),
    close: vi.fn(),
  };
}

const session = (sessionId: string, updatedAt: number, chatType = "direct") => ({
  sessionId,
  updatedAt,
  chatType,
});
const RECALL_SESSION_STORE = {
  [ANCHOR_SESSION_KEY]: session("current", 4),
  "agent:main:telegram:direct:prior": session("prior-session", 3),
  "agent:main:telegram:group:team": session("team-session", 2, "group"),
  "agent:secondary:telegram:direct:other": session("other-agent", 1),
};

export function registerConversationRecallQueryTests(params: ConversationRecallTestParams): void {
  it.each([
    [RECALL_SESSION_KEY, CONVERSATION_RECALL, ["sessions/prior-session.jsonl"]],
    [ANCHOR_SESSION_KEY, undefined, ["sessions/current.jsonl", "MEMORY.md"]],
  ] as const)(
    "enforces self visibility for %s",
    async (sessionKey, conversationRecall, expected) => {
      const { config } = await params.createQueryVault({
        initialize: true,
        config: { search: { backend: "shared", corpus: "memory" } },
      });
      params.loadCombinedSessionStoreForGatewayAsyncMock.mockResolvedValue({
        storePath: "(test)",
        store: RECALL_SESSION_STORE,
      });
      params.getActiveMemorySearchManagerMock.mockResolvedValue({ manager: createRecallManager() });
      // The Wiki tool copies the host-granted recall pass into its session authority.
      const recall = conversationRecall ? { conversationRecall } : {};
      const authority: MemoryCallerAuthority = {
        kind: "session",
        sessionKey,
        sandboxed: false,
        ...recall,
      };
      const results = await params.searchMemoryWiki({
        config,
        appConfig: {
          agents: { ownership: "explicit", entries: { main: {}, secondary: {} } },
          tools: { sessions: { visibility: "self" } },
        },
        agentId: "main",
        agentSessionKey: sessionKey,
        sandboxed: false,
        ...recall,
        memoryContext: { authority, assertCurrent() {} },
        query: "transcript",
        maxResults: 10,
      });
      expect(results.map((result) => result.path)).toEqual(expected);
    },
  );
}
