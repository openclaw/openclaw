import {
  filterMemorySearchHitsBySessionVisibility,
  prepareMemorySearchChannelRead,
} from "@openclaw/memory-core/session-search-visibility-api.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginGatewayRuntime } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  normalizeSessionDeliveryState,
  resolveStorePath,
  updateLastRoute,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { getActiveMemorySearchManagerMock } = vi.hoisted(() => ({
  getActiveMemorySearchManagerMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-host-search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/memory-host-search")>()),
  getActiveMemorySearchManager: getActiveMemorySearchManagerMock,
  getActiveMemoryProvider: vi.fn(),
  isActiveMemoryProviderNative: vi.fn(async () => false),
}));

vi.mock("@openclaw/memory-core/session-search-visibility-api.js", { spy: true });

const requester = "agent:main:slack:channel:c111:thread:1.001";
const retained = "agent:main:slack:channel:c111:thread:1.002";
const forbidden = "agent:main:slack:channel:c222:thread:1.003";

const sessionHit = (id: string, score: number) => ({
  path: `sessions/main/${id}.jsonl`,
  startLine: 3,
  endLine: 4,
  score,
  snippet: `${id}-snippet`,
  source: "sessions" as const,
  citation: `sessions/main/${id}.jsonl#L3-L4`,
});

const durableHit = {
  path: "MEMORY.md",
  startLine: 5,
  endLine: 6,
  score: 10,
  snippet: "durable-snippet",
  source: "memory" as const,
  citation: "MEMORY.md#L5-L6",
};

async function withDirectWikiGateway(
  run: (fixture: {
    config: OpenClawConfig;
    search: (sessionKey?: string) => ReturnType<typeof searchMemoryWiki>;
    storePath: string;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "memory-wiki-channel-disclosure" }, async (state) => {
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
      tools: { sessions: { visibility: "channel" as const } },
    };
    const storePath = resolveStorePath(config.session?.store, { agentId: "main" });
    const store = async (sessionKey: string, sessionId: string, to: string) =>
      await upsertSessionEntry({
        agentId: "main",
        storePath,
        sessionKey,
        entry: {
          sessionId,
          updatedAt: 1,
          chatType: "channel",
          space: "t111",
          delivery: normalizeSessionDeliveryState({
            context: { channel: "slack", accountId: "default", to },
            origin: { provider: "slack", accountId: "default", chatType: "channel" },
          }),
        },
      });
    await store(requester, "requester", "channel:c111");
    await store(retained, "retained", "channel:c111");
    await store(forbidden, "forbidden", "channel:c222");
    getActiveMemorySearchManagerMock.mockResolvedValue({
      manager: {
        search: vi.fn(async () => [
          sessionHit("forbidden", 50),
          sessionHit("retained", 40),
          sessionHit("missing-owner", 20),
          durableHit,
        ]),
      },
    });
    const { config: wikiConfig } = await createMemoryWikiTestHarness().createVault({
      initialize: true,
      config: { search: { backend: "shared", corpus: "memory" } },
    });
    const gateway = await createTestPluginGatewayRuntime({ pluginId: "memory-wiki", config });
    const search = (sessionKey = requester) =>
      gateway.runInGatewayScope(() =>
        searchMemoryWiki({
          config: wikiConfig,
          appConfig: config,
          agentId: "main",
          agentSessionKey: sessionKey,
          query: "snippet",
          maxResults: 2,
        }),
      );
    try {
      await run({ config, search, storePath });
    } finally {
      await gateway.close();
      getActiveMemorySearchManagerMock.mockReset();
      vi.mocked(filterMemorySearchHitsBySessionVisibility).mockRestore();
      vi.mocked(prepareMemorySearchChannelRead).mockRestore();
    }
  });
}

it("finalizes direct Wiki snippets and citations with the real Gateway owner", async () => {
  await withDirectWikiGateway(async ({ search }) => {
    const results = await search();
    expect(results.map(({ snippet, citation }) => ({ snippet, citation }))).toEqual([
      { snippet: "retained-snippet", citation: "sessions/main/retained.jsonl#L3-L4" },
      { snippet: "durable-snippet", citation: "MEMORY.md#L5-L6" },
    ]);
  });
});

it.each(["route", "policy"] as const)(
  "fails direct Wiki transcript disclosure closed after %s withdrawal",
  async (withdrawal) => {
    await withDirectWikiGateway(async ({ config, search, storePath }) => {
      const prepared = createDeferred<void>();
      const release = createDeferred<void>();
      const { prepareMemorySearchChannelRead: realPrepare } = await vi.importActual<
        typeof import("@openclaw/memory-core/session-search-visibility-api.js")
      >("@openclaw/memory-core/session-search-visibility-api.js");
      vi.mocked(prepareMemorySearchChannelRead).mockImplementation(async (params) => {
        const capability = await realPrepare(params);
        prepared.resolve();
        await release.promise;
        return capability;
      });
      const execution = search();
      await prepared.promise;
      if (withdrawal === "route") {
        await updateLastRoute({
          storePath,
          sessionKey: retained,
          channel: "slack",
          accountId: "default",
          to: "channel:c222",
          createIfMissing: false,
        });
      } else {
        config.tools = { sessions: { visibility: "self" } };
      }
      release.resolve();
      const results = await execution;
      expect(results.map(({ snippet, citation }) => ({ snippet, citation }))).toEqual([
        { snippet: "durable-snippet", citation: "MEMORY.md#L5-L6" },
      ]);
    });
  },
);

it("fails closed when the direct Wiki requester has no Gateway owner", async () => {
  await withDirectWikiGateway(async ({ search }) => {
    const results = await search("agent:main:slack:channel:c111:thread:missing");
    expect(results.map(({ snippet, citation }) => ({ snippet, citation }))).toEqual([
      { snippet: "durable-snippet", citation: "MEMORY.md#L5-L6" },
    ]);
  });
});
