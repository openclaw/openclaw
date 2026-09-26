import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexAppServerStartOptionsKey } from "./config-options.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
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

setupRunAttemptTestHooks();

describe("Codex local tool environment placement", () => {
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
          remoteAppsSubstrate: "preconfigured",
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

  it.each(["local", "unconfigured-local", "websocket", "unix", "proxy", "remote-root", "sandbox"])(
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
              placement === "websocket"
                ? { transport: "websocket", url: "ws://127.0.0.1:19400" }
                : placement === "unix"
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
