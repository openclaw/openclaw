import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  debug: vi.fn(),
  getLeasedSharedCodexAppServerClient: vi.fn(),
  getSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  embeddedAgentLog: { debug: mocks.debug },
  loadCodexBundleMcpThreadConfig: async () => ({ staticServerNames: [], diagnostics: [] }),
}));

vi.mock("./shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared-client.js")>()),
  getLeasedSharedCodexAppServerClient: mocks.getLeasedSharedCodexAppServerClient,
  getSharedCodexAppServerClient: mocks.getSharedCodexAppServerClient,
}));

vi.mock("./auth-binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-binding.js")>()),
  prepareCodexAppServerAuthBinding: async ({
    authProfileStore,
  }: {
    authProfileStore: unknown;
  }) => ({
    authProfileStore,
    fingerprint: "auth-fingerprint",
  }),
}));

vi.mock("./auth-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-bridge.js")>()),
  resolveCodexAppServerAuthAccountCacheKey: async () => undefined,
}));

vi.mock("./dynamic-tool-build.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dynamic-tool-build.js")>()),
  shouldEnableCodexAppServerNativeToolSurface: () => false,
}));

const { prepareCodexAttemptRuntime } = await import("./run-attempt-runtime.js");

function createInput(params?: {
  attemptClientFactory?: () => Promise<never>;
  clientFactory?: () => Promise<never>;
  runtimeArtifactRequest?: { expected?: { id: string; fingerprint: string } };
}) {
  const runAbortController = new AbortController();
  return {
    params: {
      authProfileStore: { kind: "test-store" },
      config: { agents: { defaults: { workspace: "/tmp/workspace" } } },
      model: { id: "test-model", provider: "openai", input: ["text"] },
      modelId: "test-model",
      provider: "openai",
    },
    appServer: {
      start: { command: "codex", args: ["app-server"] },
      requestTimeoutMs: 12_345,
    },
    agentDir: "/tmp/openclaw-agent",
    sessionAgentId: "main",
    pluginConfig: { appServer: { enabled: true } },
    startupAuthProfileId: "profile-1",
    startupClientAuthProfileId: "profile-1",
    startupAuthRequirement: "subscription",
    assertCurrent: vi.fn(),
    assertLegacyCurrent: vi.fn(),
    attemptClientFactory: params?.attemptClientFactory ?? mocks.getLeasedSharedCodexAppServerClient,
    options: params?.clientFactory ? { clientFactory: params.clientFactory } : {},
    runAbortController,
    runtimeArtifactRequest: params?.runtimeArtifactRequest,
    mutable: {},
    bindingIdentity: { kind: "session", sessionKey: "test-session" },
    preDynamicStartupStages: { mark: vi.fn() },
  } as unknown as Parameters<typeof prepareCodexAttemptRuntime>[0];
}

describe("Codex attempt client prewarm", () => {
  beforeEach(() => {
    mocks.debug.mockReset();
    mocks.getSharedCodexAppServerClient.mockReset();
    mocks.getSharedCodexAppServerClient.mockResolvedValue({});
  });

  it("starts the shared client before the attempt needs its lease", async () => {
    const input = createInput();

    await prepareCodexAttemptRuntime(input);

    expect(mocks.getSharedCodexAppServerClient).toHaveBeenCalledWith({
      assertCurrent: input.assertLegacyCurrent,
      startOptions: { command: "codex", args: ["app-server"] },
      pluginConfig: { appServer: { enabled: true } },
      authProfileId: "profile-1",
      authRequirement: "subscription",
      authProfileStore: { kind: "test-store" },
      authBindingFingerprint: "auth-fingerprint",
      agentDir: "/tmp/openclaw-agent",
      config: { agents: { defaults: { workspace: "/tmp/workspace" } } },
      timeoutMs: 12_345,
      abandonSignal: input.runAbortController.signal,
    });
  });

  it.each([
    ["a custom client factory", { clientFactory: async () => await new Promise<never>(() => {}) }],
    [
      "an alternate attempt client factory",
      { attemptClientFactory: async () => await new Promise<never>(() => {}) },
    ],
    ["runtime artifact capture", { runtimeArtifactRequest: {} }],
  ])("skips %s", async (_label, options) => {
    await prepareCodexAttemptRuntime(createInput(options));

    expect(mocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("leaves failures for the canonical startup path", async () => {
    const error = new Error("cold start failed");
    mocks.getSharedCodexAppServerClient.mockRejectedValue(error);

    await prepareCodexAttemptRuntime(createInput());
    await vi.waitFor(() => {
      expect(mocks.debug).toHaveBeenCalledWith("codex app-server client prewarm failed", { error });
    });
  });
});
