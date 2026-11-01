import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { useCodexWorkerProvisioningFixture } from "../node-app-server-command.test-support.js";
import { codexAppServerStartOptionsKey } from "./config-options.js";
import { shouldRequireCodexSandboxExecServerEnvironment } from "./dynamic-tool-build.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import {
  createParams,
  createCodexRuntimePlanFixture,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  testCodexAppServerBindingStore,
  buildCodexSupervisionTestConnectionFingerprint,
  registerCodexTestSessionIdentity,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

const provisionWorker = useCodexWorkerProvisioningFixture();

setupRunAttemptTestHooks();

describe("Codex local tool environment placement", () => {
  it.each([
    { requestPath: undefined, gitOnly: false },
    { requestPath: "/request/bin", gitOnly: false },
    { requestPath: undefined, gitOnly: true },
  ])(
    "preserves native shell policy with request PATH $requestPath and gitOnly=$gitOnly",
    async ({ requestPath, gitOnly }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: async (method: string) => {
          if (method === "config/read") {
            return {
              config: {
                shell_environment_policy: {
                  inherit: "none",
                  set: {
                    PATH: "/native/bin",
                    KEEP: "yes",
                    ...(gitOnly ? { GIT_CONFIG_PARAMETERS: "'user.name=Native'" } : {}),
                  },
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
        ...(gitOnly
          ? {
              shellGitConfigParameters: "'maintenance.auto=false' 'gc.auto=0'",
            }
          : {
              shellEnvironment: { PATH: "/tools:/gateway/bin" },
              shellPathPrepend: ["/tools"],
              disableLoginShell: true,
            }),
        config:
          requestPath === undefined
            ? undefined
            : { "shell_environment_policy.set.PATH": requestPath },
      });
      expect(
        fixture.request.mock.calls.find(([method]) => method === "thread/start")?.[1],
      ).toMatchObject({
        config: {
          ...(!gitOnly ? { allow_login_shell: false } : {}),
          shell_environment_policy: {
            inherit: "none",
            set: {
              PATH: gitOnly
                ? "/native/bin"
                : ["/tools", requestPath ?? "/native/bin"].join(path.delimiter),
              KEEP: "yes",
              ...(gitOnly
                ? {
                    GIT_CONFIG_PARAMETERS:
                      "'user.name=Native' 'maintenance.auto=false' 'gc.auto=0'",
                  }
                : {}),
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
    "places the prepared environment only on owned local execution: %s",
    async (placement) => {
      vi.stubEnv("GIT_CONFIG_PARAMETERS", "'user.name=Ambient'");
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
          localGitConfigParameters: "'maintenance.auto=false' 'gc.auto=0'",
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
      using _ = { [Symbol.dispose]: connection.releaseBindingAuthority };
      try {
        const expected = placement === "local" ? localToolEnv : undefined;
        expect(connection.shellEnvironment).toEqual(expected);
        expect(connection.shellPathPrepend).toEqual(expected ? ["/fixture/tools"] : undefined);
        const ownedLocal = placement === "local" || placement === "unconfigured-local";
        const parameters = "'maintenance.auto=false' 'gc.auto=0'";
        expect(connection.shellGitConfigParameters).toBe(ownedLocal ? parameters : undefined);
        expect(connection.appServer.start.env?.PATH).toBe(expected?.PATH);
        const expectedParameters = ownedLocal ? `'user.name=Ambient' ${parameters}` : undefined;
        expect(
          resolveCodexAppServerSpawnEnv(connection.appServer.start, {}).GIT_CONFIG_PARAMETERS,
        ).toBe(expectedParameters);
        expect(connection.disableLoginShell).toBe(false);
        const refreshed = await connection.resolveRuntimeOptionsForCurrentBinding({
          modelProvider: "openai",
          model: params.modelId,
        });
        expect(refreshed.start.env?.PATH).toBe(expected?.PATH);
        expect(resolveCodexAppServerSpawnEnv(refreshed.start, {}).GIT_CONFIG_PARAMETERS).toBe(
          expectedParameters,
        );
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

it.each(["api-key", "subscription"] as const)(
  "keeps worker %s route constraints through actual client startup without local login",
  async (authRequirement) => {
    provisionWorker();
    const params = createParams(
      path.join(tempDir, "worker-auth.jsonl"),
      path.join(tempDir, "worker-auth-workspace"),
    );
    params.permissionMode = "full";
    const sandbox = {
      ...createSandboxContext({}),
      backendId: "node",
      placementExecutionMode: "remote-exec",
      placementNodeId: "worker-node",
      placementEnvironmentId: "worker-environment",
      placementSessionId: params.sessionId,
      placementOwnerEpoch: 1,
    };
    params.sandbox = sandbox;
    const runtimePlan = createCodexRuntimePlanFixture();
    params.runtimePlan = {
      ...runtimePlan,
      auth: {
        ...runtimePlan.auth,
        selectedAuthMode: authRequirement,
        modelRoute: {
          provider: "openai",
          modelId: params.modelId,
          api: authRequirement === "api-key" ? "openai-responses" : "openai-chatgpt-responses",
          baseUrl:
            authRequirement === "api-key"
              ? "https://api.openai.com/v1"
              : "https://chatgpt.com/backend-api/codex",
          authRequirement,
          requestTransportOverrides: "none",
        },
      },
    };
    const runtime = createPluginRuntimeMock();
    const closed = Promise.withResolvers<void>();
    let receive: ((frame: Uint8Array) => void | Promise<void>) | undefined;
    const methods: string[] = [];
    const open = vi.spyOn(runtime.nodes, "openDuplex").mockImplementation(async () => ({
      send: async (frame) => {
        const request = JSON.parse(Buffer.from(frame).toString("utf8")) as {
          id?: string | number;
          method: string;
        };
        methods.push(request.method);
        if (request.id !== undefined) {
          const result =
            request.method === "initialize"
              ? { userAgent: "codex-cli/0.164.0" }
              : { account: { type: authRequirement === "api-key" ? "chatgpt" : "apiKey" } };
          await receive?.(Buffer.from(JSON.stringify({ id: request.id, result })));
        }
      },
      onMessage: (listener) => {
        receive = listener;
        return () => {
          receive = undefined;
        };
      },
      close: () => closed.resolve(),
      closed: closed.promise,
    }));
    const connection = await prepareCodexAttemptConnection({
      params,
      options: {
        bindingStore: testCodexAppServerBindingStore,
        runtime,
        pluginConfig: { appServer: { workerHostedCloud: true } },
      },
    });
    try {
      const outcome = await connection
        .attemptClientFactory({
          authProfileId: connection.startupClientAuthProfileId,
          preparedAuth: connection.startupPreparedAuth,
          authRequirement: connection.startupAuthRequirement,
        })
        .then(
          async (client) => {
            await client.closeAndWait();
            return undefined;
          },
          (error: unknown) => error,
        );
      expect(outcome).toMatchObject({ status: 401 });
      expect(connection.effectiveWorkspace).toBe(sandbox.containerWorkdir);
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "worker-node",
          params: expect.objectContaining({ authorization: "session-full" }),
        }),
      );
      expect(connection.startupAuthRequirement).toBe(authRequirement);
      expect(connection.startupClientAuthProfileId).toBeNull();
      expect(connection.startupPreparedAuth).toBeUndefined();
      expect(methods).toContain("account/read");
      expect(methods).not.toContain("account/login/start");
      await closed.promise;
    } finally {
      connection.cancellation.dispose();
      connection.releaseModelExecution();
      connection.releaseBindingAuthority();
    }
  },
);

it.each(["explicit-profile", "forwarded-profile", "supervision"] as const)(
  "rejects worker hosting instead of silently replacing %s ownership",
  async (ownership) => {
    const params = createParams(path.join(tempDir, "owned.jsonl"), path.join(tempDir, "owned"));
    params.permissionMode = "full";
    const sandbox = {
      ...createSandboxContext({}),
      backendId: "node",
      placementExecutionMode: "remote-exec",
      placementNodeId: "worker-node",
    };
    params.sandbox = sandbox;
    if (ownership === "explicit-profile") {
      params.authProfileId = "openai:chosen";
    } else if (ownership === "forwarded-profile") {
      const plan = createCodexRuntimePlanFixture();
      params.runtimePlan = {
        ...plan,
        auth: { ...plan.auth, forwardedAuthProfileId: "openai:chosen" },
      };
    } else {
      registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
      await writeCodexAppServerBinding(params.sessionFile, {
        threadId: "native-thread",
        cwd: params.workspaceDir,
        connectionScope: "supervision",
        appServerRuntimeFingerprint: buildCodexSupervisionTestConnectionFingerprint({
          appServer: { workerHostedCloud: true },
          supervision: { enabled: true },
        }),
        supervisionSourceThreadId: "native-thread",
        conversationSourceTransferComplete: true,
        preserveNativeModel: true,
        model: "native-model",
        modelProvider: "openai",
      });
    }
    const outcome = await prepareCodexAttemptConnection({
      params,
      options: {
        bindingStore: testCodexAppServerBindingStore,
        runtime: createPluginRuntimeMock(),
        pluginConfig: { appServer: { workerHostedCloud: true }, supervision: { enabled: true } },
      },
    }).then(
      (connection) => {
        connection.cancellation.dispose();
        connection.releaseModelExecution();
        connection.releaseBindingAuthority();
        return undefined;
      },
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).toMatchObject({
      message: expect.stringContaining("worker-owned authentication"),
    });
  },
);

it("keeps non-node remote placements confined when worker hosting is configured", async () => {
  const sandbox = {
    ...createSandboxContext({}),
    backendId: "ssh",
    placementExecutionMode: "remote-exec",
  };
  expect(
    shouldRequireCodexSandboxExecServerEnvironment({
      sandbox,
      nativeToolSurfaceEnabled: true,
      sandboxExecServerEnabled: true,
      pluginConfig: { appServer: { workerHostedCloud: true } },
    }),
  ).toBe(true);
  const params = createParams(
    path.join(tempDir, "ssh-worker.jsonl"),
    path.join(tempDir, "ssh-workspace"),
  );
  params.permissionMode = "full";
  params.sandbox = sandbox;
  await expect(
    prepareCodexAttemptConnection({
      params,
      options: {
        bindingStore: testCodexAppServerBindingStore,
        runtime: createPluginRuntimeMock(),
        pluginConfig: { appServer: { workerHostedCloud: true } },
      },
    }),
  ).rejects.toThrow("requires an enrolled node");
});

it.each(["ordinary", "ordinary-profile", "worker"] as const)(
  "keeps native-command auth within its admitted %s placement boundary",
  async (placement) => {
    const params = createParams(
      path.join(tempDir, "native-placement.jsonl"),
      path.join(tempDir, "native-placement"),
    );
    params.permissionMode = "full";
    params.provider = "command-fixture";
    params.model = {
      ...params.model,
      provider: params.provider,
      api: "openai-responses",
      baseUrl: "https://native.example.test/v1",
    };
    params.runtimePlan = {
      ...createCodexRuntimePlanFixture(),
      auth: {
        providerForAuth: params.provider,
        authProfileProviderForAuth: params.provider,
        selectedAuthMode: "native-command",
        credentialSource: { kind: "none" },
      },
    };
    const readHostProfiles = vi.fn(() => {
      throw new Error("Unexpected host profile lookup");
    });
    params.authProfileStore = {
      version: 1,
      get profiles() {
        return readHostProfiles();
      },
    };
    if (placement === "worker") {
      const sandbox = {
        ...createSandboxContext({}),
        backendId: "node",
        placementExecutionMode: "remote-exec",
        placementNodeId: "worker-node",
      };
      params.sandbox = sandbox;
    }
    if (placement === "ordinary-profile") {
      params.authProfileId = "openai:chosen";
    }
    const runtime = createPluginRuntimeMock();
    const open = vi.spyOn(runtime.nodes, "openDuplex");
    const preparation = prepareCodexAttemptConnection({
      params,
      options: {
        bindingStore: testCodexAppServerBindingStore,
        runtime,
        pluginConfig: { appServer: { workerHostedCloud: true } },
      },
    });
    if (placement !== "ordinary") {
      await expect(preparation).rejects.toThrow(
        "Native command auth cannot use host credentials or remote-exec placement",
      );
    } else {
      const connection = await preparation;
      try {
        expect(connection.startupAuthRequirement).toBe("native-command");
        expect(connection.startupClientAuthProfileId).toBeNull();
        expect(connection.startupPreparedAuth).toBeUndefined();
      } finally {
        connection.cancellation.dispose();
        connection.releaseModelExecution();
        connection.releaseBindingAuthority();
      }
    }
    expect(open).not.toHaveBeenCalled();
    expect(readHostProfiles).not.toHaveBeenCalled();
  },
);
