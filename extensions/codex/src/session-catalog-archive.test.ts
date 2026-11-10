import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
/* oxlint-disable typescript/unbound-method -- assertions inspect vi.fn-backed object methods, not unbound class methods. */
import { expect, it, vi } from "vitest";
import type { CodexThreadListParams } from "./app-server/protocol.js";
import {
  commandRpcMocks,
  pinnedConnectionMocks,
  createCodexSessionCatalogControl,
  createCodexSessionCatalogControlFactory,
  continueLocalCodexSession,
  registerCodexSessionCatalog,
  config,
  compatibilityOwnerConfig,
  idleThread,
  createEligibleControl,
  createRuntime,
  archiveTestSession,
  createGatewayApi,
  resolveDefaultAgentDir,
  withEnvAsync,
  createCodexTestBindingStore,
  CODEX_LOCAL_SESSION_HOST_ID,
  type OpenClawConfig,
} from "./session-catalog.test-helpers.js";

async function expectArchiveBlocked(
  control: ReturnType<typeof createEligibleControl>,
  error: string,
  bindingStore?: ReturnType<typeof createCodexTestBindingStore>,
) {
  await expect(archiveTestSession({ control, bindingStore })).rejects.toThrow(error);
  expect(control.archiveThread).not.toHaveBeenCalled();
}

async function warmCatalog(control: ReturnType<typeof createCodexSessionCatalogControl>) {
  commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [idleThread({ source: "cli" })] });
  await control.initialize();
  commandRpcMocks.codexControlRequest.mockClear();
}

async function bindOwner(
  threadId: string,
  bindingId: string,
  bindingStore = createCodexTestBindingStore(),
) {
  await bindingStore.mutate(
    { kind: "conversation", bindingId },
    { kind: "set", binding: { threadId, cwd: "/workspace/project" } },
  );
  return bindingStore;
}

function pinnedRequests(handlers: Record<string, (params?: Record<string, unknown>) => unknown>) {
  pinnedConnectionMocks.request.mockImplementation(
    async (request: { method: string; requestParams?: Record<string, unknown> }) => {
      const handler = handlers[request.method];
      if (!handler) {
        throw new Error(`unexpected method: ${request.method}`);
      }
      return handler(request.requestParams);
    },
  );
}

it("rechecks status after eligibility and rejects active local sessions before either mutation", async () => {
  const { runtime, createSessionEntry } = createRuntime();
  const { api } = createGatewayApi(runtime);
  const bindingStore = createCodexTestBindingStore();
  const control = createEligibleControl({
    readThread: vi.fn(async () =>
      idleThread({ status: { type: "active", activeFlags: ["waitingOnApproval"] } }),
    ),
  });

  await expect(
    continueLocalCodexSession({ api, bindingStore, config, control, threadId: "thread-1" }),
  ).rejects.toThrow("active in this App Server");
  await expect(archiveTestSession({ control, bindingStore, runtime })).rejects.toThrow(
    "active in this App Server",
  );
  expect(createSessionEntry).not.toHaveBeenCalled();
  expect(control.archiveThread).not.toHaveBeenCalled();
  expect(control.readThread).toHaveBeenNthCalledWith(1, "thread-1", true);
  expect(control.readThread).toHaveBeenNthCalledWith(2, "thread-1", false);
  expect(control.requireEligibleThread).toHaveBeenCalledWith("thread-1");
});

it("pins one App Server connection while archive configuration changes live", async () => {
  let pluginConfig: unknown = {
    appServer: { command: "codex-archive-a" },
    supervision: { enabled: true },
  };
  const initialRuntimeConfig = compatibilityOwnerConfig();
  const expectedAgentDir = resolveDefaultAgentDir(initialRuntimeConfig);
  let runtimeConfig = initialRuntimeConfig;
  pinnedRequests({
    "thread/read": () => {
      pluginConfig = {
        appServer: { command: "codex-archive-b", homeScope: "agent" },
        supervision: { enabled: false },
      };
      runtimeConfig = { agents: { defaults: { workspace: "/workspace/b" } } } as OpenClawConfig;
      return { thread: idleThread({ source: "cli" }) };
    },
    "thread/list": (params) => ({
      data: params?.ancestorThreadId === undefined ? [idleThread({ source: "cli" })] : [],
    }),
    "thread/archive": () => ({}),
  });
  const control = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => pluginConfig,
    getRuntimeConfig: () => runtimeConfig,
  }).forRequest("alpha");

  await warmCatalog(control);
  await expect(
    archiveTestSession({ agentId: "alpha", config: initialRuntimeConfig, control }),
  ).resolves.toEqual({ archived: true });

  expect(pinnedConnectionMocks.getClient).toHaveBeenCalledOnce();
  const acquisition = pinnedConnectionMocks.getClient.mock.calls[0]?.[0];
  expect(acquisition).toMatchObject({
    agentDir: expectedAgentDir,
    startOptions: { command: "codex-archive-a", homeScope: "user" },
    config: initialRuntimeConfig,
  });
  for (const [request] of pinnedConnectionMocks.request.mock.calls) {
    expect(request.client).toBe(pinnedConnectionMocks.client);
    expect(request.config).toBe(acquisition?.config);
  }
  expect(pinnedConnectionMocks.releaseClient).toHaveBeenCalledWith(pinnedConnectionMocks.client);
  expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
});

it("refuses archive when current membership contains only another thread", async () => {
  pinnedRequests({
    "thread/read": () => ({ thread: idleThread({ source: "cli" }) }),
    "thread/list": (params) => {
      expect(params).toMatchObject({ archived: false });
      return { data: [idleThread({ id: "other-thread", source: "cli" })] };
    },
  });
  const control = createCodexSessionCatalogControl({
    getPluginConfig: () => ({ supervision: { enabled: true } }),
    getRuntimeConfig: () => config,
  });
  await warmCatalog(control);

  await expect(archiveTestSession({ control })).rejects.toThrow(
    "Codex session eligibility could not be verified",
  );
  expect(pinnedConnectionMocks.releaseClient).toHaveBeenCalledWith(pinnedConnectionMocks.client);
});

it.each([
  ["owned parent", "thread-1", "attached to an OpenClaw session"],
  ["owned archived descendant", "descendant", "spawned descendant is owned by an OpenClaw session"],
  ["active archived descendant", undefined, "Codex session is active in this App Server"],
] as const)("rejects archive of an %s", async (_name, ownedThread, error) => {
  const bindingStore = ownedThread
    ? await bindOwner(ownedThread, "bound-chat")
    : createCodexTestBindingStore();
  const control = createEligibleControl({
    listDescendantPage: vi.fn(async ({ archived, cursor }) =>
      !archived
        ? { data: [] }
        : {
            data: [idleThread({ id: cursor ? "descendant" : "unowned-descendant" })],
            ...(cursor ? {} : { nextCursor: "descendants-2" }),
          },
    ),
    readThread: vi.fn(async (id: string) =>
      idleThread({
        id,
        status: { type: !ownedThread && id === "descendant" ? "active" : "idle" },
      }),
    ),
  });
  await expectArchiveBlocked(control, error, bindingStore);
});

it("fences ownership mutations through both descendant collections and their pages", async () => {
  const bindingStore = createCodexTestBindingStore();
  const lateIdentity = { kind: "conversation" as const, bindingId: "late-descendant-owner" };
  const validating = createDeferred<void>();
  const validationReleased = createDeferred<void>();
  const listDescendantPage = vi.fn(async ({ archived, cursor }: CodexThreadListParams) => {
    if (archived) {
      validating.resolve();
      await validationReleased.promise;
    }
    return {
      data: [{ id: `idle-descendant-${archived}-${cursor ?? "first"}`, projectId: null }],
      ...(cursor ? {} : { nextCursor: "next" }),
    };
  });
  const control = createEligibleControl({ listDescendantPage });

  const archiving = archiveTestSession({ bindingStore, control });
  await validating.promise;
  await expect(bindOwner("late-descendant", lateIdentity.bindingId, bindingStore)).rejects.toThrow(
    "native archive is in progress",
  );
  validationReleased.resolve();
  await expect(archiving).resolves.toEqual({ archived: true });
  expect(bindingStore.read(lateIdentity)).toBeUndefined();
  for (const id of ["false-first", "false-next", "true-first", "true-next"]) {
    expect(control.readThread).toHaveBeenCalledWith(`idle-descendant-${id}`, false);
  }
  expect(control.archiveThread).toHaveBeenCalledWith("thread-1");
});

it.each([
  [{ data: [], nextCursor: "cycle" }, "repeated descendant-list cursor", 2],
  [{ data: [idleThread({ id: "thread-1" })] }, "cyclic descendant thread list", 1],
  [{ data: null }, "invalid descendant-list response", 1],
] as const)("fails closed on descendant response %j (%s)", async (response, error, calls) => {
  const control = createEligibleControl({
    listDescendantPage: vi.fn(async () => response as never),
  });

  await expectArchiveBlocked(control, error);
  expect(control.listDescendantPage).toHaveBeenCalledTimes(calls);
});

it("shares the descendant page cap across both archive collections", async () => {
  let page = 0;
  const control = createEligibleControl({
    listDescendantPage: vi.fn(async ({ archived }) => {
      page += 1;
      if (!archived) {
        return { data: [] };
      }
      return {
        data: [idleThread({ id: `descendant-${page}` })],
        nextCursor: `descendants-${page}`,
      };
    }),
  });

  await expectArchiveBlocked(control, "descendant enumeration exceeded its safety limit");
  expect(control.listDescendantPage).toHaveBeenCalledTimes(100);
});

it("registers generic actions and keeps paired-node archive view-only", async () => {
  const { runtime, createSessionEntry } = createRuntime();
  const { api, getProvider, registerSessionCatalog } = createGatewayApi(runtime);
  const control = createEligibleControl();
  const processFallbackControl = {
    hasActiveWork: () => false,
    disconnect: async () => {},
    forRequest: () => control,
    forNode: async () => {
      throw new Error("Node source is outside this local archive fixture");
    },
    homesForAgent: async () => [
      {
        assertCurrent: vi.fn(),
        hostId: CODEX_LOCAL_SESSION_HOST_ID,
        sourceHomeId: "process-home",
        usesProcessHomeFallback: true,
      } as never,
    ],
    forUpstream: async () => undefined,
  };
  registerCodexSessionCatalog({
    api,
    bindingStore: createCodexTestBindingStore(),
    control: processFallbackControl,
    getRuntimeConfig: () => config,
  });
  expect(registerSessionCatalog).toHaveBeenCalledOnce();
  const provider = getProvider();
  const localSource = { hostId: CODEX_LOCAL_SESSION_HOST_ID, threadId: "thread-1" };
  const remoteSource = {
    allowProcessHomeFallback: false,
    hostId: "node:devbox",
    threadId: "thread-remote",
  };
  const isolated = { ...localSource, allowProcessHomeFallback: false };
  const archive = (source: typeof localSource) =>
    provider?.archive?.({ ...source, confirmNoOtherRunner: true });
  await withEnvAsync({ CODEX_HOME: undefined }, async () => {
    for (const operation of [
      () => provider?.continueSession?.({ ...isolated, clientScopes: ["operator.admin"] }),
      () => archive(isolated),
      () => provider?.openTerminal?.(isolated),
      () =>
        provider?.startTerminalSession?.({
          allowProcessHomeFallback: false,
          agentId: "main",
          cwd: process.cwd(),
        }),
    ]) {
      await expect(operation()).rejects.toThrow(
        "local Codex sessions are unavailable in isolated state",
      );
    }
  });
  await expect(
    provider?.archive?.({
      ...localSource,
      confirmNoOtherRunner: false,
    } as never),
  ).rejects.toThrow("requires confirmation");
  await expect(archive(localSource)).resolves.toEqual({ ok: true });
  await expect(archive(remoteSource)).rejects.toThrow("paired-node Codex sessions are view-only");
  await expect(
    provider?.continueSession?.({ ...remoteSource, clientScopes: ["operator.admin"] }),
  ).rejects.toThrow("paired node does not permit Codex session continuation");
  expect(control.requireEligibleThread).toHaveBeenCalledOnce();
  expect(control.archiveThread).toHaveBeenCalledOnce();
  expect(createSessionEntry).not.toHaveBeenCalled();
});
