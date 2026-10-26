import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { executeMcpAppOperation } from "../gateway/mcp-app-operations.js";
import { catalogTool } from "./agent-bundle-mcp-fixture.test-support.js";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { getMcpAppViewLease } from "./mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "./mcp-ui-resource.test-support.js";

const connectConfig = {
  servers: {
    calendar: {
      url: "https://mcp.example/rpc",
      auth: "oauth" as const,
      oauth: { identity: "per-requester" as const },
    },
  },
};
const startAuthorization = vi.hoisted(() => vi.fn());
const readCredentialsStatus = vi.hoisted(() => vi.fn());

const mocks = vi.hoisted(() => {
  const advertised = new Map<string, McpToolCatalog>();
  let resolveImpl:
    | ((params: {
        sessionId: string;
        requesterSenderId?: string | null;
      }) => Promise<SessionMcpRuntime | undefined>)
    | undefined;

  return {
    advertised,
    setResolveImpl(impl?: typeof resolveImpl) {
      resolveImpl = impl;
    },
    acquireRequesterScopedMcpRuntime: vi.fn(
      async (params: { sessionId: string; requesterSenderId?: string | null }) => {
        const runtime = await resolveImpl?.(params);
        return runtime
          ? {
              runtime,
              releaseLease: runtime.acquireLease?.() ?? (() => {}),
              advertisedCatalogConfigFingerprint: runtime.configFingerprint,
            }
          : undefined;
      },
    ),
    acquireSessionMcpRuntime: vi.fn(),
    retireSessionMcpRuntime: vi.fn(async () => true),
    rememberAdvertisedScopedMcpCatalog: vi.fn(
      (handle: { runtime: SessionMcpRuntime }, catalog: McpToolCatalog) => {
        advertised.set(handle.runtime.sessionId, catalog);
      },
    ),
    getAdvertisedScopedMcpCatalog: vi.fn((sessionId: string) => advertised.get(sessionId) ?? null),
    reset() {
      advertised.clear();
      resolveImpl = undefined;
    },
  };
});

vi.mock("./agent-bundle-mcp-manager-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-bundle-mcp-manager-api.js")>();
  return {
    ...actual,
    acquireRequesterScopedMcpRuntime: mocks.acquireRequesterScopedMcpRuntime,
    acquireSessionMcpRuntime: mocks.acquireSessionMcpRuntime,
    retireSessionMcpRuntime: mocks.retireSessionMcpRuntime,
    rememberAdvertisedScopedMcpCatalog: mocks.rememberAdvertisedScopedMcpCatalog,
    getAdvertisedScopedMcpCatalog: mocks.getAdvertisedScopedMcpCatalog,
  };
});

vi.mock("./mcp-oauth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-oauth.js")>();
  return {
    ...actual,
    readMcpOAuthCredentialsStatuses: readCredentialsStatus,
    startMcpOAuthAuthorization: startAuthorization,
  };
});

import {
  materializeRequesterScopedMcpToolsForHarnessRunCore,
  materializeStaticMcpToolsForHarnessRunCore,
} from "./agent-bundle-mcp-harness.js";
import { makeConnectRuntime, makeRuntime } from "./agent-bundle-mcp-harness.test-support.js";

function staticTools(
  sessionId: string,
  options: Partial<Parameters<typeof materializeStaticMcpToolsForHarnessRunCore>[0]> = {},
) {
  return materializeStaticMcpToolsForHarnessRunCore({
    workspaceDir: "/workspace",
    sessionId,
    ...options,
  });
}
function requesterTools(
  sessionId: string,
  options: Partial<Parameters<typeof materializeRequesterScopedMcpToolsForHarnessRunCore>[0]> = {},
) {
  return materializeRequesterScopedMcpToolsForHarnessRunCore({
    workspaceDir: "/workspace",
    sessionId,
    ...options,
  });
}

beforeEach(() => {
  mocks.reset();
  mocks.acquireRequesterScopedMcpRuntime.mockClear();
  mocks.acquireSessionMcpRuntime.mockReset();
  mocks.retireSessionMcpRuntime.mockClear();
  mocks.rememberAdvertisedScopedMcpCatalog.mockClear();
  mocks.getAdvertisedScopedMcpCatalog.mockClear();
  readCredentialsStatus.mockReset().mockResolvedValue([{ state: "unauthenticated" }]);
  startAuthorization.mockReset();
});

function makeStaticRuntime(sessionId: string) {
  const runtime = makeRuntime({ sessionId, requesterSenderId: "unused" });
  delete runtime.requesterScope;
  mocks.acquireSessionMcpRuntime.mockResolvedValue({
    runtime,
    releaseLease: runtime.acquireLease?.() ?? (() => {}),
  });
  return runtime;
}

function resolveRequesterRuntime() {
  mocks.setResolveImpl(async ({ sessionId, requesterSenderId }) =>
    typeof requesterSenderId === "string" && requesterSenderId
      ? makeRuntime({ sessionId, requesterSenderId })
      : undefined,
  );
}

function fullPermissionTools(sessionId: string, requesterSenderId: string) {
  return requesterTools(sessionId, { requesterSenderId, autoApproveCodexAppServerApprovals: true });
}

const heartbeatPolicy = {
  config: { agents: { entries: { demo: {} } } },
  agentId: "demo",
  sessionKey: "agent:demo:main:heartbeat",
  groupId: "-1000000000001",
  messageProvider: "telegram",
  modelProvider: "openai",
};

function repeatedDisposalFixture(sessionId: string) {
  const runtime = makeRuntime({ sessionId, requesterSenderId: "alice" });
  const releaseLease = vi.fn(runtime.acquireLease!());
  runtime.acquireLease = () => releaseLease;
  const entered = createDeferred();
  const joinedAgain = createDeferred();
  const cleanup = createDeferred();
  const failure = new Error("native cleanup failed");
  runtime.joinCleanup = vi
    .fn(() => {
      joinedAgain.resolve();
      return cleanup.promise;
    })
    .mockImplementationOnce(() => {
      entered.resolve();
      return cleanup.promise;
    });
  return { runtime, releaseLease, entered, joinedAgain, cleanup, failure };
}

async function expectRepeatedDisposal(
  fixture: ReturnType<typeof repeatedDisposalFixture>,
  tools: { dispose: () => Promise<void> },
  retirementCalls: number,
) {
  const { runtime, releaseLease, entered, joinedAgain, cleanup, failure } = fixture;
  const first = tools.dispose();
  await entered.promise;
  const second = tools.dispose();
  const settled = Promise.allSettled([first, second]);
  try {
    await awaitGateBeforeSettlement(
      joinedAgain.promise,
      second,
      "Repeated harness disposal returned before joining native cleanup",
    );
    expect(runtime.activeLeases).toBe(0);
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(mocks.retireSessionMcpRuntime).toHaveBeenCalledTimes(retirementCalls);
  } finally {
    cleanup.reject(failure);
    await settled;
  }
  expect(await settled).toEqual([
    { status: "rejected", reason: failure },
    { status: "rejected", reason: failure },
  ]);
}

it("joins captured cleanup and reports its failure to repeated static harness disposals", async () => {
  const fixture = repeatedDisposalFixture("repeat-dispose-static");
  delete fixture.runtime.requesterScope;
  mocks.acquireSessionMcpRuntime.mockResolvedValue({
    runtime: fixture.runtime,
    releaseLease: fixture.releaseLease,
  });
  const tools = await staticTools("repeat-dispose-static", {
    retireSessionRuntimeAfterDispose: true,
  });
  await expectRepeatedDisposal(fixture, tools, 1);
});

it("joins captured cleanup and reports its failure to repeated requester harness disposals", async () => {
  const fixture = repeatedDisposalFixture("repeat-dispose-requester");
  mocks.setResolveImpl(async () => fixture.runtime);
  const tools = (await requesterTools("repeat-dispose-requester", { requesterSenderId: "alice" }))!;
  await expectRepeatedDisposal(fixture, tools, 0);
});

describe("materializeStaticMcpToolsForHarnessRunCore", () => {
  it.each(["none", "release", "join"] as const)(
    "retires a failed snapshot once when cleanup failure is %s",
    async (cleanupFailure) => {
      const runtime = makeRuntime({ sessionId: "failed-snapshot", requesterSenderId: "unused" });
      delete runtime.requesterScope;
      const failure = new Error("catalog unavailable");
      runtime.getCatalog = async () => {
        throw failure;
      };
      const release = runtime.acquireLease?.();
      const releaseLease = vi.fn(() => {
        release?.();
        if (cleanupFailure === "release") {
          throw new Error("lease release failed");
        }
      });
      runtime.joinCleanup = vi.fn(async () => {
        if (cleanupFailure === "join") {
          throw new Error("cleanup join failed");
        }
      });
      mocks.acquireSessionMcpRuntime.mockResolvedValue({ runtime, releaseLease });

      await expect(
        staticTools("failed-snapshot", { retireSessionRuntimeAfterDispose: true }),
      ).rejects.toBe(failure);
      expect(releaseLease).toHaveBeenCalledOnce();
      expect(runtime.activeLeases).toBe(0);
      expect(runtime.joinCleanup).toHaveBeenCalledOnce();
      expect(mocks.retireSessionMcpRuntime).toHaveBeenCalledExactlyOnceWith({
        sessionId: "failed-snapshot",
        reason: "scheduled-authority-snapshot-complete",
      });
    },
  );

  it("never widens a finite scheduled cap", async () => {
    makeStaticRuntime("scheduled-denied");

    const result = await staticTools("scheduled-denied", { toolsAllow: ["read"] });

    expect(result?.tools).toEqual([]);
    await result?.dispose();
  });

  it("gates interactive configured MCP before the original executor", async () => {
    const runtime = makeStaticRuntime("interactive");
    const callTool = vi.spyOn(runtime, "callTool");
    let active: (() => boolean) | undefined;
    const requestInteractiveCodexApproval = vi.fn(async (request) => {
      active = request.isActive;
      if (request.toolCallId === "denied") {
        throw new Error("operator denied");
      }
    });

    const result = await staticTools("interactive", {
      toolsAllow: ["user-mail__inbox"],
      requestInteractiveCodexApproval,
    });
    const tool = result.tools[0]!;

    await expect(tool.execute("denied", { folder: "private" })).rejects.toThrow("operator denied");
    expect(callTool).not.toHaveBeenCalled();

    await expect(tool.execute("allowed", { folder: "team" })).resolves.toBeDefined();
    expect(callTool).toHaveBeenCalledExactlyOnceWith("user-mail", "inbox", { folder: "team" });
    expect(requestInteractiveCodexApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({
        safeToolName: "user-mail__inbox",
        toolCallId: "allowed",
        serverName: "user-mail",
        toolName: "inbox",
        mode: "auto",
      }),
    );
    expect(active?.()).toBe(false);
    await result.dispose();
  });

  it.each([
    { name: "explicit prompt", mode: "prompt" as const, grant: false, approvalCalls: 1 },
    { name: "durable grant", mode: "auto" as const, grant: true, approvalCalls: 0 },
  ])("preserves $name on the interactive surface", async ({ mode, grant, approvalCalls }) => {
    const runtime = makeStaticRuntime("interactive-policy");
    runtime.peekCatalog()!.servers["user-mail"]!.codexApprovalMode = mode;
    const requestInteractiveCodexApproval = vi.fn(async () => undefined);

    const result = await staticTools("interactive-policy", {
      toolsAllow: ["user-mail__inbox"],
      autoApproveCodexAppServerApprovals: true,
      projectedMcpServers: grant
        ? { "user-mail": { tools: { inbox: { approval_mode: "approve" } } } }
        : undefined,
      requestInteractiveCodexApproval,
    });
    await expect(result.tools[0]!.execute("call", {})).resolves.toBeDefined();
    expect(requestInteractiveCodexApproval).toHaveBeenCalledTimes(approvalCalls);
    await result.dispose();
  });

  it("excludes unsafe auto app tools while allowing read-only app calls", async () => {
    const runtime = makeStaticRuntime("scheduled-app-approval");
    runtime.sessionKey = "agent:main:main";
    const catalog = runtime.peekCatalog()!;
    catalog.servers["user-mail"]!.toolCount = 3;
    catalog.servers["user-mail"]!.codexApprovalMode = "auto";
    catalog.tools = [
      catalogTool("user-mail", "show", {
        uiResourceUri: "ui://user-mail/app",
        codexAnnotations: { readOnlyHint: true },
      }),
      catalogTool("user-mail", "safe-app", {
        uiVisibility: ["app"],
        codexAnnotations: { readOnlyHint: true },
      }),
      catalogTool("user-mail", "unsafe-app", { uiVisibility: ["app"] }),
    ];
    runtime.mcpAppsEnabled = true;
    runtime.readResource = async () => ({
      contents: [
        {
          uri: "ui://user-mail/app",
          mimeType: "text/html;profile=mcp-app",
          text: "<html>mail</html>",
        },
      ],
    });
    const callTool = vi.spyOn(runtime, "callTool");
    const requestInteractiveCodexApproval = vi.fn(async () => undefined);

    const result = await staticTools("scheduled-app-approval", {
      sessionKey: "agent:main:main",
      agentId: "main",
      toolsAllow: ["*"],
      requestInteractiveCodexApproval,
    });
    const callResult = await result.tools[0]!.execute("call-app", {});
    const viewId = (callResult.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } })
      .mcpAppPreview?.mcpApp?.viewId;
    const view = getMcpAppViewLease(viewId!, runtime)!;
    expect(view.allowedAppToolNames).toEqual(new Set(["safe-app", "show"]));

    await expect(
      executeMcpAppOperation(
        { runtime, view },
        { method: "tools/call", params: { name: "unsafe-app", arguments: {} } },
      ),
    ).rejects.toThrow('MCP tool "unsafe-app" is not app-callable');
    expect(callTool).toHaveBeenCalledTimes(1);
    await expect(
      executeMcpAppOperation(
        { runtime, view },
        { method: "tools/call", params: { name: "safe-app", arguments: {} } },
      ),
    ).resolves.toBeDefined();
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(requestInteractiveCodexApproval).not.toHaveBeenCalled();
    await result.dispose();
  });

  it("returns a bounded operator-visible notice for failed configured MCP discovery", async () => {
    const runtime = makeStaticRuntime("scheduled-diagnostic");
    const failedCatalog = {
      ...runtime.peekCatalog()!,
      servers: {},
      tools: [],
      diagnostics: [
        {
          serverName: "user-mail",
          safeServerName: "user-mail",
          launchSummary: "user-mail",
          message: "authentication required",
        },
      ],
    };
    runtime.peekCatalog = () => failedCatalog;
    runtime.getCatalog = async () => failedCatalog;

    const result = await staticTools("scheduled-diagnostic", { toolsAllow: ["*"] });

    expect(result.diagnosticNotice).toContain("user-mail: authentication required");
    expect(result.diagnosticNotice).toContain("Do not claim MCP-backed work succeeded");
    await result.dispose();
  });

  it.each([false, true])(
    "reports actual heartbeat omissions, not warnings (deny: %s)",
    async (deny) => {
      makeStaticRuntime("scheduled-group");
      const warnings: string[] = [];
      const result = await staticTools("scheduled-group", {
        toolsAllow: ["user-mail__inbox"],
        autoApproveCodexAppServerApprovals: true,
        policyContext: {
          ...heartbeatPolicy,
          config: {
            ...heartbeatPolicy.config,
            ...(deny ? { tools: { deny: ["user-mail__inbox"] } } : {}),
          },
        },
        warn: (message) => warnings.push(message),
      });
      expect(result.tools.map((tool) => tool.name)).toEqual(deny ? [] : ["user-mail__inbox"]);
      expect(warnings).toContain(
        "effective tool policy: dropping caller-provided groupId that does not match session-derived group context",
      );
      if (deny) {
        expect(result.diagnosticNotice).toContain(
          "Configured MCP is incomplete for this scheduled run",
        );
        expect(result.diagnosticNotice).toContain("1 configured MCP tool(s) omitted by policy");
        expect(result.diagnosticNotice).not.toContain("dropping caller-provided groupId");
      } else {
        expect(result.diagnosticNotice).toBeUndefined();
      }
      await result.dispose();
    },
  );

  it.each(["auto", undefined] as const)(
    "omits scheduled tools with approval mode %s",
    async (mode) => {
      const runtime = makeStaticRuntime("scheduled-approval");
      runtime.peekCatalog()!.servers["user-mail"]!.codexApprovalMode = mode;
      const callTool = vi.spyOn(runtime, "callTool");
      const result = await staticTools("scheduled-approval", {
        toolsAllow: ["user-mail__inbox"],
        autoApproveCodexAppServerApprovals: mode === "auto",
      });
      expect(result.tools).toEqual([]);
      expect(result.diagnosticNotice).toContain("user-mail/inbox");
      expect(result.diagnosticNotice).toContain(
        "openclaw mcp configure user-mail --approval approve",
      );
      expect(callTool).not.toHaveBeenCalled();
      await result.dispose();
    },
  );
});

afterEach(() => {
  mocks.reset();
  mcpUiResourceTesting.clearViewStore();
});

describe("materializeRequesterScopedMcpToolsForHarnessRunCore", () => {
  it("returns undefined before any requester resolves", async () => {
    const result = await requesterTools("session-empty", { requesterSenderId: "guest" });
    expect(result).toBeUndefined();
    expect(mocks.rememberAdvertisedScopedMcpCatalog).not.toHaveBeenCalled();
  });

  it("bootstraps a requester connect tool without starting OAuth during materialization", async () => {
    mocks.setResolveImpl(async (params) =>
      makeConnectRuntime({
        sessionId: params.sessionId,
        requesterSenderId: params.requesterSenderId ?? "alice",
        publicOrigin: "https://gateway.example",
      }),
    );
    startAuthorization.mockResolvedValue({
      status: "redirect",
      authorizationUrl: "https://auth.example/authorize?state=opaque",
    });
    const result = await requesterTools("session-connect", {
      requesterSenderId: "alice",
      messageChannel: "telegram",
      agentAccountId: "bot",
      cfg: { gateway: { publicOrigin: "https://gateway.example" }, mcp: connectConfig },
    });

    expect(result?.tools.map((tool) => tool.name)).toEqual(["calendar__connect"]);
    expect(startAuthorization).not.toHaveBeenCalled();
    const connect = await result!.tools[0]!.execute("connect", {});
    expect(connect.details).toMatchObject({
      mcpConnect: {
        serverName: "calendar",
        authorizationUrl: "https://auth.example/authorize?state=opaque",
      },
    });
    expect(startAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ principal: "requester", serverName: "calendar" }),
      expect.objectContaining({ url: "https://mcp.example/rpc" }),
      { redirectUrl: "https://gateway.example/oauth/mcp/callback" },
    );
    expect(mocks.rememberAdvertisedScopedMcpCatalog).not.toHaveBeenCalled();
    await result!.dispose();
  });

  it("releases the live runtime when pre-return catalog publication fails", async () => {
    const runtime = makeRuntime({ sessionId: "session-cleanup", requesterSenderId: "authed" });
    mocks.setResolveImpl(async () => runtime);
    mocks.rememberAdvertisedScopedMcpCatalog.mockImplementationOnce(() => {
      throw new Error("catalog publication failed");
    });

    await expect(
      requesterTools("session-cleanup", { requesterSenderId: "authed" }),
    ).rejects.toThrow("catalog publication failed");
    expect(runtime.activeLeases).toBe(0);
  });

  it("keeps specs stable across requester isolation, disconnection, and recovery", async () => {
    const specs = (
      tools: NonNullable<Awaited<ReturnType<typeof requesterTools>>>["advertisedTools"],
    ) => tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
    mocks.setResolveImpl(async (params) => {
      const senderId = params.requesterSenderId;
      if (senderId !== "authed" && senderId !== "bob") {
        return undefined;
      }
      return makeRuntime({ sessionId: params.sessionId, requesterSenderId: senderId });
    });

    const authed = await fullPermissionTools("session-stable", "authed");
    const advertisedNames = authed!.advertisedTools.map((tool) => tool.name);
    const advertisedSpecs = specs(authed!.advertisedTools);
    expect(advertisedNames).toEqual(["user-mail__inbox"]);

    const bob = await fullPermissionTools("session-stable", "bob");
    expect(specs(bob!.advertisedTools)).toEqual(advertisedSpecs);
    const live = await authed!.tools[0]!.execute("c1", {});
    expect(live.content[0]).toMatchObject({ type: "text", text: "live:inbox:authed" });
    const bobResult = await bob!.tools[0]!.execute("b", {});
    expect(bobResult.content[0]).toMatchObject({ text: "live:inbox:bob" });
    await bob!.dispose();
    await authed!.dispose();

    const unavailable = makeRuntime({ sessionId: "session-stable", requesterSenderId: "busy" });
    const emptyCatalog = { version: 1, generatedAt: 0, servers: {}, tools: [] };
    unavailable.getCatalog = async () => emptyCatalog;
    unavailable.peekCatalog = () => emptyCatalog;
    const unavailableCall = vi.spyOn(unavailable, "callTool");
    mocks.acquireRequesterScopedMcpRuntime.mockResolvedValueOnce({
      runtime: unavailable,
      releaseLease: unavailable.acquireLease!(),
      advertisedCatalogConfigFingerprint: "",
    });
    const busy = await fullPermissionTools("session-stable", "busy");
    expect(specs(busy!.advertisedTools)).toEqual(advertisedSpecs);
    const unavailableResult = await busy!.tools[0]!.execute("busy-call", {});
    expect(unavailableResult.details).toMatchObject({ status: "error" });
    expect(unavailableCall).not.toHaveBeenCalled();
    await busy!.dispose();
    expect(unavailable.activeLeases).toBe(0);

    const guest = await fullPermissionTools("session-stable", "guest");
    expect(guest!.advertisedTools.map((tool) => tool.name)).toEqual(advertisedNames);
    expect(guest!.tools.map((tool) => tool.name)).toEqual(advertisedNames);

    const notConnected = await guest!.tools[0]!.execute("c2", {});
    expect(notConnected.details).toMatchObject({ status: "error" });
    expect(notConnected.content[0]).toMatchObject({
      text: expect.stringMatching(/has not connected MCP server/i),
    });
    await guest!.dispose();

    const recovered = await fullPermissionTools("session-stable", "authed");
    expect(specs(recovered!.advertisedTools)).toEqual(advertisedSpecs);
    await recovered!.dispose();
  });

  it("removes direct-policy-denied tools from executable and advertised requester catalogs", async () => {
    resolveRequesterRuntime();

    const result = await requesterTools("session-policy", {
      requesterSenderId: "authed",
      autoApproveCodexAppServerApprovals: true,
      policyContext: { conversationToolPolicy: { deny: ["user-mail__inbox"] } },
    });

    expect([result!.tools, result!.advertisedTools]).toEqual([[], []]);
    await result!.dispose();
  });

  it("exempts only trusted OAuth bootstrap tools, not real server tools named connect", async () => {
    const runtime = makeRuntime({
      sessionId: "session-connect-provenance",
      requesterSenderId: "authed",
    });
    const catalog = runtime.peekCatalog()!;
    for (const serverName of ["drive", "auth-hub"]) {
      catalog.servers[serverName] = {
        serverName,
        launchSummary: serverName,
        toolCount: 1,
        codexApprovalMode: "prompt",
      };
      const tool = catalogTool(serverName, "connect");
      if (serverName === "auth-hub") {
        tool.oauthConnectBootstrap = true;
      }
      catalog.tools.push(tool);
    }
    catalog.servers["user-mail"]!.codexApprovalMode = "prompt";
    const callTool = vi.spyOn(runtime, "callTool");
    mocks.setResolveImpl(async () => runtime);

    const failClosed = await requesterTools("session-connect-provenance", {
      requesterSenderId: "authed",
    });
    const names = ["auth-hub__connect", "drive__connect", "user-mail__inbox"];
    expect(failClosed!.tools.map((tool) => tool.name)).toEqual(names);
    expect(failClosed!.advertisedTools.map((tool) => tool.name)).toEqual(names);
    await failClosed!.dispose();

    const requestInteractiveCodexApproval = vi.fn(async (request) => {
      if (request.toolCallId === "denied-connect") {
        throw new Error("operator denied");
      }
    });
    const gated = await requesterTools("session-connect-provenance", {
      requesterSenderId: "authed",
      requestInteractiveCodexApproval,
    });
    const realConnect = gated!.tools.find((tool) => tool.name === "drive__connect");
    await expect(realConnect!.execute("denied-connect", {})).rejects.toThrow("operator denied");
    expect(callTool).not.toHaveBeenCalled();
    await expect(realConnect!.execute("allowed-connect", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "live:connect:authed" }],
    });
    expect(callTool).toHaveBeenCalledWith("drive", "connect", {});
    expect(requestInteractiveCodexApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({ serverName: "drive", toolName: "connect", mode: "prompt" }),
    );
    await gated!.dispose();
  });
});
