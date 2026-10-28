import path from "node:path";
import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexModel, threadStartResult } from "./bounded-turn.test-harness.js";
import { CodexAppServerClient } from "./client.js";
import { turnStartResult } from "./codex-app-server.test-fixtures.js";
import type { CodexAppServerStartOptions, CodexPluginConfig } from "./config.js";
import { runCodexIsolatedCompletion } from "./isolated-completion.js";
import { isolatedParams } from "./isolated-completion.params-test-support.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.test-support.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

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

const createParams = (agentDir: string) =>
  isolatedParams(storedProfile, "openai:stored-b", agentDir, agentDir);

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
      if (request.method === "account/login/start") {
        account = String(request.params?.chatgptAccountId);
        return respond({ type: "chatgptAuthTokens" });
      }
      if (request.method === "turn/start") {
        inferenceAccounts.push(account);
        respond(turnStartResult("turn-boundary"));
        queueMicrotask(() =>
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
          }),
        );
        return;
      }
      const cwd = (request.params?.cwds as string[] | undefined)?.[0];
      const replies: Record<string, unknown> = {
        initialize: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` },
        "account/read": { account: { type: accountType, id: account }, requiresOpenaiAuth: true },
        "model/list": { data: [codexModel()], nextCursor: null },
        get "config/read"() {
          const name = {
            type: "user",
            file: path.join(startedOptions!.env!.CODEX_HOME!, "config.toml"),
          };
          return {
            config: {
              mcp_servers: {},
              features: { hooks: true, plugins: false },
              project_root_markers: [],
            },
            layers: [{ name, config: {} }],
          };
        },
        "hooks/list": { data: [{ cwd, hooks: [], warnings: [], errors: [] }] },
        "configRequirements/read": { requirements: null },
        "thread/start": threadStartResult("gpt-5.4"),
        "mcpServerStatus/list": { data: [], nextCursor: null },
      };
      if (Object.hasOwn(replies, request.method)) {
        respond(replies[request.method]);
      } else {
        send({ id: request.id, error: { code: -32601, message: request.method } });
      }
    },
  });
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
  } satisfies CodexPluginConfig;
}

function readStart(boundary: ReturnType<typeof createNativeBoundary>) {
  expect(boundary.start).toHaveBeenCalledTimes(1);
  const options = boundary.start.mock.calls[0]![0];
  expect(options).toBeDefined();
  return options!;
}

describe("isolated completion account and daemon ownership", () => {
  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("refuses native API-key auth rather than substituting stored profile B", async () => {
    await withTempDir("codex-isolated-auth-", async (root) => {
      const boundary = createNativeBoundary("apiKey");
      const pluginConfig = createPluginConfig(root, "user");
      const pending = runCodexIsolatedCompletion(createParams(root), { pluginConfig });
      await expect(pending).rejects.toThrow("requires ChatGPT auth in the native Codex home");
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
        const result = await runCodexIsolatedCompletion(createParams(root), { pluginConfig });
        if (homeScope === "user") {
          expect(result.assistant.content).toEqual([
            { type: "text", text: `Garden Planning (${nativeAccount})` },
          ]);
          expect(boundary.calls.some((call) => call.method === "account/read")).toBe(true);
          expect(JSON.stringify(boundary.calls)).not.toContain("synthetic-stored-b-access");
        }

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
