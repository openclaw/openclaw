import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { registerAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it, vi } from "vitest";
import * as appServerPolicy from "./app-server-policy.js";
import { applyCodexAppServerAuthProfile, bridgeCodexAppServerStartOptions } from "./auth-bridge.js";
import * as bindingConnection from "./binding-connection.js";
import * as codexRequirements from "./config-requirements.js";
import { resolveCodexAppServerRuntimeOptions, type CodexPluginConfig } from "./config.js";
import {
  prepareCodexAttemptConnection,
  type CodexAttemptConnection,
} from "./run-attempt-connection.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  createCodexTestBindingStore,
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { withCodexThreadLifecycleBinding } from "./thread-lifecycle-adoption.js";

setupRunAttemptTestHooks();

function connectionParams(name: string, workspaceName = `workspace-${name}`) {
  const params = createParams(
    path.join(tempDir, `${name}.jsonl`),
    path.join(tempDir, workspaceName),
  );
  registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
  return params;
}

type ConnectionOptions = Parameters<typeof prepareCodexAttemptConnection>[0]["options"];

function placementOptions(placement: string): ConnectionOptions {
  const socket = { transport: "websocket" as const, url: "ws://127.0.0.1:19400" };
  const endpoints: Record<string, NonNullable<CodexPluginConfig["appServer"]>> = {
    websocket: socket,
    "loopback-server": { ...socket, authToken: "fixture-token" },
    "remote-server": { ...socket, url: "wss://fixture.invalid/native", authToken: "fixture-token" },
    "ordinary-unix-server": {
      transport: "unix",
      homeScope: "user",
      url: "unix:///fixture/native.sock",
    },
    "remote-root": { transport: "stdio", remoteWorkspaceRoot: "/remote/workspace" },
    "stdio-proxy": {
      transport: "stdio",
      args: ["app-server", "proxy", "--sock", "/fixture/server.sock"],
    },
  };
  return { pluginConfig: { appServer: endpoints[placement] ?? { transport: "stdio" } } };
}

async function prepareConnection(
  params: ReturnType<typeof createParams>,
  options: ConnectionOptions = {},
) {
  const connection = await prepareCodexAttemptConnection({
    params,
    options: { bindingStore: testCodexAppServerBindingStore, ...options },
  });
  return Object.assign(connection, bindingCustody(connection));
}

function bindingCustody(connection: CodexAttemptConnection) {
  return { [Symbol.dispose]: () => connection.releaseBindingAuthority() };
}

function prepareAuth(
  params: ReturnType<typeof createParams>,
  modelId: string,
  subscription = false,
) {
  const plan = createCodexRuntimePlanFixture();
  params.runtimePlan = {
    ...plan,
    auth: {
      ...plan.auth,
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      selectedAuthMode: subscription ? "subscription" : "api-key",
      modelRoute: {
        provider: "openai",
        modelId,
        api: subscription ? "openai-chatgpt-responses" : "openai-responses",
        baseUrl: subscription
          ? "https://chatgpt.com/backend-api/codex"
          : "https://api.openai.com/v1",
        authRequirement: subscription ? "subscription" : "api-key",
        requestTransportOverrides: "none",
      },
    },
  };
  if (!subscription) {
    params.resolvedApiKey = "prepared-test-key";
  }
  return params.runtimePlan.auth;
}

function policyParams(
  name: string,
  permissionMode: ReturnType<typeof createParams>["permissionMode"],
  execMode?: NonNullable<ReturnType<typeof createParams>["execOverrides"]>["mode"],
) {
  const params = connectionParams(name, name);
  Object.assign(params, {
    agentDir: path.join(tempDir, "agent"),
    permissionMode,
    sessionRoot: params.workspaceDir,
  });
  if (execMode) {
    params.execOverrides = { ...params.execOverrides, mode: execMode };
  }
  return params;
}

const nativeModel = { provider: "openai", model: "gpt-5.6-luna" };

async function oversizedThread() {
  const params = connectionParams("session", "workspace");
  params.agentDir = path.join(tempDir, "agent");
  params.config = { agents: { defaults: { compaction: { maxActiveTranscriptBytes: "1mb" } } } };
  await writeCodexAppServerBinding(params.sessionFile, {
    threadId: "thread-existing",
    cwd: params.workspaceDir,
    model: params.modelId,
    modelProvider: "openai",
  });
  const rolloutDir = path.join(params.agentDir, "codex-home", "sessions");
  await fs.mkdir(rolloutDir, { recursive: true });
  await fs.writeFile(path.join(rolloutDir, "rollout-thread-existing.jsonl"), "x".repeat(1_048_577));
  return params;
}

it.each(["local", "websocket", "remote-root", "sandbox", "managed-sandbox"])(
  "prepares host settings and input paths only for confirmed local execution: %s",
  async (placement) => {
    const sessionFile = path.join(tempDir, `input-${placement}.jsonl`);
    const params = createParams(sessionFile, path.join(tempDir, `input-${placement}`));
    if (placement === "sandbox" || placement === "managed-sandbox") {
      params.sandbox = {
        ...createSandboxContext({}),
        ...(placement === "managed-sandbox"
          ? { workspaceSource: "managed-worktree" as const }
          : {}),
      };
    }
    const prepare = vi.fn(async () => "local document path");
    const prepareContinuationRetryCount = vi.fn();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareInputAttachments: prepare,
      prepareContinuationRetryCount,
    };
    using connection = await prepareConnection(params, placementOptions(placement));
    try {
      if (placement === "local") {
        expect(prepareContinuationRetryCount).toHaveBeenCalledExactlyOnceWith({
          cwd: connection.effectiveCwd,
        });
      } else {
        expect(prepareContinuationRetryCount).not.toHaveBeenCalled();
      }
      const note = await connection.prepareInputAttachments({
        maxChars: 60_000,
        assertCurrent: () => {},
      });
      expect(note).toBe(placement === "local" ? "local document path" : undefined);
      expect(prepare).toHaveBeenCalledTimes(placement === "local" ? 1 : 0);
    } finally {
      connection.cancellation.dispose();
      connection.releaseModelExecution();
    }
  },
);

it("releases connection preparation when host retry settings fail before execution", async () => {
  const params = createParams(
    path.join(tempDir, "retry-preparation-failure.jsonl"),
    path.join(tempDir, "retry-preparation-failure"),
  );
  const controller = new AbortController();
  params.abortSignal = controller.signal;
  const prepareContinuationRetryCount = vi.fn<(workspace: { cwd: string }) => void>(() => {
    throw new Error("retry settings unavailable");
  });
  params.hostCapabilities = {
    ...params.hostCapabilities,
    prepareContinuationRetryCount,
  };
  const clientFactory = vi.fn(async () => {
    throw new Error("unexpected provider startup");
  });
  const listeners = getEventListeners(controller.signal, "abort").length;
  await expect(
    runCodexAppServerAttempt(params, {
      bindingStore: testCodexAppServerBindingStore,
      clientFactory,
    }),
  ).rejects.toThrow("retry settings unavailable");
  expect(prepareContinuationRetryCount).toHaveBeenCalledOnce();
  expect(clientFactory).not.toHaveBeenCalled();
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(listeners);
  // Re-entering the same session proves preparation did not retain binding custody.
  prepareContinuationRetryCount.mockImplementation(() => {});
  using connection = await prepareConnection(params);
  connection.cancellation.dispose();
  connection.releaseModelExecution();
  connection.releaseSandboxContext();
  connection.releaseBindingAuthority();
});

it.each(["remote attachment path"])(
  "stages only explicit steering inputs through the remote owner (note: %s)",
  async (remoteNote) => {
    const params = createParams(
      path.join(tempDir, "remote-input.jsonl"),
      path.join(tempDir, "remote-input"),
    );
    const media = [{ path: "media://inbound/input.csv", contentType: "text/csv" }];
    params.media = media;
    const prepareLocal = vi.fn(async () => "unexpected local path");
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareInputAttachments: prepareLocal,
    };
    const connection = await prepareConnection(params, placementOptions("remote-root"));
    const prepareRemote = vi.fn(async () => remoteNote);
    const release = registerAgentWorkspaceAccess(params.workspaceDir, {
      bridge: {
        readFile: async () => Buffer.alloc(0),
        writeFile: async () => {},
        stat: async () => null,
      },
      prepareTurnAttachments: prepareRemote,
    });
    const signal = new AbortController().signal;
    try {
      expect(
        await connection.prepareInputAttachments({ maxChars: 60_000, assertCurrent: () => {} }),
      ).toBeUndefined();
      expect(prepareRemote).not.toHaveBeenCalled();
      expect(
        await connection.prepareInputAttachments({
          maxChars: 60_000,
          turn: { media },
          signal,
          assertCurrent: () => {},
        }),
      ).toBe(remoteNote);
      expect(prepareRemote).toHaveBeenCalledExactlyOnceWith(
        {
          config: params.config,
          media,
          timeoutMs: params.timeoutMs,
          abortSignal: signal,
        },
        expect.any(Function),
      );
      expect(prepareLocal).not.toHaveBeenCalled();
    } finally {
      release();
      connection.cancellation.dispose();
      connection.releaseModelExecution();
    }
  },
);

it.each(["stdio-proxy", "local-stdio"])(
  "keeps ordinary %s sessions isolated when deferred auth omits homeScope",
  async (connectionType) => {
    vi.stubEnv("OPENCLAW_CODEX_APP_SERVER_ARGS", undefined);
    const sessionFile = path.join(tempDir, `deferred-${connectionType}.jsonl`);
    const params = createParams(
      sessionFile,
      path.join(tempDir, `deferred-${connectionType}-workspace`),
    );
    const runtimePlan = createCodexRuntimePlanFixture();
    params.runtimePlan = {
      ...runtimePlan,
      auth: {
        ...runtimePlan.auth,
        deferredRouteSupport: {
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      },
    };
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
    using connection = await prepareConnection(params, placementOptions(connectionType));
    expect(connection.appServer.start).toMatchObject({ transport: "stdio", homeScope: "agent" });
    if (connectionType === "local-stdio") {
      vi.stubEnv("CODEX_HOME", path.join(tempDir, "personal-codex"));
      const start = await bridgeCodexAppServerStartOptions({
        startOptions: connection.appServer.start,
        agentDir: connection.agentDir,
        authProfileId: connection.startupClientAuthProfileId,
        authProfileStore: params.authProfileStore,
      });
      expect(start.env?.CODEX_HOME).toBe(path.join(connection.agentDir, "codex-home"));
      expect(start.env?.CODEX_HOME).not.toBe(process.env.CODEX_HOME);
    }
  },
);

it("retains the recovered generation fence after connection preparation", async () => {
  const workspaceDir = path.join(tempDir, "recovered-workspace");
  const params = createParams(path.join(tempDir, "recovered.jsonl"), workspaceDir);
  const current = {
    kind: "session" as const,
    agentId: "main",
    sessionKey: params.sessionKey!,
    sessionId: params.sessionId,
  };
  const previous = { ...current, sessionId: "before-compaction" };
  const scope = {
    agentId: current.agentId,
    sessionKey: current.sessionKey,
    storePath: path.join(tempDir, "admitted", "sessions.json"),
  };
  params.sessionTarget = { ...scope, sessionId: current.sessionId };
  await upsertSessionEntry({ ...scope, entry: { sessionId: previous.sessionId, updatedAt: 1 } });
  await patchSessionEntry({ ...scope, update: () => ({ sessionId: current.sessionId }) });
  const bindingStore = createCodexTestBindingStore();
  const binding = { threadId: "recovered-native-thread", cwd: workspaceDir };
  await bindingStore.mutate(previous, { kind: "set", binding });
  const originalHostCapabilities = params.hostCapabilities;

  using connection = await prepareConnection(params, { bindingStore });
  expect(bindingStore.read(current)).toEqual(binding);
  expect(connection.params.hostCapabilities).toBe(originalHostCapabilities);
  expect(() => connection.assertCurrent()).not.toThrow();
  await patchSessionEntry({ ...scope, update: () => ({ sessionId: "next-compaction" }) });

  expect(() => originalHostCapabilities.assertActive()).not.toThrow();
  expect(connection.assertCurrent).toThrow("Codex session generation is no longer current");
  expect(connection.assertLegacyCurrent).toThrow("Codex session generation is no longer current");
  const effect = vi.fn();
  await expect(connection.withCurrent(effect)).rejects.toThrow(
    "Codex session generation is no longer current",
  );
  expect(effect).not.toHaveBeenCalled();
  expect(bindingStore.read(current)).toEqual(binding);
});

it.each(["missing", "ordinary", "auth-changed", "model-changed", "provider-changed"] as const)(
  "rejects %s expected native ownership before reclaim or connection preparation",
  async (state) => {
    const params = connectionParams("expected-ownership", "expected-ownership-workspace");
    const { sessionFile, workspaceDir } = params;
    params.expectedSessionRuntimeOwnership = {
      model: "native",
      auth: state === "auth-changed" ? "native" : "host",
      modelRef: nativeModel,
    };
    if (state !== "missing") {
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-existing",
        cwd: workspaceDir,
        ...(state !== "ordinary" ? { preserveNativeModel: true } : {}),
        model: state === "model-changed" ? "gpt-5.6-sol" : "gpt-5.6-luna",
        modelProvider: state === "provider-changed" ? "other-native-provider" : "openai",
      });
    }
    const before = await readCodexAppServerBinding(sessionFile);
    const reclaim = vi.spyOn(testCodexAppServerBindingStore, "prepareSessionGenerationReclaim");
    const connect = vi
      .spyOn(bindingConnection, "resolveCodexBindingAppServerConnection")
      .mockImplementation(async () => {
        throw new Error("invalid ownership reached connection preparation");
      });

    await expect(prepareConnection(params)).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      message: expect.stringContaining("Reattach the original native session"),
    });
    expect(reclaim).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(before);
  },
);

it.each(["preserved", "auth-changed"] as const)(
  "rechecks %s native ownership after acquiring the lifecycle binding lease",
  async (state) => {
    const params = connectionParams("leased-ownership", "leased-ownership-workspace");
    const { sessionFile, workspaceDir } = params;
    params.expectedSessionRuntimeOwnership = {
      model: "native",
      auth: "host",
      modelRef: nativeModel,
    };
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      preserveNativeModel: true,
      model: "gpt-5.6-luna",
      modelProvider: "openai",
    });
    const bindingStore = testCodexAppServerBindingStore;
    const withLease = bindingStore.withLease.bind(bindingStore);
    vi.spyOn(bindingStore, "withLease").mockImplementationOnce(async (identity, run) => {
      // The initial snapshot is valid; simulate retirement/replacement while awaiting its lease.
      if (state !== "preserved") {
        await bindingStore.mutate(identity, {
          kind: "patch",
          threadId: "thread-existing",
          patch: {
            connectionScope: "supervision",
            supervisionSourceThreadId: "native-source",
            conversationSourceTransferComplete: true,
            model: "native-model",
            modelProvider: "native-provider",
          },
        });
      }
      return withLease(identity, run);
    });
    const execute = vi.fn<Parameters<typeof withCodexThreadLifecycleBinding>[1]>(
      async (_identity, binding) => {
        if (!binding) {
          throw new Error("native execution received no binding");
        }
        return { ...binding, lifecycle: { action: "resumed" } };
      },
    );
    const operation = withCodexThreadLifecycleBinding(
      {
        params,
        bindingStore,
        client: {} as never,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: resolveCodexAppServerRuntimeOptions({ env: {}, requirementsToml: null }),
      },
      execute,
    );

    if (state === "preserved") {
      await expect(operation).resolves.toMatchObject({ preserveNativeModel: true });
      expect(execute).toHaveBeenCalledOnce();
    } else {
      await expect(operation).rejects.toMatchObject({ name: "AgentHarnessPreflightError" });
      expect(execute).not.toHaveBeenCalled();
    }
  },
);

it.each(["local", "loopback-server", "ordinary-unix-server", "remote-server", "sandbox"])(
  "handles an installation target for %s execution before native startup",
  async (placement) => {
    const sessionFile = path.join(tempDir, "installation-target.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-installation-target"));
    const createToolSurfaceAsync = vi.fn(params.hostCapabilities.createToolSurfaceAsync);
    const localProcessEnv = Object.freeze({
      OPENCLAW_STATE_DIR: "/fixture/diagnosed",
      OPENCLAW_CONFIG_PATH: "/fixture/custom.json",
      OPENCLAW_WORKSPACE_DIR: "/fixture/default-workspace",
    });
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      createToolSurfaceAsync,
      preparedEnvironment: () => ({
        credentialScrubEnv: {},
        localIdentityEnv: {},
        managedLocalIdentity: false,
        localProcessEnv: placement.startsWith("ordinary-") ? undefined : localProcessEnv,
      }),
    });
    if (placement === "sandbox") {
      params.sandbox = createSandboxContext({});
    }
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
    const options = {
      bindingStore: testCodexAppServerBindingStore,
      ...(placement.endsWith("-server") ? placementOptions(placement) : {}),
    };
    const pending = prepareCodexAttemptConnection({ params, options });
    if (placement !== "local" && !placement.startsWith("ordinary-")) {
      await expect(pending).rejects.toThrow("saved prompt");
      const clientFactory = vi.fn(async () => {
        throw new Error("unexpected app-server admission");
      });
      await expect(runCodexAppServerAttempt(params, { ...options, clientFactory })).rejects.toThrow(
        /owned local Codex stdio.*saved prompt/,
      );
      expect(clientFactory).not.toHaveBeenCalled();
      expect(createToolSurfaceAsync).not.toHaveBeenCalled();
      return;
    }
    const connection = await pending;
    using _ = bindingCustody(connection);
    if (placement.startsWith("ordinary-")) {
      expect(connection.appServer.start.transport).toBe("unix");
      expect(connection.shellEnvironment).toBeUndefined();
      expect(connection.appServer.start.env ?? {}).not.toHaveProperty("OPENCLAW_STATE_DIR");
      expect(connection.disableLoginShell).toBe(false);
      return;
    }
    expect(connection.appServer.start.transport).toBe("stdio");
    expect(connection.shellEnvironment).toEqual(localProcessEnv);
    expect(connection.appServer.start.env).toMatchObject(localProcessEnv);
    expect(connection.disableLoginShell).toBe(true);
  },
);

it("disables login shells for custom credential scrub overlays", async () => {
  const params = connectionParams(
    "native-local-custom-scrub",
    "workspace-native-local-custom-scrub",
  );
  params.hostCapabilities = Object.freeze({
    ...params.hostCapabilities,
    preparedEnvironment: () =>
      Object.freeze({
        credentialScrubEnv: Object.freeze({ PREVIEW_STORE_TOKEN: "" }),
        localIdentityEnv: Object.freeze({}),
        managedLocalIdentity: false,
      }),
  });

  using connection = await prepareConnection(params);

  expect(connection.shellEnvironment).toEqual({ PREVIEW_STORE_TOKEN: "" });
  expect(connection.disableLoginShell).toBe(true);
});

it.each(["local", "sandbox", "remote"] as const)(
  "projects managed identity only to local execution: %s",
  async (location) => {
    const params = connectionParams(`${location}-process-env`, `workspace-${location}-process-env`);
    const credentialScrubEnv = { GH_TOKEN: "", GITHUB_TOKEN: "", PREVIEW_SERVICE_TOKEN: "" };
    const localIdentityEnv = {
      GH_CONFIG_DIR: "/private/managed-gh",
      GIT_AUTHOR_NAME: "Managed Author",
      GIT_AUTHOR_EMAIL: "managed@example.test",
      GIT_COMMITTER_NAME: "Managed Committer",
      GIT_COMMITTER_EMAIL: "committer@example.test",
    };
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      preparedEnvironment: () =>
        Object.freeze({
          credentialScrubEnv: Object.freeze(credentialScrubEnv),
          localIdentityEnv: Object.freeze(localIdentityEnv),
          localToolEnv: Object.freeze({ PATH: "/fixture/tools:/fixture/system" }),
          managedLocalIdentity: true,
        }),
    });
    if (location !== "local") {
      params.sandbox = {
        ...createSandboxContext({}),
        ...(location === "remote" ? { placementExecutionMode: "remote-exec" } : {}),
      } as NonNullable<typeof params.sandbox>;
    }
    if (location === "remote") {
      prepareAuth(params, "gpt-5.6-luna");
    }

    using connection = await prepareConnection(params);

    expect(connection.shellEnvironment).toEqual({
      ...credentialScrubEnv,
      ...(location === "local" ? localIdentityEnv : {}),
      ...(location === "local" ? { PATH: "/fixture/tools:/fixture/system" } : {}),
    });
    expect(connection.appServer.start.env).toMatchObject(connection.shellEnvironment!);
    if (location !== "local") {
      expect(connection.shellEnvironment).not.toHaveProperty("PATH");
      for (const key of Object.keys(localIdentityEnv)) {
        expect(connection.appServer.start.env).not.toHaveProperty(key);
      }
    }
    expect(connection.disableLoginShell).toBe(true);
  },
);

it.each([
  {
    name: "paired-device remote execution",
    placement: { placementExecutionMode: "remote-exec", placementNodeId: "paired-device-1" },
    expectedFactory: createIsolatedCodexAppServerClient,
  },
  {
    name: "local sandbox execution",
    placement: {},
    expectedFactory: getLeasedSharedCodexAppServerClient,
  },
])("selects the correct app-server ownership for $name", async ({ placement, expectedFactory }) => {
  const sessionFile = path.join(
    tempDir,
    `client-ownership-${placement.placementNodeId ?? "other"}.jsonl`,
  );
  const workspaceDir = path.join(
    tempDir,
    `workspace-client-ownership-${placement.placementNodeId ?? "other"}`,
  );
  const params = createParams(sessionFile, workspaceDir);
  params.sandbox = { ...createSandboxContext({}), ...placement } as NonNullable<
    typeof params.sandbox
  >;
  if (placement.placementExecutionMode === "remote-exec") {
    prepareAuth(params, "gpt-5.4-codex");
  }
  registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

  using connection = await prepareConnection(params);

  expect(connection.attemptClientFactory).toBe(expectedFactory);
});

it("keeps a user-home subscription on native account verification", async () => {
  const params = connectionParams("user-home-native-auth", "workspace-user-home-native-auth");
  prepareAuth(params, "gpt-5.4-codex", true).forwardedAuthProfileId = "openai:unusable";
  params.authProfileStore = {
    version: 1,
    profiles: {
      "openai:unusable": { type: "api_key", provider: "openai", key: "" },
    },
  };

  using connection = await prepareConnection(params, {
    pluginConfig: { appServer: { homeScope: "user" } },
  });
  const request = vi.fn(async (_method: string, _params?: unknown) => ({
    account: { type: "chatgpt" },
  }));

  expect(connection).toMatchObject({
    startupAuthProfileId: undefined,
    startupPreparedAuth: undefined,
    startupClientAuthProfileId: null,
  });
  await expect(
    applyCodexAppServerAuthProfile({
      client: { request } as never,
      agentDir: connection.agentDir,
      authProfileId: connection.startupClientAuthProfileId,
      authRequirement: connection.startupAuthRequirement,
    }),
  ).resolves.toBeUndefined();
  expect(
    request.mock.calls.map(([method, requestParams]) => ({ method, params: requestParams })),
  ).toEqual([{ method: "account/read", params: { refreshToken: false } }]);
});

it("re-resolves model and connection policy when an oversized thread rotates", async () => {
  const params = await oversizedThread();

  const resolveConnection = vi.spyOn(bindingConnection, "resolveCodexBindingAppServerConnection");
  const resolveModelPolicy = vi.spyOn(appServerPolicy, "resolveCodexAppServerForModelProvider");

  using connection = await prepareConnection(params);

  expect(connection.mutable.startupBinding).toBeUndefined();
  expect(resolveConnection).toHaveBeenCalledTimes(2);
  expect(resolveModelPolicy).toHaveBeenCalledTimes(2);
});

it.each(["during rotation", "after rejection"] as const)(
  "releases a failed connection's abort listener when cancelled %s",
  async (cancelAt) => {
    const params = await oversizedThread();
    const controller = new AbortController();
    params.abortSignal = controller.signal;
    params.onAttemptAbort = vi.fn();
    const upstreamListeners = getEventListeners(controller.signal, "abort").length;
    const rotationError = new Error("synthetic startup binding mutation failure");
    const mutate = vi
      .spyOn(testCodexAppServerBindingStore, "mutate")
      .mockImplementationOnce(async () => {
        if (cancelAt === "during rotation") {
          controller.abort("cancelled during rotation");
          expect(params.onAttemptAbort).toHaveBeenCalledTimes(1);
        }
        throw rotationError;
      });

    try {
      await expect(prepareConnection(params)).rejects.toBe(rotationError);
      expect(mutate).toHaveBeenCalledWith(
        expect.anything(),
        { kind: "clear", threadId: "thread-existing" },
        expect.any(Function),
        expect.objectContaining({ withCurrent: expect.any(Function) }),
      );
      const remainingListeners = getEventListeners(controller.signal, "abort").length;
      controller.abort("cancelled after rejection");
      expect({
        remainingListeners,
        abortNotifications: vi.mocked(params.onAttemptAbort).mock.calls.length,
      }).toEqual({
        remainingListeners: upstreamListeners,
        abortNotifications: cancelAt === "during rotation" ? 1 : 0,
      });
    } finally {
      controller.abort("test cleanup");
    }
  },
);

it("rejects the retired explicit untrusted approval policy with Doctor remediation", async () => {
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
  );
  const params = connectionParams("explicit-approval-policy", "workspace-explicit-approval-policy");
  params.agentDir = path.join(tempDir, "agent");

  await expect(
    prepareConnection(params, {
      pluginConfig: { appServer: { approvalPolicy: "untrusted" } },
    }),
  ).rejects.toThrow(
    'plugins.entries.codex.config.appServer.approvalPolicy="untrusted" is retired; run "openclaw doctor --fix" to migrate it to "on-request".',
  );
});

it("defaults a rootless workspace session boundary while overriding full exec", async () => {
  const params = policyParams("workspace-session-policy", "workspace", "auto");
  const { workspaceDir } = params;
  delete params.sessionRoot;
  params.config = { tools: { exec: { mode: "full" } } };

  const resolveConnection = vi.spyOn(bindingConnection, "resolveCodexBindingAppServerConnection");
  using connection = await prepareConnection(params);

  expect(resolveConnection).toHaveBeenCalledWith(
    expect.objectContaining({ execPolicy: expect.objectContaining({ mode: "auto" }) }),
  );
  expect(connection.appServer).toMatchObject({
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    sessionRoot: workspaceDir,
  });
  expect(connection.effectiveCwd).toBe(workspaceDir);
});

it("keeps a full session mode on never when a before_tool_call hook is present", async () => {
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
  );
  const params = policyParams("full-session-hook-policy", "full");

  using connection = await prepareConnection(params);

  // Upstream 28f10c00b4e keeps YOLO approvals disabled despite generic tool hooks.
  expect(connection.appServer.approvalPolicy).toBe("never");
});

it("rejects native execution denied by the retained global policy owner", async () => {
  const workspaceDir = path.join(tempDir, "policy-workspace");
  const sessionFile = path.join(tempDir, "policy-session.jsonl");
  const params = createParams(sessionFile, workspaceDir);
  params.agentId = "main";
  params.agentDir = path.join(tempDir, "main-agent");
  params.sandboxSessionKey = "global";
  params.sandboxAgentId = "policy";
  params.config = {
    agents: {
      entries: {
        main: {},
        policy: { tools: { exec: { mode: "deny" } } },
      },
    },
  };
  registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

  await expect(prepareConnection(params)).rejects.toThrow("effective tools.exec.mode=deny");
});

it("prepares one Guardian policy when requirements clamp an explicitly full session", async () => {
  vi.mocked(codexRequirements.readCodexRequirementsToml).mockReturnValue(
    [
      'allowed_sandbox_modes = ["workspace-write"]',
      'allowed_approval_policies = ["on-request"]',
      'allowed_approvals_reviewers = ["auto_review"]',
    ].join("\n"),
  );
  const params = policyParams("requirements-clamped-workspace", "full", "full");
  const { workspaceDir } = params;
  params.provider = "openai";

  using connection = await prepareConnection(params);

  expect(connection.appServer).toMatchObject({
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
  });
  expect(connection.sessionPermissionPolicy).toEqual({
    mode: "workspace",
    root: workspaceDir,
    execMode: "auto",
  });
  expect(params).toMatchObject({
    permissionMode: "workspace",
    sessionRoot: workspaceDir,
    execOverrides: { mode: "auto" },
  });
});

it.each([
  { permissionMode: "read-only" as const, execMode: "deny" as const },
  { permissionMode: "guarded" as const, execMode: "ask" as const },
])(
  "does not preflight-kill a $permissionMode session mode for denied global exec",
  async ({ permissionMode, execMode }) => {
    const params = policyParams(`${permissionMode}-session-policy`, permissionMode, execMode);
    params.config = { tools: { exec: { mode: "deny" } } };
    const resolveConnection = vi.spyOn(bindingConnection, "resolveCodexBindingAppServerConnection");

    using connection = await prepareConnection(params);

    expect(connection).toBeDefined();
    expect(resolveConnection).toHaveBeenCalledWith(
      expect.objectContaining({ execPolicy: expect.objectContaining({ mode: execMode }) }),
    );
  },
);
