import type { AgentHarnessSessionPreparationV1 } from "openclaw/plugin-sdk/codex-mcp-projection";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { prepareCodexMcpAppSession } from "./mcp-app-session-preparation.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";
const thread = { threadId: "native-thread", clientId: "native-client" };
const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  start: vi.fn(),
  bundle: vi.fn(),
  assert: vi.fn(),
  request: vi.fn(),
  ensure: vi.fn(),
  retain: vi.fn(),
  rollback: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  loadCodexBundleMcpThreadConfig: mocks.bundle,
}));
// mock-isolation: Thread preparation supplies a fixed user-MCP patch without live runtime setup.
vi.mock("openclaw/plugin-sdk/codex-mcp-projection", () => ({
  buildCodexUserMcpServersThreadConfigPatchForRuntime: async () => undefined,
}));
vi.mock("./auth-profile.js", () => ({
  resolveCodexAppServerAuthProfileId: () => "prepared-account",
}));
vi.mock("./binding-connection.js", () => ({
  resolveCodexBindingAppServerConnection: async () => ({
    appServer: {
      start: { transport: "stdio", args: [] },
      connectionClass: "local",
      requestTimeoutMs: 1000,
    },
  }),
}));
vi.mock("./config-exec-approvals.js", () => ({
  resolveOpenClawExecPolicyForCodexAppServer: () => ({}),
}));
vi.mock("./config-requirements.js", () => ({ readCodexRequirementsToml: () => undefined }));
// mock-isolation: Native-thread handoff uses a fixed policy; approval database I/O is outside this fixture.
vi.mock("openclaw/plugin-sdk/exec-approvals-runtime", () => ({
  loadExecApprovalsReadOnlyAsync: async () => ({}),
}));
vi.mock("./client-runtime.js", () => ({ ensureCodexAppServerClientRuntime: mocks.ensure }));
vi.mock("./plugin-app-cache-key.js", () => ({
  buildCodexPluginAppCacheKey: () => "account-cache",
  buildCodexAppServerRuntimeFingerprint: () => "native-owner",
}));
vi.mock("./session-permission-policy.js", () => ({
  applyCodexSessionPermissionPolicy: ({ appServer }: { appServer: object }) => appServer,
}));
vi.mock("./shared-client.js", () => ({
  getLeasedSharedCodexAppServerClient: mocks.acquire,
  releaseLeasedSharedCodexAppServerClient: mocks.release,
}));
// mock-isolation: Lifecycle imports evaluate binding fingerprints outside this fixture's stubbed binding contract.
vi.mock("./thread-lifecycle-run.js", () => ({ startOrResumeThread: mocks.start }));
vi.mock("./session-binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-binding.js")>()),
  sessionBindingIdentity: () => ({ sessionId: "session" }),
  resolveCodexSessionBinding: async () => ({
    binding: undefined,
    authority: { assertLegacyCurrent: mocks.assert },
    release: vi.fn(),
  }),
}));
vi.mock("./thread-ownership.js", () => ({
  isSameCodexAppServerThreadOwner: () => true,
  retainCodexAppServerBindingSubscription: mocks.retain,
  rollbackCodexAppServerBindingSubscription: mocks.rollback,
}));
function fixture() {
  const preparation: AgentHarnessSessionPreparationV1 = {
    version: 1,
    purpose: "mcp-app",
    params: {
      sessionId: "session",
      sessionKey: "agent:main:app",
      runId: "session-preparation",
      workspaceDir: "/workspace",
      config: {},
      agentId: "main",
      agentDir: "/agent",
      provider: "openai",
      modelId: "model",
      authProfileStore: { version: 1, profiles: {} },
      hostCapabilities: createCodexTestHostCapabilities({
        assertActive: mocks.assert,
        preparedEnvironment: () => ({
          credentialScrubEnv: {},
          localIdentityEnv: {},
          managedLocalIdentity: false,
          localGitConfigParameters: "'maintenance.auto=false' 'gc.auto=0'",
        }),
        retainSourceAuthority: () => ({
          assertCurrent: mocks.assert,
          release: vi.fn(),
          modelPolicyRequired: true,
        }),
      }),
    },
    run: async (operation) => operation(),
  };
  const read = () => (mocks.start.mock.calls.length > 0 ? thread : undefined);
  return {
    preparation,
    bindingStore: {
      read,
      readAsync: async () => read(),
      withLease: async (_identity: unknown, operation: () => Promise<unknown>) => operation(),
    } as unknown as CodexAppServerBindingStore,
    assertCurrent: mocks.assert,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.assert.mockReset();
  mocks.acquire.mockResolvedValue({
    request: mocks.request,
    getServerVersion: () => "1",
    getRuntimeIdentity: () => undefined,
  });
  mocks.bundle.mockResolvedValue({
    configPatch: { mcp_servers: { demo: { command: "fixture" } } },
  });
  mocks.retain.mockResolvedValue(true);
  mocks.start.mockResolvedValue(thread);
});
afterEach(() => expect(mocks.release).toHaveBeenCalledOnce());
describe("cold native MCP App session preparation", () => {
  it("uses the existing client and thread lifecycle without sending a model turn", async () => {
    const fixtureParams = fixture();
    await expect(prepareCodexMcpAppSession(fixtureParams)).resolves.toMatchObject(thread);
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.start.mock.calls).toMatchObject([
      [
        {
          bindingStore: fixtureParams.bindingStore,
          params: {
            hostCapabilities: fixtureParams.preparation.params.hostCapabilities,
          },
          userMcpServersEnabled: false,
          nativeModelAdmission: "required",
          shellGitConfigParameters: "'maintenance.auto=false' 'gc.auto=0'",
          dynamicTools: [],
        },
      ],
    ]);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.retain).toHaveBeenCalledOnce();
    expect(mocks.rollback).not.toHaveBeenCalled();
  });
  it("rolls back an unretained cold subscription", async () => {
    mocks.retain.mockResolvedValue(false);
    await expect(prepareCodexMcpAppSession(fixture())).rejects.toThrow("ownership changed");
    expect(mocks.rollback).toHaveBeenCalledWith(expect.anything(), "native-thread", false);
  });
  it.each(["non-JSON configuration", "revoked authority"])(
    "rejects %s before thread admission",
    async (failure) => {
      mocks.bundle.mockImplementation(async () => {
        if (failure === "non-JSON configuration") {
          return { configPatch: { mcp_servers: { demo: { command: () => "invalid" } } } };
        }
        mocks.assert.mockImplementation(() => {
          throw new Error("revoked");
        });
        return {};
      });
      await expect(prepareCodexMcpAppSession(fixture())).rejects.toThrow(
        failure === "revoked authority" ? "revoked" : undefined,
      );
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );
});
