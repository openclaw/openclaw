import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { operatorRefusalText } from "openclaw/plugin-sdk/tool-results";
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
const allowed = { refused: [false, false], embeds: 2, searches: 2, deletes: 1 };
const refused = { refused: [true, true], embeds: 0, searches: 0, deletes: 0 };
const allowRecall = {
  fingerprint: "synthetic-memory-authority",
  allows: (toolName: string) => toolName === "memory_recall",
  assertActive: () => undefined,
};
const isRefused = (result: { details?: { reason?: unknown } }) =>
  result.details?.reason === "owner_private_memory";
const resultText = (result: { content?: Array<{ text?: string }> }) => result.content?.[0]?.text;

// `ownerOnly` is the plugin config the plugin registered with. `live` is what the runtime
// config reports afterwards, before the plugin reload that a config change starts.
function registerMemoryPlugin(params: { ownerOnly?: boolean; live?: () => boolean | undefined }) {
  const pluginConfig = {
    embedding: { provider: "openai", model: "synthetic-test-embedding", dimensions: 3 },
    autoRecall: true,
    autoCapture: false,
    ...(params.ownerOnly === undefined ? {} : { ownerOnly: params.ownerOnly }),
  };
  const config = { plugins: { entries: { "memory-lancedb": { config: pluginConfig } } } };
  const on = vi.fn();
  const registerTool = vi.fn();
  const runtime = createPluginRuntimeMock();
  runtime.config.current = () => {
    const ownerOnly = params.live?.();
    const live = ownerOnly === undefined ? pluginConfig : { ...pluginConfig, ownerOnly };
    return { plugins: { entries: { "memory-lancedb": { config: live } } } };
  };
  memoryPlugin.register(createTestPluginApi({ pluginConfig, config, runtime, on, registerTool }));
  return {
    // The host prepares a turn's tools by calling each factory with the turn's audience.
    prepareTool: (name: string, audience: unknown) =>
      registerTool.mock.calls.find(([, options]) => options?.name === name)?.[0]?.({
        agentId: "main",
        config,
        memoryAudience: audience,
      }),
    hook: on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1],
  };
}

// One turn: prepare its memory tools, then call both and run automatic recall.
async function runTurn(
  plugin: ReturnType<typeof registerMemoryPlugin>,
  audience: unknown,
  afterPrepare?: () => void,
) {
  const search = vi.spyOn(MemoryDB.prototype, "search").mockResolvedValue([]);
  const remove = vi.spyOn(MemoryDB.prototype, "delete").mockResolvedValue(false);
  const recallTool = plugin.prepareTool("memory_recall", audience);
  const forgetTool = plugin.prepareTool("memory_forget", audience);
  afterPrepare?.();
  const recall = await recallTool.execute("recall", { query: "synthetic query" });
  const forget = await forgetTool.execute("forget", {
    memoryId: "00000000-0000-4000-8000-000000000000",
  });
  await plugin.hook(
    { prompt: "synthetic automatic recall prompt", messages: [] },
    {
      agentId: "main",
      sessionKey: "agent:main:synthetic",
      memoryAudience: audience,
      toolAuthority: allowRecall,
    },
  );
  return {
    recall,
    forget,
    summary: {
      refused: [isRefused(recall), isRefused(forget)],
      embeds: embed.mock.calls.length,
      searches: search.mock.calls.length,
      deletes: remove.mock.calls.length,
    },
  };
}

describe("stored memory access by session audience", () => {
  test.each([
    { name: "the owner's direct chat", audience: ownerChat, expected: allowed },
    { name: "a group chat", audience: groupChat, expected: refused },
    { name: "a session with no audience", audience: undefined, expected: refused },
    {
      name: "another agent's owner chat",
      audience: { kind: "owner-private", agentId: "other" },
      expected: refused,
    },
    {
      name: "a group chat with ownerOnly off",
      audience: groupChat,
      ownerOnly: false,
      expected: allowed,
    },
  ])("recall, forget and automatic recall in $name", async (row) => {
    const turn = await runTurn(registerMemoryPlugin({ ownerOnly: row.ownerOnly }), row.audience);

    expect(turn.summary).toEqual(row.expected);
  });

  test("a refused tool call gets the Gateway's owner-private memory refusal", async () => {
    const turn = await runTurn(registerMemoryPlugin({}), groupChat);

    expect([resultText(turn.recall), resultText(turn.forget)]).toEqual([
      operatorRefusalText("owner-private-memory", "search stored memories"),
      operatorRefusalText("owner-private-memory", "delete stored memories"),
    ]);
  });

  // A config change reaches the next turn through the plugin reload it starts. A turn whose
  // tools are already prepared keeps the rule it was prepared with.
  test.each([
    { change: "turned on", registered: false, live: true, expected: allowed },
    { change: "turned off", registered: true, live: false, expected: refused },
  ])("ownerOnly $change after a turn's tools are prepared", async (row) => {
    let live: boolean | undefined;
    const plugin = registerMemoryPlugin({ ownerOnly: row.registered, live: () => live });

    const turn = await runTurn(plugin, groupChat, () => {
      live = row.live;
    });

    expect(turn.summary).toEqual(row.expected);
  });

  test("automatic recall neither embeds nor searches once the audience is stale", async () => {
    const search = vi.spyOn(MemoryDB.prototype, "search").mockResolvedValue([]);
    const { hook } = registerMemoryPlugin({});

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
