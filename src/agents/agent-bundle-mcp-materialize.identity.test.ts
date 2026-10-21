import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMcpAppStandaloneTicket } from "../gateway/mcp-app-standalone.js";
import { fixtureCatalog, fixtureRuntime } from "./agent-bundle-mcp-fixture.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
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
// mock-isolation: This fixture supplies its runtime directly; never consult the process MCP manager.
vi.mock("./agent-bundle-mcp-manager-api.js", () => ({ peekSessionMcpRuntime: vi.fn() }));
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
const catalog = fixtureCatalog("demo", [{ toolName: "show", uiResourceUri: "ui://demo/app" }], 1);
catalog.servers.demo!.launchSummary = "fixture";
function runtime(privateServer: boolean): SessionMcpRuntime {
  return fixtureRuntime(() => catalog, {
    sessionKey: "agent:main:channel",
    createdAt: 1,
    lastUsedAt: 1,
    mcpAppsEnabled: true,
    requesterScope: { requesterSenderId: "483148469960310784", messageChannel: "discord" },
    isRequesterScopedServer: () => privateServer,
    peekCatalog: () => catalog,
    markUsed: () => {},
    callTool: async () => ({ content: [] }),
    acquireLease: () => () => {},
    joinCleanup: async () => {},
  });
}
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(1);
  mocks.fetch.mockImplementation(async (params) => ({
    ...params,
    viewId: "view",
    sessionId: "session",
    expiresAtMs: 10000,
  }));
});
async function execute(
  runtimeValue: SessionMcpRuntime,
  profile?: string,
  run?: (tools: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>>) => Promise<void>,
) {
  const tools = await materializeBundleMcpToolsForRun({
    runtime: runtimeValue,
    agentId: "main",
    ...(profile ? { appRequester: { kind: "gateway-profile" as const, profileId: profile } } : {}),
  });
  try {
    await (run ? run(tools) : tools.tools[0]!.execute("call", {}));
  } finally {
    await tools.dispose();
  }
}
async function standaloneTicket() {
  return createMcpAppStandaloneTicket({
    sessionKey: "agent:main:channel",
    view: await mocks.fetch.mock.results[0]!.value,
    toolOperationsAuthorized: true,
  });
}
it("prepares model-run form previews through current tool approval and preserves its execution guard", async () => {
  const source = runtime(false);
  await execute(source, undefined, async (materialized) => {
    materialized.restrictAppTools?.(materialized.appTools ?? materialized.tools);
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
  });
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

it.each([
  { privateServer: false, profile: undefined, visible: true, standalone: true },
  { privateServer: true, profile: undefined, visible: false, standalone: false },
  { privateServer: true, profile: "verified-profile", visible: true, standalone: false },
])("maps channel App identity: %j", async ({ privateServer, profile, visible, standalone }) => {
  await execute(runtime(privateServer), profile);
  if (!visible) {
    expect(mocks.fetch).not.toHaveBeenCalled();
    return;
  }
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(mocks.fetch.mock.calls[0]![0].requesterId).toBe(profile);
  const ticket = await standaloneTicket();
  if (standalone) {
    expect(ticket).toBeDefined();
  } else {
    expect(ticket).toBeUndefined();
  }
});
