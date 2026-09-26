// Verifies that nested session tools keep execution identity without narrowing discovery policy.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../acp/runtime/registry.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import * as inProcessGateway from "./tools/in-process-gateway.js";

type GatewayRequest = { method: string; params?: Record<string, unknown> };
type OpenClawToolsOptions = NonNullable<Parameters<typeof createOpenClawTools>[0]>;

const embeddedGatewayCalls = vi.hoisted(() => vi.fn());
const embeddedGatewayResponseMock = vi.hoisted(() => vi.fn());
const createEmbeddedCallGatewayMock = vi.hoisted(() =>
  vi.fn(() => async (request: GatewayRequest) => {
    embeddedGatewayCalls(request);
    const response = embeddedGatewayResponseMock(request);
    if (response !== undefined) {
      return response;
    }
    if (request.method === "sessions.list") {
      return { sessions: [], hasMore: false };
    }
    if (request.method === "sessions.search") {
      return { results: [], indexing: false, truncated: false };
    }
    if (request.method === "chat.history") {
      return { messages: [] };
    }
    return { ok: false };
  }),
);

vi.mock("./tools/embedded-gateway-stub.js", () => ({
  createEmbeddedCallGateway: createEmbeddedCallGatewayMock,
}));

// This factory suite supplies authorized embedded rows. Registered producer and
// result-owner boundaries are exercised by sessions-list-privacy.test.ts.
vi.mock("../gateway/session-list-read-result.js", () => ({
  withCurrentSessionListRows: async <T>(
    rows: readonly object[],
    consume: (visible: readonly boolean[]) => T,
    requireOwner: boolean,
  ) => {
    expect(requireOwner).toBe(true);
    return consume(rows.map(() => true));
  },
}));

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

function createTools(
  config: OpenClawToolsOptions["config"],
  options: { sandboxed?: boolean; sessionConfigSource?: "runtime" | "pinned" } = {},
) {
  return createOpenClawTools({
    agentSessionKey: "global",
    runSessionKey: "agent:research:main",
    sandboxed: options.sandboxed,
    config,
    ...(options.sessionConfigSource ? { sessionConfigSource: options.sessionConfigSource } : {}),
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
  });
}

function requireTool(tools: ReturnType<typeof createOpenClawTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected tool ${name} to be registered`);
  }
  return tool;
}

afterEach(() => {
  unregisterAcpRuntimeBackend("session-context-test");
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  setEmbeddedMode(false);
  embeddedGatewayCalls.mockClear();
  embeddedGatewayResponseMock.mockReset();
  createEmbeddedCallGatewayMock.mockClear();
});

describe("openclaw session lookup context", () => {
  let matrixPlugin: ChannelPlugin;

  beforeAll(async () => {
    ({ matrixPlugin } = await loadBundledPluginFacade<{ matrixPlugin: ChannelPlugin }>({
      pluginId: "matrix",
      artifactBasename: "channel-plugin-api.js",
    }));
  });

  it.each([
    { source: "runtime", runtimeEnabled: true, pinnedEnabled: false, available: true },
    { source: "runtime", runtimeEnabled: false, pinnedEnabled: true, available: false },
    { source: "pinned", runtimeEnabled: false, pinnedEnabled: true, available: true },
    { source: "pinned", runtimeEnabled: true, pinnedEnabled: false, available: false },
  ] as const)(
    "uses $source spawn capabilities (runtime=$runtimeEnabled, pinned=$pinnedEnabled)",
    async ({ source, runtimeEnabled, pinnedEnabled, available }) => {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
      );
      registerAcpRuntimeBackend({
        id: "session-context-test",
        runtime: {
          async ensureSession() {
            throw new Error("Capability discovery must not create an ACP session");
          },
          async *runTurn() {},
          async cancel() {},
          async close() {},
        },
      });
      const capabilityConfig = (enabled: boolean) => ({
        acp: { enabled, backend: "session-context-test" },
        tools: { swarm: enabled },
        session: { threadBindings: { spawnSessions: true } },
        channels: {
          matrix: {
            accounts: { work: { threadBindings: { spawnSessions: enabled } } },
          },
        },
      });
      setRuntimeConfigSnapshot(capabilityConfig(runtimeEnabled));
      const tools = createOpenClawTools({
        agentSessionKey: "agent:main:matrix:channel:!room:example.org",
        agentChannel: "matrix",
        agentAccountId: "work",
        config: capabilityConfig(pinnedEnabled),
        sessionConfigSource: source,
        disablePluginTools: true,
        wrapBeforeToolCallHook: false,
      });
      const tool = requireTool(tools, "sessions_spawn");

      expect(tools.some((candidate) => candidate.name === "agents_wait")).toBe(available);
      expect(tool.parameters).toHaveProperty(
        "properties.mode.enum",
        available ? ["run", "session"] : ["run"],
      );
      expect(tool.parameters).toHaveProperty(
        "properties.runtime.enum",
        available ? ["subagent", "acp"] : ["subagent"],
      );
      if (available) {
        expect(tool.parameters).toHaveProperty("properties.thread.type", "boolean");
        expect(tool.parameters).toHaveProperty("properties.collect.type", "boolean");
      } else {
        expect(tool.parameters).not.toHaveProperty("properties.thread");
        expect(tool.parameters).not.toHaveProperty("properties.collect");
        await expect(
          tool.execute("disabled-acp", { runtime: "acp", task: "must not start" }),
        ).resolves.toMatchObject({
          details: {
            status: "error",
            error: expect.stringContaining("ACP is disabled by policy"),
          },
        });
      }
    },
  );

  it.each([
    { scope: "global", mainKey: "main", runSessionKey: "global" },
    {
      scope: "global",
      mainKey: "conversation",
      runSessionKey: "global",
    },
    { scope: "per-sender", mainKey: "main", runSessionKey: "global" },
    {
      scope: "global",
      mainKey: "main",
      runSessionKey: "agent:research:dashboard:control",
    },
  ] as const)("routes progress cards to $runSessionKey under $scope scope", async (scenario) => {
    const gatewayCall = vi.spyOn(inProcessGateway, "callInProcessGatewayTool").mockResolvedValue({
      card: null,
    });
    try {
      const tools = createOpenClawTools({
        config: {
          agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
          session: { scope: scenario.scope, mainKey: scenario.mainKey },
        },
        agentSessionKey: "agent:research:main",
        runSessionKey: scenario.runSessionKey,
        requesterAgentIdOverride: "research",
        disablePluginTools: true,
        disableMessageTool: true,
        wrapBeforeToolCallHook: false,
      });

      await requireTool(tools, "progress_card").execute("synthetic-progress", {});

      expect(gatewayCall).toHaveBeenCalledWith("progressCard.put", {
        sessionKey: scenario.runSessionKey,
        agentId: "research",
      });
    } finally {
      gatewayCall.mockRestore();
    }
  });

  it("binds nested session lookups to the durable caller", async () => {
    const runSessionKey = "agent:research:main";
    setEmbeddedMode(true);
    const tools = createTools(
      { agents: { list: [{ id: "main", default: true }, { id: "research" }] } },
      { sandboxed: true },
    );

    await requireTool(tools, "sessions_list").execute("list", {});
    await requireTool(tools, "sessions_search").execute("search", { query: "needle" });
    await requireTool(tools, "sessions_history").execute("history", { sessionKey: "current" });

    expect(createEmbeddedCallGatewayMock).toHaveBeenCalledWith();
    expect(embeddedGatewayCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.list",
        params: expect.objectContaining({ spawnedBy: runSessionKey }),
      }),
    );
    expect(embeddedGatewayCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.search",
        params: expect.objectContaining({ sessionKeys: [runSessionKey] }),
      }),
    );
    expect(embeddedGatewayCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "chat.history",
        params: expect.objectContaining({ sessionKey: runSessionKey }),
      }),
    );
  });

  it("preserves implicit all-agent discovery for authorized callers", async () => {
    embeddedGatewayResponseMock.mockImplementation((request: GatewayRequest) => {
      if (request.method === "sessions.list") {
        return {
          sessions: [
            { key: "agent:main:main", agentId: "main", kind: "main" },
            { key: "agent:research:main", agentId: "research", kind: "main" },
          ],
          hasMore: false,
        };
      }
      if (request.method === "sessions.search") {
        const agentId = request.params?.agentId;
        const sessionKeys = request.params?.sessionKeys;
        const sessionKey = Array.isArray(sessionKeys) ? sessionKeys[0] : undefined;
        return typeof agentId === "string" && typeof sessionKey === "string"
          ? {
              results: [
                {
                  sessionKey,
                  timestamp: 1,
                  role: "user",
                  snippet: `${agentId} hit`,
                  score: 1,
                },
              ],
              indexing: false,
              truncated: false,
            }
          : { results: [] };
      }
      return undefined;
    });
    setEmbeddedMode(true);
    const tools = createTools({
      agents: { list: [{ id: "main", default: true }, { id: "research" }] },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });

    const listed = await requireTool(tools, "sessions_list").execute("list", {});
    const searched = await requireTool(tools, "sessions_search").execute("search", {
      query: "hit",
    });

    expect((listed.details as { sessions: Array<{ agentId: string }> }).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: "main" }),
        expect.objectContaining({ agentId: "research" }),
      ]),
    );
    expect((searched.details as { results: Array<{ snippet: string }> }).results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ snippet: "main hit" }),
        expect.objectContaining({ snippet: "research hit" }),
      ]),
    );
    const discoveryRequests = embeddedGatewayCalls.mock.calls
      .map(([request]) => request as GatewayRequest)
      .filter((request) => request.method === "sessions.list");
    expect(discoveryRequests).not.toHaveLength(0);
    expect(discoveryRequests.some((request) => request.params?.agentId === undefined)).toBe(true);
  });

  it("applies live session visibility grants and revocations to already-created lookup tools", async () => {
    const accessibleConfig = {
      agents: { list: [{ id: "main", default: true }, { id: "research" }] },
      tools: {
        sessions: { visibility: "all" as const },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    };
    const restrictedConfig = {
      ...accessibleConfig,
      tools: {
        sessions: { visibility: "self" as const },
        agentToAgent: { enabled: false },
      },
    };
    embeddedGatewayResponseMock.mockImplementation((request: GatewayRequest) => {
      if (request.method === "sessions.list") {
        return {
          sessions: [
            { key: "agent:main:main", agentId: "main", kind: "main" },
            { key: "agent:research:main", agentId: "research", kind: "main" },
          ],
          hasMore: false,
        };
      }
      if (request.method === "chat.history") {
        return { messages: [{ role: "user", content: "private history" }] };
      }
      return undefined;
    });
    setEmbeddedMode(true);
    setRuntimeConfigSnapshot(accessibleConfig);
    const tools = createTools(accessibleConfig, { sessionConfigSource: "runtime" });
    const list = requireTool(tools, "sessions_list");
    const history = requireTool(tools, "sessions_history");
    const search = requireTool(tools, "sessions_search");
    setEmbeddedMode(false);
    const send = requireTool(
      createTools(accessibleConfig, { sessionConfigSource: "runtime" }),
      "sessions_send",
    );
    setEmbeddedMode(true);

    const granted = await list.execute("granted", {});
    expect((granted.details as { sessions: Array<{ agentId: string }> }).sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: "main" })]),
    );

    setRuntimeConfigSnapshot(restrictedConfig);
    await expect(
      send.execute("revoked-send", {
        agentId: "main",
        label: "private",
        message: "should never be delivered",
      }),
    ).resolves.toMatchObject({ details: { status: "forbidden" } });
    const revoked = await list.execute("revoked", {});
    expect((revoked.details as { sessions: Array<{ agentId: string }> }).sessions).toEqual([
      expect.objectContaining({ agentId: "research" }),
    ]);
    await expect(
      history.execute("revoked-history", { sessionKey: "agent:main:main" }),
    ).resolves.toMatchObject({ details: { status: "forbidden" } });
    await expect(
      search.execute("revoked-search", { query: "private", sessionKey: "agent:main:main" }),
    ).resolves.toMatchObject({ details: { status: "forbidden" } });
    setRuntimeConfigSnapshot(accessibleConfig);
    const restored = await list.execute("restored", {});
    expect((restored.details as { sessions: Array<{ agentId: string }> }).sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: "main" })]),
    );
  });

  it("keeps an explicitly pinned session policy even when it initially matches runtime config", async () => {
    const pinnedConfig = {
      agents: { list: [{ id: "main", default: true }, { id: "research" }] },
      tools: {
        sessions: { visibility: "all" as const },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    };
    embeddedGatewayResponseMock.mockImplementation((request: GatewayRequest) =>
      request.method === "sessions.list"
        ? {
            sessions: [
              { key: "agent:main:main", agentId: "main", kind: "main" },
              { key: "agent:research:main", agentId: "research", kind: "main" },
            ],
            hasMore: false,
          }
        : undefined,
    );
    setEmbeddedMode(true);
    setRuntimeConfigSnapshot(structuredClone(pinnedConfig));
    const tools = createTools(pinnedConfig, { sessionConfigSource: "pinned" });
    setRuntimeConfigSnapshot({
      ...pinnedConfig,
      tools: {
        sessions: { visibility: "self" },
        agentToAgent: { enabled: false },
      },
    });

    const result = await requireTool(tools, "sessions_list").execute("pinned", {});
    expect((result.details as { sessions: Array<{ agentId: string }> }).sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: "main" })]),
    );
  });
});
