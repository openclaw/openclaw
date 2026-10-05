import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { codexAppServerStartOptionsKey } from "./config-options.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import { prepareCodexAttemptRuntime } from "./run-attempt-runtime.js";
import {
  createParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  testCodexAppServerBindingStore,
  registerCodexTestSessionIdentity,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";
import { applyCodexManagedShellEnvironment } from "./thread-shell-environment.js";

setupRunAttemptTestHooks();

describe("Codex local tool environment placement", () => {
  it("does not issue local GitHub credentials across sequential incognito runs", async () => {
    const prepare = vi.fn(async () => {
      throw new Error("Incognito must not request a grant");
    });
    for (let turn = 0; turn < 2; turn++) {
      const params = createParams(
        path.join(tempDir, "incognito-github.jsonl"),
        path.join(tempDir, "incognito-github"),
        {
          sessionKey: "agent:main:dashboard:incognito-github-test",
          runId: `incognito-github-${turn}`,
        },
      );
      params.hostCapabilities = {
        ...params.hostCapabilities,
        prepareLocalGitHubEnvironment: prepare,
      };
      const connection = await prepareCodexAttemptConnection({
        params,
        options: { bindingStore: testCodexAppServerBindingStore },
      });
      try {
        await prepareCodexAttemptRuntime(connection);
        expect(connection.localGitHubInstructions).toBeUndefined();
        await connection.releaseLocalGitHub();
      } finally {
        connection.cancellation.dispose();
        connection.releaseModelExecution();
      }
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("projects the local run GitHub profile only into native command policy and finalizes it", async () => {
    const dispose = vi.fn(async () => {});
    const credentialAuthority = new AbortController();
    const env = {
      GH_CONFIG_DIR: "/private/run/github",
      GH_HOST: "microsoft.ghe.com",
      GH_TOKEN: "",
      GH_ENTERPRISE_TOKEN: "",
      GITHUB_TOKEN: "",
      GITHUB_ENTERPRISE_TOKEN: "",
      OPENCLAW_GATEWAY_PASSWORD: "",
      OPENCLAW_GITHUB_APP_PRIVATE_KEY: "",
      OPENCLAW_GITHUB_USER_LOGIN: "verified-person",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    };
    const prepare = vi.fn().mockResolvedValue({
      env,
      dispose,
      signal: credentialAuthority.signal,
      assertCurrent: () => {},
      instructions: "fixture identity context",
    });
    const params = createParams(
      path.join(tempDir, "github-local.jsonl"),
      path.join(tempDir, "github-local"),
    );
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareLocalGitHubEnvironment: prepare,
    };
    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });
    try {
      await prepareCodexAttemptRuntime(connection);
      expect(prepare).toHaveBeenCalledOnce();
      expect(connection.shellEnvironment).toMatchObject(env);
      expect(connection.appServer.start.env ?? {}).not.toHaveProperty(
        "GH_CONFIG_DIR",
        env.GH_CONFIG_DIR,
      );
      expect(connection.appServer.start.env ?? {}).not.toHaveProperty("OPENCLAW_GITHUB_USER_LOGIN");
      const policy = applyCodexManagedShellEnvironment(
        { shell_environment_policy: { set: { GH_CONFIG_DIR: "/stale", GH_TOKEN: "stale" } } },
        connection.shellEnvironment,
        connection.disableLoginShell,
      );
      expect(policy).toMatchObject({
        allow_login_shell: false,
        shell_environment_policy: { set: env },
      });
      credentialAuthority.abort(new Error("selected account changed"));
      expect(connection.runAbortController.signal.aborted).toBe(true);
      await connection.releaseLocalGitHub();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      connection.cancellation.dispose();
      connection.releaseModelExecution();
    }
  });

  it.each([undefined, "/request/bin"])(
    "preserves native shell policy below request PATH %s",
    async (requestPath) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: async (method: string) => {
          if (method === "config/read") {
            return {
              config: {
                shell_environment_policy: {
                  inherit: "none",
                  set: { PATH: "/native/bin", KEEP: "yes" },
                },
              },
              origins: {},
              layers: [],
            };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "thread/start") {
            return threadStartResult("thread-1");
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.config = undefined;
      registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
      await startOrResumeThread({
        client: fixture.client,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: {
          ...createAppServerOptions(),
          connectionClass: "local-loopback",
        },
        shellEnvironment: { PATH: "/tools:/gateway/bin" },
        shellPathPrepend: ["/tools"],
        disableLoginShell: true,
        config:
          requestPath === undefined
            ? undefined
            : { "shell_environment_policy.set.PATH": requestPath },
      });
      expect(
        fixture.request.mock.calls.find(([method]) => method === "thread/start")?.[1],
      ).toMatchObject({
        config: {
          allow_login_shell: false,
          shell_environment_policy: {
            inherit: "none",
            set: {
              PATH: ["/tools", requestPath ?? "/native/bin"].join(path.delimiter),
              KEEP: "yes",
            },
          },
        },
      });
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "config/read"),
      ).toHaveLength(1);
    },
  );

  it.each(["local", "unconfigured-local", "unix", "proxy", "remote-root", "sandbox"])(
    "applies the prepared tool PATH only to owned local execution: %s",
    async (placement) => {
      const params = createParams(
        path.join(tempDir, `path-${placement}.jsonl`),
        path.join(tempDir, `path-${placement}`),
      );
      const localToolEnv = { PATH: ["/fixture/tools", "/fixture/system"].join(path.delimiter) };
      params.hostCapabilities = {
        ...params.hostCapabilities,
        preparedEnvironment: () => ({
          credentialScrubEnv: {},
          localIdentityEnv: {},
          managedLocalIdentity: false,
          ...(placement === "unconfigured-local"
            ? {}
            : { localToolEnv, localToolPathPrepend: ["/fixture/tools"] }),
        }),
      };
      if (placement === "sandbox") {
        params.sandbox = createSandboxContext({});
      }
      const connection = await prepareCodexAttemptConnection({
        params,
        options: {
          bindingStore: testCodexAppServerBindingStore,
          pluginConfig: {
            appServer:
              placement === "unix"
                ? { transport: "unix", homeScope: "user", url: "unix:///fixture/native.sock" }
                : {
                    transport: "stdio",
                    ...(placement === "remote-root"
                      ? { remoteWorkspaceRoot: "/remote/workspace" }
                      : {}),
                    ...(placement === "proxy"
                      ? { args: ["app-server", "proxy", "--sock", "/fixture/native.sock"] }
                      : {}),
                  },
          },
        },
      });
      try {
        const expected = placement === "local" ? localToolEnv : undefined;
        expect(connection.shellEnvironment).toEqual(expected);
        expect(connection.shellPathPrepend).toEqual(expected ? ["/fixture/tools"] : undefined);
        expect(connection.appServer.start.env?.PATH).toBe(expected?.PATH);
        expect(connection.disableLoginShell).toBe(false);
        const refreshed = await connection.resolveRuntimeOptionsForCurrentBinding({
          modelProvider: "openai",
          model: params.modelId,
        });
        expect(refreshed.start.env?.PATH).toBe(expected?.PATH);
        if (expected) {
          expect(codexAppServerStartOptionsKey(refreshed.start)).not.toBe(
            codexAppServerStartOptionsKey({
              ...refreshed.start,
              env: { ...refreshed.start.env, PATH: "/fixture/old" },
            }),
          );
        }
      } finally {
        connection.cancellation.dispose();
        connection.releaseModelExecution();
      }
    },
  );
});
