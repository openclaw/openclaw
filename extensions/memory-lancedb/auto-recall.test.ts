import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, test, vi } from "vitest";
import memoryPlugin from "./index.js";
import { MemoryDB } from "./lancedb-store.js";
import { withOwnerChat } from "./test-helpers.js";

const embed = vi.hoisted(() => vi.fn(async () => [0.1, 0.2, 0.3]));
vi.mock("./embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embeddings.js")>()),
  createEmbeddings: () => ({ embed, start() {} }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  embed.mockClear();
});

describe("automatic memory recall privacy", () => {
  test.each([
    { sessionKey: "agent:main:dashboard:incognito-recall", expectedCalls: 0 },
    { sessionKey: "agent:main:dashboard:ordinary-recall", expectedCalls: 1 },
  ])("limits embedding and search for $sessionKey", async ({ sessionKey, expectedCalls }) => {
    const search = vi.spyOn(MemoryDB.prototype, "search").mockResolvedValue([]);
    const pluginConfig = {
      embedding: { provider: "openai", model: "synthetic-test-embedding", dimensions: 3 },
      autoRecall: true,
      autoCapture: false,
      captureMaxChars: 500,
      recallMaxChars: 1000,
    };
    const config = { plugins: { entries: { "memory-lancedb": { config: pluginConfig } } } };
    const on = vi.fn();
    const runtime = createPluginRuntimeMock();
    runtime.config.current = () => config;
    memoryPlugin.register(createTestPluginApi({ pluginConfig, config, runtime, on }));
    const hook = on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1];
    expect(hook).toBeTypeOf("function");

    await expect(
      hook(
        { prompt: "SYNTHETIC_INCOGNITO_EMBEDDING_SENTINEL", messages: [] },
        withOwnerChat({
          agentId: "main",
          sessionKey,
          toolAuthority: {
            fingerprint: "synthetic-memory-authority",
            allows: (toolName: string) => toolName === "memory_recall",
            assertActive: () => undefined,
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(embed).toHaveBeenCalledTimes(expectedCalls);
    expect(search).toHaveBeenCalledTimes(expectedCalls);
  });
});

const ownerChat = { kind: "owner-private", agentId: "main" };
const groupChat = {
  kind: "conversation",
  agentId: "main",
  sessionKey: "agent:main:telegram:group:synthetic",
  sessionId: "synthetic-session",
};
const noOwnerAudience = "this session has no owner-private memory audience";
const allowed = { denial: undefined, embeds: 2, searches: 2, deletes: 1, namesOptOut: false };
const refused = (denial: string) => ({
  denial,
  embeds: 0,
  searches: 0,
  deletes: 0,
  namesOptOut: true,
});
// Every refusal names the opt-out that works for every session, never a repair that cannot.
const namesOptOut = (result: { content?: unknown }) =>
  JSON.stringify(result.content).includes("ownerOnly: false");
const allowRecall = {
  fingerprint: "synthetic-memory-authority",
  allows: (toolName: string) => toolName === "memory_recall",
  assertActive: () => undefined,
};

// ownerOnly: false goes only into the live config, so the rule must read it per call.
function registerWithLiveConfig(ownerOnly: boolean, audience: unknown) {
  const pluginConfig = {
    embedding: { provider: "openai", model: "synthetic-test-embedding", dimensions: 3 },
    autoRecall: true,
    autoCapture: false,
  };
  const config = { plugins: { entries: { "memory-lancedb": { config: pluginConfig } } } };
  const live = ownerOnly ? pluginConfig : { ...pluginConfig, ownerOnly };
  const on = vi.fn();
  const registerTool = vi.fn();
  const runtime = createPluginRuntimeMock();
  runtime.config.current = () => ({ plugins: { entries: { "memory-lancedb": { config: live } } } });
  memoryPlugin.register(createTestPluginApi({ pluginConfig, config, runtime, on, registerTool }));
  return {
    tool: (name: string) =>
      registerTool.mock.calls.find(([, options]) => options?.name === name)?.[0]?.({
        agentId: "main",
        config,
        memoryAudience: audience,
      }),
    hook: on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1],
  };
}

describe("stored memory access by session audience", () => {
  test.each([
    { name: "the owner's direct chat", audience: ownerChat, expected: allowed },
    { name: "a group chat", audience: groupChat, expected: refused(noOwnerAudience) },
    { name: "a session with no audience", audience: undefined, expected: refused(noOwnerAudience) },
    {
      name: "another agent's owner chat",
      audience: { kind: "owner-private", agentId: "other" },
      expected: refused("the memory audience belongs to another agent"),
    },
    {
      name: "a group chat with ownerOnly off",
      audience: groupChat,
      ownerOnly: false,
      expected: allowed,
    },
  ])("recall, forget and automatic recall in $name", async (row) => {
    const search = vi.spyOn(MemoryDB.prototype, "search").mockResolvedValue([]);
    const remove = vi.spyOn(MemoryDB.prototype, "delete").mockResolvedValue(false);
    const { tool, hook } = registerWithLiveConfig(row.ownerOnly !== false, row.audience);

    const recall = await tool("memory_recall").execute("recall", { query: "synthetic query" });
    const forget = await tool("memory_forget").execute("forget", {
      memoryId: "00000000-0000-4000-8000-000000000000",
    });
    await hook(
      { prompt: "synthetic automatic recall prompt", messages: [] },
      {
        agentId: "main",
        sessionKey: "agent:main:synthetic",
        memoryAudience: row.audience,
        toolAuthority: allowRecall,
      },
    );

    expect([recall.details?.denial, forget.details?.denial]).toEqual([
      row.expected.denial,
      row.expected.denial,
    ]);
    expect({
      denial: row.expected.denial,
      embeds: embed.mock.calls.length,
      searches: search.mock.calls.length,
      deletes: remove.mock.calls.length,
      namesOptOut: namesOptOut(recall) && namesOptOut(forget),
    }).toEqual(row.expected);
  });

  test("automatic recall neither embeds nor searches once the audience is stale", async () => {
    const search = vi.spyOn(MemoryDB.prototype, "search").mockResolvedValue([]);
    const { hook } = registerWithLiveConfig(true, ownerChat);

    const result = await hook(
      { prompt: "what tea do I like?", messages: [] },
      {
        agentId: "main",
        sessionKey: "agent:main:synthetic",
        memoryAudience: ownerChat,
        assertMemoryAudienceCurrent: () => {
          throw new Error("synthetic stale memory audience");
        },
        toolAuthority: allowRecall,
      },
    );

    expect({ result, embeds: embed.mock.calls.length, searches: search.mock.calls.length }).toEqual(
      {
        result: undefined,
        embeds: 0,
        searches: 0,
      },
    );
  });
});
