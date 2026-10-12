import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearSessionStoreCacheForTest,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { withCodexAppServerJsonClient } from "./app-server/request.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexControlRequest,
  prepareCodexControlSessionAuth,
  type CodexControlRequestOptions,
} from "./command-rpc.js";

const requestCodexAppServerJsonMock = vi.hoisted(() => vi.fn());
const withCodexAppServerJsonClientMock = vi.hoisted(() => vi.fn());

vi.mock("./app-server/request.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-server/request.js")>()),
  requestCodexAppServerJson: requestCodexAppServerJsonMock,
  withCodexAppServerJsonClient: withCodexAppServerJsonClientMock,
}));

describe("Codex command RPC helpers", () => {
  let tempDir: string;
  let agentDir: string;
  let config: OpenClawConfig;
  let harness: ReturnType<typeof createClientHarness>;
  let previousPluginRegistry: ReturnType<typeof getActivePluginRegistry>;
  const sessionKey = "agent:main:control";
  const resumeResponse = {
    thread: {
      id: "thread-1",
      sessionId: "session-1",
      projectId: null,
      cliVersion: "0.150.1",
      createdAt: 1,
      updatedAt: 1,
      cwd: "/repo",
      ephemeral: false,
      modelProvider: "openai",
      preview: "",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
    },
    model: "gpt-5.5",
    modelProvider: "openai",
    cwd: "/repo",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
  };

  beforeEach(async () => {
    previousPluginRegistry = getActivePluginRegistry();
    const registry = createEmptyPluginRegistry();
    // Provide the provider hook contract; source discovery is outside this control-auth fixture.
    registry.providers.push({
      pluginId: "openai",
      provider: { id: "openai", label: "OpenAI", auth: [] },
      source: "test",
    });
    setActivePluginRegistry(registry);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-control-auth-"));
    agentDir = path.join(tempDir, "agents", "main", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("CODEX_API_KEY", undefined);
    config = { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } };
    setAuthStore({ version: 1, profiles: {} });
    harness = createClientHarness();
    requestCodexAppServerJsonMock.mockReset();
    requestCodexAppServerJsonMock.mockResolvedValue(resumeResponse);
    withCodexAppServerJsonClientMock.mockReset();
    withCodexAppServerJsonClientMock.mockImplementation(
      async (
        _options: Parameters<typeof withCodexAppServerJsonClient>[0],
        run: Parameters<typeof withCodexAppServerJsonClient>[1],
      ) =>
        await run(requestCodexAppServerJsonMock, harness.client, {
          assertCurrent: () => undefined,
          abort: vi.fn(),
        }),
    );
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      entry: { sessionId: "session-1", updatedAt: Date.now() },
    });
  });

  afterEach(async () => {
    if (previousPluginRegistry) {
      setActivePluginRegistry(previousPluginRegistry);
    } else {
      resetPluginRuntimeStateForTest();
    }
    harness.client.close();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    clearRuntimeAuthProfileStoreSnapshots();
    clearSessionStoreCacheForTest();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function setAuthStore(store: AuthProfileStore) {
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
  }

  function resume(options: Partial<CodexControlRequestOptions> = {}) {
    return codexControlRequest(
      {},
      "thread/resume",
      { threadId: "thread-1" },
      {
        config,
        agentDir,
        sessionKey,
        sessionId: "session-1",
        onResponse: vi.fn(),
        ...options,
      },
    );
  }

  function acquiredOptions() {
    return withCodexAppServerJsonClientMock.mock.calls[0]?.[0] as Parameters<
      typeof withCodexAppServerJsonClient
    >[0];
  }

  it.each(["before-write", "after-write"] as const)(
    "checks owner before dispatch and preserves accepted settlement after revocation at %s",
    async (revokeAt) => {
      let ownerCurrent = true;
      let writes = 0;
      let settled = false;
      requestCodexAppServerJsonMock.mockImplementationOnce(
        async (request: { assertCurrent?: () => void }) => {
          request.assertCurrent?.();
          writes += 1;
          ownerCurrent = false;
          return resumeResponse;
        },
      );
      const result = codexControlRequest(
        {},
        "thread/fork",
        { threadId: "source-thread", excludeTurns: true },
        {
          startOptions: {
            transport: "stdio",
            homeScope: "user",
            command: "codex",
            args: ["app-server"],
            headers: {},
          },
          authProfileId: null,
          assertOwnerCurrent: () => {
            if (!ownerCurrent) {
              throw new Error("Command owner was revoked");
            }
          },
          beforeRequest: async () => {
            if (revokeAt === "before-write") {
              ownerCurrent = false;
            }
          },
          onResponse: async (_response, _client, authority) => {
            authority.assertCurrent();
            settled = true;
          },
        },
      );
      if (revokeAt === "before-write") {
        await expect(result).rejects.toThrow("Command owner was revoked");
        expect({ writes, settled }).toEqual({ writes: 0, settled: false });
      } else {
        await expect(result).resolves.toEqual(resumeResponse);
        expect({ writes, settled }).toEqual({ writes: 1, settled: true });
      }
    },
  );

  it("keeps plugin reads without an admitted session on the selected auth partition", async () => {
    const options = { config, authProfileId: "openai:selected" };
    const startOptions = { transport: "stdio" as const, command: "codex", args: [], headers: {} };
    await expect(prepareCodexControlSessionAuth(options, startOptions)).resolves.toEqual({
      authProfileId: "openai:selected",
      clientOptions: { authProfileId: "openai:selected" },
    });
    await expect(
      prepareCodexControlSessionAuth({ ...options, onResponse: vi.fn() }, startOptions),
    ).rejects.toThrow("requires admitted session authority");
    expect(withCodexAppServerJsonClientMock).not.toHaveBeenCalled();
    expect(requestCodexAppServerJsonMock).not.toHaveBeenCalled();
  });

  it("requires session authority for thread/resume without its native fork selection", async () => {
    await expect(
      codexControlRequest(
        {},
        "thread/resume",
        { threadId: "source-thread" },
        {
          startOptions: {
            transport: "stdio" as const,
            homeScope: "user" as const,
            command: "codex",
            args: ["app-server"],
            headers: {},
          },
          authProfileId: null,
          onResponse: vi.fn(),
        },
      ),
    ).rejects.toThrow("requires admitted session authority");
    expect(withCodexAppServerJsonClientMock).not.toHaveBeenCalled();
  });

  it("resumes with the prepared environment API key and publishes no legacy profile", async () => {
    vi.stubEnv("OPENAI_API_KEY", "control-platform-key");
    const onResponse = vi.fn();

    await resume({ onResponse });

    expect(acquiredOptions()).toMatchObject({
      preparedAuth: { kind: "api-key", apiKey: "control-platform-key" },
      authRequirement: "api-key",
      agentDir,
    });
    expect(acquiredOptions().authProfileId).toBeUndefined();
    expect(onResponse).toHaveBeenCalledWith(
      expect.objectContaining({ thread: expect.objectContaining({ id: "thread-1" }) }),
      harness.client,
      {
        authProfileId: undefined,
        assertCurrent: expect.any(Function),
      },
    );
  });

  it.each(["oauth", "token"] as const)(
    "keeps %s subscription routing and rotates an automatic profile past cooldown",
    async (type) => {
      vi.stubEnv("OPENAI_API_KEY", "unrelated-platform-key");
      const token = `e30.${Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "control-account" },
        }),
      ).toString("base64url")}.test-signature`;
      const credential =
        type === "oauth"
          ? {
              type,
              provider: "openai",
              access: token,
              refresh: "control-refresh",
              expires: Date.now() + 3_600_000,
              accountId: "control-account",
            }
          : { type, provider: "openai", token };
      setAuthStore({
        version: 1,
        profiles: { "openai:old": credential, "openai:ready": credential },
        order: { openai: ["openai:old", "openai:ready"] },
        usageStats: { "openai:old": { cooldownUntil: Date.now() + 60_000 } },
      });
      await upsertSessionEntry({
        agentId: "main",
        sessionKey,
        entry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          authProfileOverride: "openai:old",
          authProfileOverrideSource: "auto",
        },
      });
      const onResponse = vi.fn();

      await resume({ authProfileId: "openai:old", onResponse });

      expect(acquiredOptions()).toMatchObject({
        authRequirement: "subscription",
        preparedAuth: {
          kind: "profile",
          profileId: "openai:ready",
          snapshot: { loginParams: { type: "chatgptAuthTokens", accessToken: token } },
        },
      });
      expect(acquiredOptions().authProfileId).toBeUndefined();
      expect(acquiredOptions().authBindingFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(onResponse).toHaveBeenCalledWith(expect.anything(), harness.client, {
        authProfileId: "openai:ready",
        assertCurrent: expect.any(Function),
      });
    },
  );

  it("honors the user-pinned API profile from the admitted explicit store", async () => {
    vi.stubEnv("OPENAI_API_KEY", "unrelated-platform-key");
    const explicitStorePath = path.join(tempDir, "explicit", "sessions.json");
    const configuredStorePath = path.join(tempDir, "configured", "sessions.json");
    config.session = { store: configuredStorePath };
    setAuthStore({
      version: 1,
      profiles: {
        "openai:first": { type: "api_key", provider: "openai", key: "automatic-key" },
        "openai:pinned": { type: "api_key", provider: "openai", key: "pinned-key" },
      },
      order: { openai: ["openai:first", "openai:pinned"] },
    });
    await upsertSessionEntry({
      agentId: "main",
      storePath: explicitStorePath,
      sessionKey,
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        authProfileOverride: "openai:pinned",
        authProfileOverrideSource: "user",
      },
    });
    await upsertSessionEntry({
      agentId: "main",
      storePath: configuredStorePath,
      sessionKey,
      entry: { sessionId: "unrelated-session", updatedAt: Date.now() },
    });

    await resume({ storePath: explicitStorePath, authProfileId: "openai:first" });

    expect(acquiredOptions()).toMatchObject({
      authRequirement: "api-key",
      preparedAuth: { kind: "api-key", apiKey: "pinned-key" },
    });
  });

  it("rejects a mismatched admitted row before auth or client acquisition", async () => {
    const storePath = path.join(tempDir, "authority-mismatched", "sessions.json");
    await upsertSessionEntry({
      agentId: "main",
      storePath,
      sessionKey,
      entry: { sessionId: "another-session", updatedAt: Date.now() },
    });

    await expect(resume({ storePath })).rejects.toThrow(
      "Codex session generation is no longer current: session-1",
    );

    expect(withCodexAppServerJsonClientMock).not.toHaveBeenCalled();
    expect(requestCodexAppServerJsonMock).not.toHaveBeenCalled();
  });

  it("keeps native-auth control subscriptions outside prepared login", async () => {
    vi.stubEnv("OPENAI_API_KEY", "unrelated-platform-key");

    await resume({ authProfileId: null });

    expect(acquiredOptions().preparedAuth).toBeUndefined();
    expect(acquiredOptions().authRequirement).toBeUndefined();
  });

  it("keeps omitted Unix scope on the explicit user-scoped supervision connection", async () => {
    requestCodexAppServerJsonMock.mockResolvedValue({ data: [] });
    const pluginConfig = {
      appServer: {
        transport: "unix" as const,
        url: "unix:///tmp/codex.sock",
        requestTimeoutMs: 321,
      },
    };
    const startOptions = {
      transport: "unix" as const,
      homeScope: "user" as const,
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      url: "unix:///tmp/codex.sock",
      headers: {},
    };

    await codexControlRequest(
      pluginConfig,
      "thread/list",
      { archived: false },
      {
        startOptions,
        authProfileId: null,
      },
    );

    expect(requestCodexAppServerJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ startOptions, timeoutMs: 321, authProfileId: null }),
    );
  });
});
