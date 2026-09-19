import path from "node:path";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexModel, threadStartResult } from "./bounded-turn.test-harness.js";
import { CodexAppServerClient } from "./client.js";
import { turnStartResult } from "./codex-app-server.test-fixtures.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { runCodexIsolatedCompletion } from "./isolated-completion.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

type IsolatedParams = Parameters<NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>>[0];

const nativeAccount = "native-account-a";
const profileAccount = "stored-account-b";
const storedProfile: AuthProfileStore = {
  version: 1,
  profiles: {
    "openai:stored-b": {
      type: "oauth",
      provider: "openai",
      access: "synthetic-stored-b-access",
      refresh: "synthetic-stored-b-refresh",
      expires: 4_102_444_800_000,
      accountId: profileAccount,
    },
  },
};

function createParams(agentDir: string, withProfile: boolean): IsolatedParams {
  return {
    authorization: {
      owner: "harness",
      plan: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        ...(withProfile ? { forwardedAuthProfileId: "openai:stored-b" } : {}),
        modelRoute: {
          provider: "openai",
          modelId: "gpt-5.4",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
        },
      },
      authProfileStore: withProfile ? storedProfile : { version: 1, profiles: {} },
    },
    config: {},
    provider: "openai",
    modelId: "gpt-5.4",
    agentId: "main",
    agentDir,
    workspaceDir: agentDir,
    systemPrompt: "Name the conversation.",
    prompt: "Help me plan a garden.",
    timeoutMs: 5_000,
  } as IsolatedParams;
}

function createNativeBoundary(accountType = "chatgpt") {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const inferenceAccounts: string[] = [];
  let account = nativeAccount;
  let startedOptions: Partial<CodexAppServerStartOptions> | undefined;
  const harness = createClientHarness({
    onWrite(line, send) {
      const request = JSON.parse(line) as {
        id?: number;
        method: string;
        params?: Record<string, unknown>;
      };
      calls.push({ method: request.method, params: request.params });
      if (request.id === undefined) {
        return;
      }
      const respond = (result: unknown) => send({ id: request.id, result });
      switch (request.method) {
        case "initialize":
          respond({ userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` });
          return;
        case "account/read":
          respond({ account: { type: accountType, id: account }, requiresOpenaiAuth: true });
          return;
        case "account/login/start":
          account = String(request.params?.chatgptAccountId);
          respond({ type: "chatgptAuthTokens" });
          return;
        case "model/list":
          respond({ data: [codexModel()], nextCursor: null });
          return;
        case "config/read":
          respond({
            config: {
              mcp_servers: {},
              features: { hooks: true, plugins: false },
              project_root_markers: [],
            },
            layers: [
              {
                name: {
                  type: "user",
                  file: path.join(startedOptions!.env!.CODEX_HOME!, "config.toml"),
                },
                config: {},
              },
            ],
          });
          return;
        case "hooks/list":
          respond({
            data: [
              {
                cwd: (request.params?.cwds as string[] | undefined)?.[0],
                hooks: [],
                warnings: [],
                errors: [],
              },
            ],
          });
          return;
        case "configRequirements/read":
          respond({ requirements: null });
          return;
        case "thread/start":
          respond(threadStartResult("gpt-5.4"));
          return;
        case "mcpServerStatus/list":
          respond({ data: [], nextCursor: null });
          return;
        case "turn/start": {
          inferenceAccounts.push(account);
          respond(turnStartResult("turn-boundary"));
          queueMicrotask(() => {
            send({
              method: "turn/completed",
              params: {
                threadId: "thread-finalizer",
                turn: {
                  ...turnStartResult("turn-boundary", "completed").turn,
                  items: [
                    { id: "answer", type: "agentMessage", text: `Garden Planning (${account})` },
                  ],
                },
              },
            });
          });
          return;
        }
        default:
          send({ id: request.id, error: { code: -32601, message: request.method } });
      }
    },
  });
  // Keep authorization, client startup, account verification, and turn execution
  // real; replace only the native process/RPC boundary with synthetic principals.
  const start = vi.spyOn(CodexAppServerClient, "start").mockImplementation(async (options) => {
    startedOptions = options;
    return harness.client;
  });
  return { calls, inferenceAccounts, start };
}

function createPluginConfig(root: string, homeScope: "user" | "agent", proxy = false) {
  vi.stubEnv("CODEX_HOME", path.join(root, "configured-home"));
  return {
    appServer: {
      command: path.join(root, "synthetic-codex"),
      args: proxy
        ? ["app-server", "proxy", "--sock", path.join(root, "configured-daemon.sock")]
        : ["app-server", "--listen", "stdio://"],
      transport: "stdio",
      homeScope,
    },
  };
}

function readStart(
  boundary: ReturnType<typeof createNativeBoundary>,
): Partial<CodexAppServerStartOptions> {
  expect(boundary.start).toHaveBeenCalledTimes(1);
  const options = boundary.start.mock.calls[0]?.[0];
  if (!options) {
    throw new Error("expected native startup options");
  }
  return options;
}

describe("isolated completion account and daemon ownership", () => {
  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([false, true])(
    "keeps native account A authoritative with a stored profile present: %s",
    async (withProfile) => {
      await withTempDir("codex-isolated-auth-", async (root) => {
        const boundary = createNativeBoundary();
        const pluginConfig = createPluginConfig(root, "user");
        const result = await runCodexIsolatedCompletion(createParams(root, withProfile), {
          pluginConfig,
        });

        expect(result.assistant.content).toEqual([
          { type: "text", text: `Garden Planning (${nativeAccount})` },
        ]);
        expect(boundary.calls.some((call) => call.method === "account/read")).toBe(true);
        expect(boundary.calls.filter((call) => call.method === "account/login/start")).toEqual([]);
        expect(boundary.inferenceAccounts).toEqual([nativeAccount]);
        expect(JSON.stringify(boundary.calls)).not.toContain("synthetic-stored-b-access");
        expect(readStart(boundary)).toMatchObject(pluginConfig.appServer);
      });
    },
  );

  it("rejects an incompatible native account before inference without logging in stored B", async () => {
    await withTempDir("codex-isolated-auth-", async (root) => {
      const boundary = createNativeBoundary("apiKey");
      await expect(
        runCodexIsolatedCompletion(createParams(root, true), {
          pluginConfig: createPluginConfig(root, "user"),
        }),
      ).rejects.toThrow("requires ChatGPT auth in the native Codex home");

      expect(boundary.calls.filter((call) => call.method === "account/login/start")).toEqual([]);
      expect(boundary.inferenceAccounts).toEqual([]);
    });
  });

  it.each(["user", "agent"] as const)(
    "retains the configured stdio proxy and its %s authentication contract",
    async (homeScope) => {
      await withTempDir("codex-isolated-proxy-", async (root) => {
        const boundary = createNativeBoundary();
        const pluginConfig = createPluginConfig(root, homeScope, true);
        await runCodexIsolatedCompletion(createParams(root, true), { pluginConfig });

        const start = readStart(boundary);
        expect(start).toMatchObject({
          command: pluginConfig.appServer.command,
          transport: "stdio",
          homeScope,
          env: {
            CODEX_HOME: path.join(root, homeScope === "user" ? "configured-home" : "codex-home"),
          },
        });
        expect(start.args).toEqual(expect.arrayContaining(pluginConfig.appServer.args));
        expect(start.args).not.toContain("stdio://");
        const logins = boundary.calls.filter((call) => call.method === "account/login/start");
        expect(logins).toHaveLength(homeScope === "user" ? 0 : 1);
        expect(boundary.inferenceAccounts).toEqual([
          homeScope === "user" ? nativeAccount : profileAccount,
        ]);
      });
    },
  );
});
