/** Behavior tests for harness-facing requester-scoped MCP materialization. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPluginToolMeta } from "../plugins/tools.js";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

const mocks = vi.hoisted(() => {
  type Runtime = SessionMcpRuntime;
  const advertised = new Map<
    string,
    {
      version: number;
      generatedAt: number;
      servers: Record<string, { serverName: string; launchSummary: string; toolCount: number }>;
      tools: Array<{
        serverName: string;
        safeServerName: string;
        toolName: string;
        description: string;
        inputSchema: Record<string, unknown>;
        fallbackDescription: string;
      }>;
    }
  >();
  const runtimes = new Map<string, Runtime>();
  let resolveImpl:
    | ((params: { sessionId: string; requesterSenderId?: string | null }) => Promise<Runtime>)
    | undefined;

  return {
    advertised,
    runtimes,
    setResolveImpl(impl?: typeof resolveImpl) {
      resolveImpl = impl;
    },
    getOrCreateSessionMcpRuntime: vi.fn(
      async (params: { sessionId: string; requesterSenderId?: string | null }) => {
        if (resolveImpl) {
          return resolveImpl(params);
        }
        throw new Error("missing MCP runtime test implementation");
      },
    ),
    getOrCreateRequesterScopedMcpRuntime: vi.fn(
      async (params: { sessionId: string; requesterSenderId?: string | null }) => {
        if (!params.requesterSenderId?.trim()) {
          return undefined;
        }
        if (resolveImpl) {
          return resolveImpl(params);
        }
        throw new Error("missing requester MCP runtime test implementation");
      },
    ),
    rememberAdvertisedScopedMcpCatalog: vi.fn(
      (sessionId: string, catalog: typeof advertised extends Map<string, infer V> ? V : never) => {
        advertised.set(sessionId, catalog);
      },
    ),
    getAdvertisedScopedMcpCatalog: vi.fn((sessionId: string) => advertised.get(sessionId) ?? null),
    reset() {
      advertised.clear();
      runtimes.clear();
      resolveImpl = undefined;
    },
  };
});

vi.mock("./agent-bundle-mcp-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-bundle-mcp-runtime.js")>();
  return {
    ...actual,
    getOrCreateSessionMcpRuntime: mocks.getOrCreateSessionMcpRuntime,
    getOrCreateRequesterScopedMcpRuntime: mocks.getOrCreateRequesterScopedMcpRuntime,
    rememberAdvertisedScopedMcpCatalog: mocks.rememberAdvertisedScopedMcpCatalog,
    getAdvertisedScopedMcpCatalog: mocks.getAdvertisedScopedMcpCatalog,
  };
});

import {
  materializeConfiguredMcpToolsForHarnessRun,
  materializeRequesterScopedMcpToolsForHarnessRun,
} from "./agent-bundle-mcp-harness.js";

function makeRuntime(params: {
  sessionId: string;
  requesterSenderId?: string;
  empty?: boolean;
  appOnly?: boolean;
  utilityOnly?: boolean;
  excludeAllUtilities?: boolean;
}): SessionMcpRuntime {
  const serverName = "user-mail";
  const catalog: McpToolCatalog = {
    version: 1,
    generatedAt: 0,
    servers: {
      [serverName]: {
        serverName,
        safeServerName: serverName,
        launchSummary: serverName,
        toolCount: params.utilityOnly ? 0 : 1,
        ...(params.utilityOnly
          ? {
              resources: { listChanged: false },
              prompts: { listChanged: false },
              ...(params.excludeAllUtilities ? { toolFilter: { exclude: ["*"] } } : {}),
            }
          : {}),
      },
    },
    tools:
      params.empty || params.utilityOnly
        ? []
        : [
            {
              serverName,
              safeServerName: serverName,
              toolName: "inbox",
              description: "read inbox",
              inputSchema: { type: "object", properties: {} },
              fallbackDescription: "read inbox",
              ...(params.appOnly ? { uiVisibility: ["app"] } : {}),
            },
          ],
  };
  let lastUsedAt = Date.now();
  let activeLeases = 0;
  return {
    sessionId: params.sessionId,
    workspaceDir: "/workspace",
    configFingerprint: "fp",
    ...(params.requesterSenderId
      ? { requesterScope: { requesterSenderId: params.requesterSenderId } }
      : {}),
    createdAt: Date.now(),
    get lastUsedAt() {
      return lastUsedAt;
    },
    get activeLeases() {
      return activeLeases;
    },
    acquireLease: () => {
      activeLeases += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        activeLeases -= 1;
      };
    },
    markUsed: () => {
      lastUsedAt = Date.now();
    },
    peekCatalog: () => catalog,
    getCatalog: async () => catalog,
    callTool: async (_server, toolName) => ({
      content: [
        {
          type: "text",
          text: `live:${toolName}:${params.requesterSenderId ?? "static"}`,
        },
      ],
      isError: false,
    }),
    listResources: async () => [],
    readResource: async (_serverName, uri) => ({ contents: [{ uri, text: "memo" }] }),
    listPrompts: async () => [],
    getPrompt: async (_serverName, name) => ({ name, messages: [] }),
    dispose: async () => {},
  };
}

beforeEach(() => {
  mocks.reset();
  mocks.getOrCreateSessionMcpRuntime.mockClear();
  mocks.getOrCreateRequesterScopedMcpRuntime.mockClear();
  mocks.rememberAdvertisedScopedMcpCatalog.mockClear();
  mocks.getAdvertisedScopedMcpCatalog.mockClear();
});

afterEach(() => {
  mocks.reset();
});

describe("materializeRequesterScopedMcpToolsForHarnessRun", () => {
  it("keeps static MCP harness-native and preserves the legacy result surface", async () => {
    mocks.setResolveImpl(async (params) =>
      makeRuntime({
        sessionId: params.sessionId,
        requesterSenderId: params.requesterSenderId ?? undefined,
      }),
    );

    const withoutRequester = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-legacy-static",
      workspaceDir: "/workspace",
    });
    expect(withoutRequester).toBeUndefined();
    expect(mocks.getOrCreateSessionMcpRuntime).not.toHaveBeenCalled();

    const requester = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-legacy-requester",
      workspaceDir: "/workspace",
      requesterSenderId: "alice",
    });
    expect(requester?.tools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
    expect(Object.keys(requester ?? {}).toSorted()).toEqual([
      "advertisedTools",
      "dispose",
      "tools",
    ]);
    const live = await requester!.tools[0]!.execute("legacy", {});
    expect(live.content[0]).toMatchObject({ text: "live:inbox:alice" });
    await requester?.dispose();
  });

  it("preserves requester-scoped utility-only servers", async () => {
    mocks.setResolveImpl(async (params) =>
      makeRuntime({
        sessionId: params.sessionId,
        requesterSenderId: params.requesterSenderId ?? undefined,
        utilityOnly: true,
      }),
    );

    const result = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-legacy-utilities",
      workspaceDir: "/workspace",
      requesterSenderId: "alice",
    });
    expect(result?.advertisedTools.map((tool) => tool.name)).toEqual([
      "user-mail__prompts_get",
      "user-mail__prompts_list",
      "user-mail__resources_list",
      "user-mail__resources_read",
    ]);
    expect(result?.tools.map((tool) => tool.name)).toEqual(
      result?.advertisedTools.map((tool) => tool.name),
    );
    await result?.dispose();
  });
});

describe("materializeConfiguredMcpToolsForHarnessRun", () => {
  it("returns undefined before any requester resolves", async () => {
    mocks.setResolveImpl(async (params) =>
      makeRuntime({ sessionId: params.sessionId, empty: true }),
    );
    const result = await materializeConfiguredMcpToolsForHarnessRun({
      sessionId: "session-empty",
      workspaceDir: "/workspace",
      requesterSenderId: "guest",
    });
    expect(result).toBeUndefined();
    expect(mocks.rememberAdvertisedScopedMcpCatalog).not.toHaveBeenCalled();
  });

  it("materializes static MCP without requester identity and forwards overrides", async () => {
    mocks.setResolveImpl(async (params) => makeRuntime({ sessionId: params.sessionId }));
    const toolOverrides = { mcpServers: { "user-mail": true } };

    const result = await materializeConfiguredMcpToolsForHarnessRun({
      sessionId: "session-static",
      workspaceDir: "/workspace",
      toolOverrides,
    });

    expect(result?.tools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
    expect(getPluginToolMeta(result!.tools[0]!)?.pluginId).toBe("bundle-mcp");
    expect(mocks.getOrCreateSessionMcpRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ toolOverrides }),
    );
    expect(mocks.rememberAdvertisedScopedMcpCatalog).not.toHaveBeenCalled();
    const live = await result!.tools[0]!.execute("static", {});
    expect(live.content[0]).toMatchObject({ text: "live:inbox:static" });
    await result?.dispose();
  });

  it("preserves static resource and prompt utility-only servers", async () => {
    mocks.setResolveImpl(async (params) =>
      makeRuntime({ sessionId: params.sessionId, utilityOnly: true }),
    );

    const result = await materializeConfiguredMcpToolsForHarnessRun({
      sessionId: "session-static-utilities",
      workspaceDir: "/workspace",
    });

    expect(result?.advertisedTools.map((tool) => tool.name)).toEqual([
      "user-mail__prompts_get",
      "user-mail__prompts_list",
      "user-mail__resources_list",
      "user-mail__resources_read",
    ]);
    expect(result?.tools.map((tool) => tool.name)).toEqual(
      result?.advertisedTools.map((tool) => tool.name),
    );
    const listed = await result!.tools
      .find((tool) => tool.name === "user-mail__resources_list")!
      .execute("list", {});
    expect(listed.details).toMatchObject({ mcpServer: "user-mail" });
    await result?.dispose();
  });

  it("drops universally filtered utility-only servers", async () => {
    mocks.setResolveImpl(async (params) =>
      makeRuntime({
        sessionId: params.sessionId,
        utilityOnly: true,
        excludeAllUtilities: true,
      }),
    );

    await expect(
      materializeConfiguredMcpToolsForHarnessRun({
        sessionId: "session-filtered-utilities",
        workspaceDir: "/workspace",
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps advertised specs stable and returns not-connected for unauthed senders", async () => {
    mocks.setResolveImpl(async (params) => {
      const senderId = params.requesterSenderId;
      if (senderId !== "authed") {
        return makeRuntime({ sessionId: params.sessionId, empty: true });
      }
      return makeRuntime({
        sessionId: params.sessionId,
        requesterSenderId: "authed",
      });
    });

    const authed = await materializeConfiguredMcpToolsForHarnessRun({
      sessionId: "session-stable",
      workspaceDir: "/workspace",
      requesterSenderId: "authed",
    });
    expect(authed).toBeDefined();
    const advertisedNames = authed!.advertisedTools.map((tool) => tool.name);
    expect(advertisedNames).toEqual(["user-mail__inbox"]);

    const live = await authed!.tools[0]!.execute("c1", {});
    expect(live.content[0]).toMatchObject({
      type: "text",
      text: "live:inbox:authed",
    });
    await authed!.dispose();

    const guest = await materializeConfiguredMcpToolsForHarnessRun({
      sessionId: "session-stable",
      workspaceDir: "/workspace",
      requesterSenderId: "guest",
    });
    expect(guest).toBeDefined();
    expect(guest!.advertisedTools.map((tool) => tool.name)).toEqual(advertisedNames);
    expect(guest!.tools.map((tool) => tool.name)).toEqual(advertisedNames);

    const notConnected = await guest!.tools[0]!.execute("c2", {});
    expect(notConnected.details).toMatchObject({ status: "error" });
    const text =
      notConnected.content[0] && "text" in notConnected.content[0]
        ? notConnected.content[0].text
        : "";
    expect(text).toMatch(/has not connected MCP server/i);
    await guest!.dispose();
  });

  it("keeps requester utility specs stable with actionable guest stubs", async () => {
    mocks.setResolveImpl(async (params) =>
      params.requesterSenderId === "authed"
        ? makeRuntime({
            sessionId: params.sessionId,
            requesterSenderId: "authed",
            utilityOnly: true,
          })
        : makeRuntime({ sessionId: params.sessionId, empty: true }),
    );

    const authed = await materializeConfiguredMcpToolsForHarnessRun({
      sessionId: "session-utility-stubs",
      workspaceDir: "/workspace",
      requesterSenderId: "authed",
    });
    const advertisedNames = authed!.advertisedTools.map((tool) => tool.name);
    expect(advertisedNames).toEqual([
      "user-mail__prompts_get",
      "user-mail__prompts_list",
      "user-mail__resources_list",
      "user-mail__resources_read",
    ]);
    await authed!.dispose();

    const guest = await materializeConfiguredMcpToolsForHarnessRun({
      sessionId: "session-utility-stubs",
      workspaceDir: "/workspace",
      requesterSenderId: "guest",
    });
    expect(guest?.advertisedTools.map((tool) => tool.name)).toEqual(advertisedNames);
    const notConnected = await guest!.tools
      .find((tool) => tool.name === "user-mail__resources_list")!
      .execute("guest-list", {});
    expect(notConnected.details).toMatchObject({ status: "error" });
    expect(notConnected.content[0]).toMatchObject({
      text: expect.stringMatching(/has not connected MCP server/i),
    });
    await guest!.dispose();
  });

  it("routes authed calls to that sender's runtime only", async () => {
    mocks.setResolveImpl(async (params) => {
      const senderId =
        typeof params.requesterSenderId === "string" ? params.requesterSenderId : undefined;
      if (!senderId) {
        return makeRuntime({ sessionId: params.sessionId, empty: true });
      }
      return makeRuntime({
        sessionId: params.sessionId,
        requesterSenderId: senderId,
      });
    });

    const alice = await materializeConfiguredMcpToolsForHarnessRun({
      sessionId: "session-route",
      workspaceDir: "/workspace",
      requesterSenderId: "alice",
    });
    const bob = await materializeConfiguredMcpToolsForHarnessRun({
      sessionId: "session-route",
      workspaceDir: "/workspace",
      requesterSenderId: "bob",
    });
    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
    expect(alice!.advertisedTools.map((t) => t.name)).toEqual(
      bob!.advertisedTools.map((t) => t.name),
    );

    const aliceResult = await alice!.tools[0]!.execute("a", {});
    const bobResult = await bob!.tools[0]!.execute("b", {});
    expect(aliceResult.content[0]).toMatchObject({ text: "live:inbox:alice" });
    expect(bobResult.content[0]).toMatchObject({ text: "live:inbox:bob" });

    await alice!.dispose();
    await bob!.dispose();
  });

  it("applies the runtime allowlist to app-only MCP policy projections", async () => {
    mocks.setResolveImpl(async (params) =>
      makeRuntime({ sessionId: params.sessionId, appOnly: true }),
    );

    const denied = await materializeConfiguredMcpToolsForHarnessRun({
      sessionId: "session-app-denied",
      workspaceDir: "/workspace",
      toolsAllow: ["group:plugins"],
      policyContext: {
        config: { tools: { deny: ["user-mail__inbox"] } },
        sessionId: "session-app-denied",
        runId: "run-app-denied",
        agentId: "main",
      },
    });
    expect(denied?.tools).toEqual([]);
    expect(denied?.appTools).toEqual([]);
    await denied?.dispose();

    const allowed = await materializeConfiguredMcpToolsForHarnessRun({
      sessionId: "session-app-allowed",
      workspaceDir: "/workspace",
      toolsAllow: ["group:plugins"],
    });
    expect(allowed?.tools).toEqual([]);
    expect(allowed?.appTools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
    await allowed?.dispose();
  });

  it("uses scheduled authority instead of reevaluating sender overlays", async () => {
    mocks.setResolveImpl(async (params) => makeRuntime({ sessionId: params.sessionId }));
    const config = {
      tools: {
        toolsBySender: {
          "*": { deny: ["user-mail__inbox"] },
        },
      },
    };
    const base = {
      workspaceDir: "/workspace",
      cfg: config,
      toolsAllow: ["*"],
      policyContext: {
        config,
        sessionId: "session-sender-policy",
        runId: "run-sender-policy",
        agentId: "main",
        senderId: "guest",
        messageProvider: "discord",
      },
    };

    const ordinary = await materializeConfiguredMcpToolsForHarnessRun({
      ...base,
      sessionId: "session-sender-policy",
    });
    expect(ordinary?.tools).toEqual([]);
    await ordinary?.dispose();

    const scheduled = await materializeConfiguredMcpToolsForHarnessRun({
      ...base,
      sessionId: "session-scheduled-policy",
      policyContext: {
        ...base.policyContext,
        sessionId: "session-scheduled-policy",
        scheduledToolPolicy: { version: 1, mode: "trusted" },
      },
    });
    expect(scheduled?.tools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
    await scheduled?.dispose();
  });
});
