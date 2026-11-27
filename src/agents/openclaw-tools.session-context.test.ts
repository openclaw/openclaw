import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../acp/runtime/registry.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  bindScheduledExecutionContext,
  readScheduledToolTargets,
} from "../cron/execution-context-registry.js";
import { buildScheduledExecutionContext } from "../cron/execution-context.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { createOperationalRunInstanceRef } from "./operational-run-instance.js";
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
    return (
      new Map<string, object>([
        ["sessions.list", { sessions: [], hasMore: false }],
        ["sessions.search", { results: [], indexing: false, truncated: false }],
        ["chat.history", { messages: [] }],
      ]).get(request.method) ?? { ok: false }
    );
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

function createToolCaller(
  config: OpenClawToolsOptions["config"],
  options: Omit<OpenClawToolsOptions, "config"> = {},
) {
  const tools = createOpenClawTools({
    agentSessionKey: "global",
    runSessionKey: "agent:research:main",
    config,
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
    ...options,
  });
  return (name: string, params: Record<string, unknown> = {}) =>
    requireTool(tools, name).execute(name, params);
}

function expectGateway(method: string, params: Record<string, unknown>) {
  expect(embeddedGatewayCalls).toHaveBeenCalledWith(
    expect.objectContaining({ method, params: expect.objectContaining(params) }),
  );
}

const agentRows = (...ids: string[]) =>
  expect.arrayContaining(ids.map((agentId) => expect.objectContaining({ agentId })));

function requireTool(tools: ReturnType<typeof createOpenClawTools>, name: string) {
  return expectDefined(
    tools.find((candidate) => candidate.name === name),
    `Expected tool ${name}`,
  );
}

async function expectForbidden(
  call: ReturnType<typeof createToolCaller>,
  name: string,
  params: Record<string, unknown>,
) {
  await expect(call(name, params)).resolves.toMatchObject({
    details: { status: "forbidden" },
  });
}

function sessionPolicyConfig(visibility: "all" | "self" = "all") {
  return {
    agents: { entries: { main: {}, research: {} } },
    tools: {
      sessions: { visibility },
      agentToAgent: visibility === "all" ? { enabled: true, allow: ["*"] } : { enabled: false },
    },
  };
}

function mockSessionDiscovery(response?: (request: GatewayRequest) => unknown) {
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
    return response?.(request);
  });
  setEmbeddedMode(true);
}

it.each(["once", "scheduled"] as const)(
  "keeps %s conversation learning in its owning agent under default visibility",
  async (mode) => {
    const runSessionKey = "agent:research:dock:scribe";
    const declarationKey = "knowledge:scribe:conversations";
    const runId = mode === "once" ? `${declarationKey}:${runSessionKey}:attempt` : "scheduled-run";
    const operationalRunInstance = createOperationalRunInstanceRef(runId);
    if (mode === "scheduled") {
      const job = {
        id: "scribe-job",
        declarationKey,
        sessionTarget: "isolated" as const,
        payload: { kind: "agentTurn" as const, message: "Legacy saved wording" },
      };
      const context = buildScheduledExecutionContext(job, {
        trigger: "cron",
        occurrence: { runId, executionRevision: "rev-1" },
        agentId: "research",
        runSessionKey,
        agentMainSessionKey: "agent:research:main",
        agentSandboxMode: "off",
      });
      expect(context.status).toBe("ready");
      if (context.status !== "ready") {
        return;
      }
      const release = bindScheduledExecutionContext(operationalRunInstance, {
        ...context.facts,
        assertCurrent: () => {},
      });
      onTestFinished(release);
    }
    mockSessionDiscovery((request) => {
      if (request.method === "sessions.resolve") {
        return { key: request.params?.key };
      }
      if (request.method === "chat.history") {
        return { messages: [{ role: "user", content: "Synthetic learning evidence" }] };
      }
      return undefined;
    });
    const options = { operationalRunInstance };
    const call = createToolCaller(
      {
        agents: { entries: { main: {}, research: {} } },
        tools: { agentToAgent: { enabled: true, allow: ["*"] } },
      },
      { ...options, runId, runSessionKey, scheduledToolTargets: readScheduledToolTargets(options) },
    );

    await expect(call("sessions_list", { archived: "all" })).resolves.toMatchObject({
      details: { count: 1, sessions: [{ agentId: "research" }] },
    });
    expectGateway("sessions.list", { agentId: "research" });
    await expectForbidden(call, "sessions_history", { sessionKey: "agent:main:main" });
    expect(
      embeddedGatewayCalls.mock.calls.some(([request]) => request.method === "chat.history"),
    ).toBe(false);
    await expect(
      call("sessions_history", { sessionKey: "agent:research:main" }),
    ).resolves.toMatchObject({
      details: { messages: [{ content: "Synthetic learning evidence" }] },
    });
    await expectForbidden(call, "sessions_search", { query: "Synthetic learning evidence" });
    expect(
      embeddedGatewayCalls.mock.calls.some(([request]) => request.method === "sessions.search"),
    ).toBe(false);
  },
);

afterEach(() => {
  vi.restoreAllMocks();
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
    ["runtime", true],
    ["pinned", false],
  ] as const)(
    "uses %s spawn capabilities over a conflicting pinned config",
    async (source, available) => {
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
          matrix: { accounts: { work: { threadBindings: { spawnSessions: enabled } } } },
        },
      });
      setRuntimeConfigSnapshot(capabilityConfig(true));
      const tools = createOpenClawTools({
        agentSessionKey: "agent:main:matrix:channel:!room:example.org",
        agentChannel: "matrix",
        agentAccountId: "work",
        config: capabilityConfig(false),
        sessionConfigSource: source,
        disablePluginTools: true,
        wrapBeforeToolCallHook: false,
      });
      const tool = requireTool(tools, "sessions_spawn");

      expect(tools.some((candidate) => candidate.name === "agents_wait")).toBe(available);
      expect(tool.parameters).toMatchObject({
        properties: {
          mode: { enum: available ? ["run", "session"] : ["run"] },
          runtime: { enum: available ? ["subagent", "acp"] : ["subagent"] },
        },
      });
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

  it("routes progress cards to global under global scope", async () => {
    const gatewayCall = vi.spyOn(inProcessGateway, "callInProcessGatewayTool").mockResolvedValue({
      card: null,
    });
    const call = createToolCaller(
      {
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
        session: { scope: "global", mainKey: "main" },
      },
      {
        agentSessionKey: "agent:research:main",
        runSessionKey: "global",
        requesterAgentIdOverride: "research",
        disableMessageTool: true,
      },
    );

    await call("progress_card");

    expect(gatewayCall).toHaveBeenCalledWith("progressCard.put", {
      sessionKey: "global",
      agentId: "research",
    });
  });

  it("binds nested session lookups to the durable caller", async () => {
    setEmbeddedMode(true);
    const call = createToolCaller(
      { agents: { entries: { main: {}, research: {} } } },
      { sandboxed: true },
    );

    await call("sessions_list");
    await call("sessions_search", { query: "needle" });
    await call("sessions_history", { sessionKey: "current" });

    expect(createEmbeddedCallGatewayMock).toHaveBeenCalledWith();
    expectGateway("sessions.list", { spawnedBy: "agent:research:main" });
    expectGateway("sessions.search", {
      recall: expect.objectContaining({
        requesterAgentId: "research",
        requesterSessionKey: "agent:research:main",
        sandboxed: true,
      }),
    });
    expectGateway("chat.history", { sessionKey: "agent:research:main" });
  });

  it("preserves all-agent discovery and applies live visibility grants and revocations", async () => {
    const accessibleConfig = sessionPolicyConfig();
    const restrictedConfig = sessionPolicyConfig("self");
    mockSessionDiscovery((request) => {
      if (request.method === "chat.history") {
        return { messages: [{ role: "user", content: "private history" }] };
      }
      if (request.method === "sessions.search") {
        return {
          results: ["main", "research"].map((agentId) => ({
            sessionKey: `agent:${agentId}:main`,
            timestamp: 1,
            role: "user",
            snippet: `${agentId} hit`,
            score: 1,
          })),
        };
      }
      return undefined;
    });
    const discovery = createToolCaller(accessibleConfig);

    const listed = await discovery("sessions_list");
    const searched = await discovery("sessions_search", { query: "hit" });

    expect(listed.details).toMatchObject({ sessions: agentRows("main", "research") });
    expect(searched.details).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ snippet: "main hit" }),
        expect.objectContaining({ snippet: "research hit" }),
      ]),
    });
    const discoveryRequests = embeddedGatewayCalls.mock.calls
      .map(([request]) => request as GatewayRequest)
      .filter((request) => request.method === "sessions.list");
    expect(discoveryRequests).not.toHaveLength(0);
    expect(discoveryRequests.some((request) => request.params?.agentId === undefined)).toBe(true);
    setRuntimeConfigSnapshot(accessibleConfig);
    const call = createToolCaller(accessibleConfig, { sessionConfigSource: "runtime" });
    setEmbeddedMode(false);
    const send = createToolCaller(accessibleConfig, { sessionConfigSource: "runtime" });
    setEmbeddedMode(true);

    const granted = await call("sessions_list");
    expect(granted.details).toMatchObject({ sessions: agentRows("main") });

    setRuntimeConfigSnapshot(restrictedConfig);
    await expectForbidden(send, "sessions_send", {
      agentId: "main",
      label: "private",
      message: "should never be delivered",
    });
    const revoked = await call("sessions_list");
    expect(revoked.details).toMatchObject({
      sessions: [expect.objectContaining({ agentId: "research" })],
    });
    await expectForbidden(call, "sessions_history", { sessionKey: "agent:main:main" });
    await expectForbidden(call, "sessions_search", {
      query: "private",
      sessionKey: "agent:main:main",
    });
    setRuntimeConfigSnapshot(accessibleConfig);
    const restored = await call("sessions_list");
    expect(restored.details).toMatchObject({ sessions: agentRows("main") });
  });
});
