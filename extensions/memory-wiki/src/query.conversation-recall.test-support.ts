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

// One hit per recall decision: allowed prior private chat, the live anchor, a group
// chat, another agent's private chat, and durable memory outside the sessions corpus.
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

const RECALL_SESSION_STORE = {
  [ANCHOR_SESSION_KEY]: { sessionId: "current", updatedAt: 4, chatType: "direct" },
  "agent:main:telegram:direct:prior": {
    sessionId: "prior-session",
    updatedAt: 3,
    chatType: "direct",
  },
  "agent:main:telegram:group:team": { sessionId: "team-session", updatedAt: 2, chatType: "group" },
  "agent:secondary:telegram:direct:other": {
    sessionId: "other-agent",
    updatedAt: 1,
    chatType: "direct",
  },
};

// Exercise provider acquisition and Memory Core's visibility owner through the legacy adapter.
export function registerConversationRecallQueryTests(params: ConversationRecallTestParams): void {
  const searchAsSession = async (
    sessionKey: string,
    conversationRecall?: typeof CONVERSATION_RECALL,
  ) => {
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
    return results.map((result) => result.path);
  };

  it("returns recall-granted same-agent private session hits under self visibility", async () => {
    // The live anchor, group chat, other agent, and non-session memory stay refused.
    await expect(searchAsSession(RECALL_SESSION_KEY, CONVERSATION_RECALL)).resolves.toEqual([
      "sessions/prior-session.jsonl",
    ]);
  });

  it("keeps requester visibility for a session search without recall under self visibility", async () => {
    await expect(searchAsSession(ANCHOR_SESSION_KEY)).resolves.toEqual([
      "sessions/current.jsonl",
      "MEMORY.md",
    ]);
  });
}
