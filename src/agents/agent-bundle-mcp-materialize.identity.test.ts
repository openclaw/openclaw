import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMcpAppStandaloneTicket,
  mcpAppStandaloneTesting,
} from "../gateway/mcp-app-standalone.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import {
  createAgentQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "./harness/host-private-capabilities.js";
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  release: vi.fn(),
  elicitation: vi.fn(),
  form: vi.fn(),
  approve: vi.fn(),
}));
vi.mock("./agent-bundle-mcp-manager-api.js", () => ({
  peekSessionMcpRuntime: vi.fn(),
}));
vi.mock("./agent-bundle-mcp-manager-cleanup.js", () => ({
  releaseSessionMcpRuntime: mocks.release,
}));
vi.mock("./agent-bundle-mcp-requester-connect.js", () => ({
  mergeMcpConnectCatalog: (catalog: unknown) => catalog,
}));
vi.mock("./mcp-client-elicitation.js", () => ({
  createMcpClientElicitationHandler: mocks.elicitation,
  runWithMcpElicitationHandler: async (_handler: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock("../gateway/mcp-app-form-resources.js", () => ({
  createMcpAppFormResourceContext: mocks.form,
}));
vi.mock("./mcp-form-resource-upload.js", () => ({
  prepareMcpAppFormUpload: async () => undefined,
}));
vi.mock("./mcp-ui-resource.js", () => ({
  fetchMcpAppView: mocks.fetch,
  buildMcpAppCanvasPayload: (value: unknown) => value,
  getMcpAppViewLease: vi.fn(),
}));
vi.mock("./mcp-content.js", () => ({
  projectMcpCallToolResult: () => ({ content: [], details: {} }),
  projectMcpGetPromptResult: vi.fn(),
  setMcpCodeModeGuestResult: (value: unknown) => value,
  setMcpCodeModeGuestResultFromAgentResult: (value: unknown) => value,
}));
vi.mock("../gateway/mcp-app-operations.js", () => ({
  prepareModelCreatedAppToolCall: mocks.approve,
  executeMcpAppOperation: vi.fn(),
  parseMcpAppOperation: vi.fn(),
  requireMcpAppInteraction: vi.fn(),
  withMcpAppActiveView: vi.fn(),
}));
vi.mock("../gateway/http-common.js", () => ({
  readJsonBodyOrError: vi.fn(),
  sendJson: vi.fn(),
  watchClientDisconnect: vi.fn(),
}));
vi.mock("../gateway/control-ui-http-utils.js", () => ({ respondPlainText: vi.fn() }));
vi.mock("./mcp-app-sandbox.js", () => ({
  buildMcpAppSandboxPath: vi.fn(),
  resolveMcpAppSandboxPort: vi.fn(),
}));
vi.mock("../logger.js", () => ({ logWarn: vi.fn() }));
const catalog: McpToolCatalog = {
  version: 1,
  generatedAt: 1,
  servers: { demo: { serverName: "demo", launchSummary: "fixture", toolCount: 1 } },
  tools: [
    {
      serverName: "demo",
      safeServerName: "demo",
      toolName: "show",
      inputSchema: { type: "object", properties: {} },
      fallbackDescription: "show",
      uiResourceUri: "ui://demo/app",
    },
  ],
};
function runtime(privateServer: boolean): SessionMcpRuntime {
  return {
    sessionId: "session",
    sessionKey: "agent:main:channel",
    workspaceDir: "/workspace",
    configFingerprint: "fixture",
    createdAt: 1,
    lastUsedAt: 1,
    mcpAppsEnabled: true,
    requesterScope: { requesterSenderId: "483148469960310784", messageChannel: "discord" },
    isRequesterScopedServer: () => privateServer,
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    markUsed: () => {},
    callTool: async () => ({ content: [] }),
    acquireLease: () => () => {},
    dispose: async () => {},
    joinCleanup: async () => {},
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mcpAppStandaloneTesting.clearTickets();
  mocks.fetch.mockImplementation(async (params) => ({
    ...params,
    viewId: "view",
    sessionId: "session",
    expiresAtMs: 10000,
  }));
});
async function execute(runtimeValue: SessionMcpRuntime, profile?: string) {
  const tools = await materializeBundleMcpToolsForRun({
    runtime: runtimeValue,
    agentId: "main",
    ...(profile ? { appRequester: { kind: "gateway-profile" as const, profileId: profile } } : {}),
  });
  try {
    await tools.tools[0]!.execute("call", {});
  } finally {
    await tools.dispose();
  }
}
describe("materialized MCP App identity provenance", () => {
  it("prepares model-run form previews through current tool approval and preserves its execution guard", async () => {
    const source = runtime(false);
    const materialized = await materializeBundleMcpToolsForRun({
      runtime: source,
      agentId: "main",
    });
    materialized.restrictAppTools?.(materialized.appTools ?? materialized.tools);
    try {
      await materialized.tools[0]!.execute("call", {});
      const prepare = mocks.elicitation.mock.calls[0]![0].prepareResourceContext;
      await prepare({ requestId: "form", snapshot: {}, signal: new AbortController().signal });
      const origin = mocks.form.mock.calls[0]![0].origin;
      const action = { options: {}, toolName: "show", input: {}, assertCurrent: vi.fn() };
      mocks.approve.mockRejectedValueOnce(new Error("approval denied"));
      await expect(origin.prepareToolCall(action)).rejects.toThrow("approval denied");
      const guard = vi.fn();
      mocks.approve.mockResolvedValueOnce(guard);
      await expect(origin.prepareToolCall(action)).resolves.toBe(guard);
      expect(mocks.approve).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime: source,
          view: expect.objectContaining({ serverName: "demo", sessionId: "session" }),
        }),
        expect.objectContaining({ ...action, assertCurrent: expect.any(Function) }),
      );
    } finally {
      await materialized.dispose();
    }
  });
  it("keeps a static channel App standalone-mintable instead of treating a sender as a profile", async () => {
    await execute(runtime(false));
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const params = mocks.fetch.mock.calls[0]![0];
    expect(params.requesterId).toBeUndefined();
    const view = await mocks.fetch.mock.results[0]!.value;
    expect(
      createMcpAppStandaloneTicket({
        sessionKey: "agent:main:channel",
        view,
        toolOperationsAuthorized: true,
        nowMs: 1,
      }),
    ).toBeDefined();
  });
  it("uses the admitted question creator profile rather than the transport sender for private Apps", async () => {
    const authority = createAgentQuestionAnswerAuthority({
      sessionKey: "agent:main:channel",
      requesterProfileId: "verified-profile",
      fingerprint: "creator",
      project: () => "creator",
      assertActive: () => {},
    });
    await withAgentQuestionAnswerAuthority(authority, () => execute(runtime(true)));
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ requesterId: "verified-profile" }),
    );
  });

  it("keeps requester-scoped channel views suppressed until a profile owner maps identity", async () => {
    await execute(runtime(true));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("binds an explicitly mapped private view to that profile and refuses standalone downgrade", async () => {
    await execute(runtime(true), "verified-profile");
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ requesterId: "verified-profile" }),
    );
    const view = await mocks.fetch.mock.results[0]!.value;
    expect(
      createMcpAppStandaloneTicket({
        sessionKey: "agent:main:channel",
        view,
        toolOperationsAuthorized: true,
        nowMs: 1,
      }),
    ).toBeUndefined();
  });
});
