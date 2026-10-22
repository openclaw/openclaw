import path from "node:path";
import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import type { withCodexAppServerJsonClient } from "./app-server/request.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexControlRequest,
  prepareCodexControlSessionAuth,
  type CodexControlRequestOptions,
} from "./command-rpc.js";
import { createThreadResumeResponse, useCodexControlTestState } from "./commands.test-support.js";

const requestMock = vi.hoisted(() => vi.fn());
const clientMock = vi.hoisted(() => vi.fn<typeof withCodexAppServerJsonClient>());

vi.mock("./app-server/request.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-server/request.js")>()),
  requestCodexAppServerJson: requestMock,
  withCodexAppServerJsonClient: clientMock,
}));

describe("Codex command RPC helpers", () => {
  let tempDir: string;
  let agentDir: string;
  let config: OpenClawConfig;
  let harness: ReturnType<typeof createClientHarness>;
  const sessionKey = "agent:main:control";
  const startOptions = {
    transport: "stdio" as const,
    homeScope: "user" as const,
    command: "codex",
    args: ["app-server"],
    headers: {},
  };
  const expectedAuthority = {
    assertCurrent: expect.any(Function),
    assertCurrentAsync: expect.any(Function),
    source: expect.any(Function),
  };
  const resumeResponse = createThreadResumeResponse({ threadId: "thread-1" });

  useCodexControlTestState({
    prefix: "openclaw-codex-control-auth-",
    cleanup: () => harness.client.close(),
    setup: async (root) => {
      tempDir = root;
      agentDir = path.join(tempDir, "agents", "main", "agent");
      config = { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } };
      setRuntimeConfigSnapshot(config);
      harness = createClientHarness();
      requestMock.mockReset().mockResolvedValue(resumeResponse);
      clientMock.mockReset();
      clientMock.mockImplementation(
        async (_options, run) =>
          await run(requestMock, harness.client, {
            assertCurrent: () => undefined,
            abort: vi.fn(),
          }),
      );
      await writeSession();
    },
  });

  async function setAuthStore(store: AuthProfileStore) {
    const saved = await updateAuthProfileStoreWithLock({
      agentDir,
      stateDir: tempDir,
      updater: (current) => {
        Object.assign(current, store);
        return true;
      },
    });
    expect(saved).not.toBeNull();
  }

  function resume(options: Partial<CodexControlRequestOptions> = {}) {
    return codexControlRequest(
      {},
      "thread/resume",
      { threadId: "thread-1" },
      { config, agentDir, sessionKey, sessionId: "session-1", onResponse: vi.fn(), ...options },
    );
  }

  function writeSession(
    entry: Partial<Parameters<typeof upsertSessionEntry>[0]["entry"]> = {},
    storePath?: string,
  ) {
    return upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: { sessionId: "session-1", updatedAt: Date.now(), ...entry },
    });
  }

  function acquired() {
    return clientMock.mock.calls[0]![0];
  }

  it.each(["before-write", "after-write"] as const)(
    "checks owner before dispatch and preserves accepted settlement after revocation at %s",
    async (revokeAt) => {
      let ownerCurrent = true;
      let writes = 0;
      let settled = false;
      requestMock.mockImplementationOnce(async (request: { assertCurrent?: () => void }) => {
        request.assertCurrent?.();
        writes += 1;
        ownerCurrent = false;
        return resumeResponse;
      });
      const result = codexControlRequest(
        {},
        "thread/fork",
        { threadId: "source-thread", excludeTurns: true },
        {
          startOptions,
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
    const readOptions = { transport: "stdio" as const, command: "codex", args: [], headers: {} };
    await expect(prepareCodexControlSessionAuth(options, readOptions)).resolves.toEqual({
      release: expect.any(Function),
      authProfileId: "openai:selected",
      source: undefined,
      clientOptions: { authProfileId: "openai:selected" },
    });
    await expect(
      prepareCodexControlSessionAuth({ ...options, onResponse: vi.fn() }, readOptions),
    ).rejects.toThrow("requires admitted session authority");
    expect([clientMock.mock.calls, requestMock.mock.calls]).toEqual([[], []]);
  });

  it("requires session authority for thread/resume without its native fork selection", async () => {
    await expect(
      codexControlRequest(
        {},
        "thread/resume",
        { threadId: "source-thread" },
        { startOptions, authProfileId: null, onResponse: vi.fn() },
      ),
    ).rejects.toThrow("requires admitted session authority");
    expect(clientMock).not.toHaveBeenCalled();
  });

  it("resumes with the prepared environment API key and publishes no legacy profile", async () => {
    vi.stubEnv("OPENAI_API_KEY", "control-platform-key");
    const onResponse = vi.fn();

    await resume({ onResponse });

    expect(acquired()).toMatchObject({
      preparedAuth: { kind: "api-key", apiKey: "control-platform-key" },
      authRequirement: "api-key",
      agentDir,
    });
    expect(acquired().authProfileId).toBeUndefined();
    expect(onResponse).toHaveBeenCalledWith(
      expect.objectContaining({ thread: expect.objectContaining({ id: "thread-1" }) }),
      harness.client,
      { authProfileId: undefined, ...expectedAuthority },
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
      await setAuthStore({
        version: 1,
        profiles: { "openai:old": credential, "openai:ready": credential },
        order: { openai: ["openai:old", "openai:ready"] },
        usageStats: { "openai:old": { cooldownUntil: Date.now() + 60_000 } },
      });
      await writeSession({
        authProfileOverride: "openai:old",
        authProfileOverrideSource: "auto",
      });
      const onResponse = vi.fn();

      await resume({ authProfileId: "openai:old", onResponse });

      expect(acquired()).toMatchObject({
        authRequirement: "subscription",
        authBindingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        preparedAuth: {
          kind: "profile",
          profileId: "openai:ready",
          snapshot: { loginParams: { type: "chatgptAuthTokens", accessToken: token } },
        },
      });
      expect(acquired().authProfileId).toBeUndefined();
      expect(onResponse).toHaveBeenCalledWith(expect.anything(), harness.client, {
        authProfileId: "openai:ready",
        ...expectedAuthority,
      });
    },
  );

  it("honors the user-pinned API profile from the admitted explicit store", async () => {
    vi.stubEnv("OPENAI_API_KEY", "unrelated-platform-key");
    const explicitStorePath = path.join(tempDir, "explicit", "sessions.json");
    const configuredStorePath = path.join(tempDir, "configured", "sessions.json");
    config.session = { store: configuredStorePath };
    await setAuthStore({
      version: 1,
      profiles: {
        "openai:first": { type: "api_key", provider: "openai", key: "automatic-key" },
        "openai:pinned": { type: "api_key", provider: "openai", key: "pinned-key" },
      },
      order: { openai: ["openai:first", "openai:pinned"] },
    });
    await writeSession(
      { authProfileOverride: "openai:pinned", authProfileOverrideSource: "user" },
      explicitStorePath,
    );
    await writeSession({ sessionId: "unrelated-session" }, configuredStorePath);

    await resume({ storePath: explicitStorePath, authProfileId: "openai:first" });

    expect(acquired()).toMatchObject({
      authRequirement: "api-key",
      preparedAuth: { kind: "api-key", apiKey: "pinned-key" },
    });
  });

  it("rejects a mismatched admitted row before auth or client acquisition", async () => {
    const storePath = path.join(tempDir, "authority-mismatched", "sessions.json");
    await writeSession({ sessionId: "another-session" }, storePath);

    await expect(resume({ storePath })).rejects.toThrow(
      "Codex session generation is no longer current: session-1",
    );

    expect([clientMock.mock.calls, requestMock.mock.calls]).toEqual([[], []]);
  });

  it("keeps native-auth control subscriptions outside prepared login", async () => {
    vi.stubEnv("OPENAI_API_KEY", "unrelated-platform-key");

    await resume({ authProfileId: null });

    expect(acquired().preparedAuth).toBeUndefined();
    expect(acquired().authRequirement).toBeUndefined();
  });

  it("keeps omitted Unix scope on the explicit user-scoped supervision connection", async () => {
    requestMock.mockResolvedValue({ data: [] });
    const pluginConfig = {
      appServer: {
        transport: "unix" as const,
        url: "unix:///tmp/codex.sock",
        requestTimeoutMs: 321,
      },
    };
    const unixOptions = {
      ...startOptions,
      transport: "unix" as const,
      args: ["app-server", "--listen", "stdio://"],
      url: "unix:///tmp/codex.sock",
    };

    await codexControlRequest(
      pluginConfig,
      "thread/list",
      { archived: false },
      { startOptions: unixOptions, authProfileId: null },
    );

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ startOptions: unixOptions, timeoutMs: 321, authProfileId: null }),
    );
  });
});
