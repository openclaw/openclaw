import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
// Codex supervision tests cover passive listing and safe local session takeover.
/* oxlint-disable typescript/unbound-method -- assertions inspect vi.fn-backed object methods, not unbound class methods. */
import { describe, expect, it, vi } from "vitest";
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

describe("Codex supervision actions", () => {
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
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control,
        threadId: "thread-1",
      }),
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
    pinnedConnectionMocks.request.mockImplementation(
      async (request: { method: string; requestParams?: Record<string, unknown> }) => {
        if (request.method === "thread/read") {
          pluginConfig = {
            appServer: { command: "codex-archive-b", homeScope: "agent" },
            supervision: { enabled: false },
          };
          runtimeConfig = {
            agents: { defaults: { workspace: "/workspace/b" } },
          } as OpenClawConfig;
          return { thread: idleThread({ source: "cli" }) };
        }
        if (request.method === "thread/list") {
          return {
            data:
              request.requestParams?.ancestorThreadId === undefined
                ? [idleThread({ source: "cli" })]
                : [],
          };
        }
        if (request.method === "thread/archive") {
          return {};
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    );
    const control = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => runtimeConfig,
    }).forRequest("alpha");

    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ source: "cli" })],
    });
    await control.initialize();
    commandRpcMocks.codexControlRequest.mockClear();
    await expect(
      archiveTestSession({ agentId: "alpha", config: initialRuntimeConfig, control }),
    ).resolves.toEqual({
      archived: true,
    });

    expect(pinnedConnectionMocks.getClient).toHaveBeenCalledOnce();
    const acquisition = pinnedConnectionMocks.getClient.mock.calls[0]?.[0];
    expect(acquisition).toMatchObject({
      agentDir: expectedAgentDir,
      startOptions: expect.objectContaining({ command: "codex-archive-a", homeScope: "user" }),
      config: initialRuntimeConfig,
    });
    expect(pinnedConnectionMocks.request.mock.calls.map(([request]) => request.method)).toEqual([
      "thread/read",
      "thread/list",
      "thread/read",
      "thread/list",
      "thread/list",
      "thread/archive",
    ]);
    for (const [request] of pinnedConnectionMocks.request.mock.calls) {
      expect(request.client).toBe(pinnedConnectionMocks.client);
      expect(request.config).toBe(acquisition?.config);
    }
    expect(pinnedConnectionMocks.releaseClient).toHaveBeenCalledWith(pinnedConnectionMocks.client);
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
  });

  it("refuses archive when current membership contains only another thread", async () => {
    pinnedConnectionMocks.request.mockImplementation(async (request: { method: string }) => {
      if (request.method === "thread/read") {
        return { thread: idleThread({ source: "cli" }) };
      }
      if (request.method === "thread/list") {
        return { data: [idleThread({ id: "other-thread", source: "cli" })] };
      }
      throw new Error(`unexpected method: ${request.method}`);
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    });
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ source: "cli" })],
    });
    await control.initialize();
    commandRpcMocks.codexControlRequest.mockClear();

    await expect(archiveTestSession({ control })).rejects.toThrow(
      "Codex session eligibility could not be verified",
    );
    expect(pinnedConnectionMocks.request.mock.calls.map(([request]) => request.method)).toEqual([
      "thread/read",
      "thread/list",
    ]);
    expect(pinnedConnectionMocks.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "thread/list",
        requestParams: expect.objectContaining({ archived: false }),
      }),
    );
    expect(pinnedConnectionMocks.releaseClient).toHaveBeenCalledWith(pinnedConnectionMocks.client);
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
  });

  it("rejects archive while another OpenClaw session owns the native thread", async () => {
    const bindingStore = createCodexTestBindingStore();
    await bindingStore.mutate(
      { kind: "conversation", bindingId: "bound-chat" },
      {
        kind: "set",
        binding: { threadId: "thread-1", cwd: "/workspace/project" },
      },
    );
    const control = createEligibleControl();

    await expectArchiveBlocked(control, "attached to an OpenClaw session", bindingStore);
    expect(control.requireEligibleThread).toHaveBeenCalledWith("thread-1");
  });

  it("rejects archive when a paginated archived descendant has an OpenClaw owner", async () => {
    const bindingStore = createCodexTestBindingStore();
    await bindingStore.mutate(
      { kind: "conversation", bindingId: "descendant-chat" },
      {
        kind: "set",
        binding: { threadId: "owned-descendant", cwd: "/workspace/project" },
      },
    );
    const control = createEligibleControl({
      listDescendantPage: vi.fn(async (params) =>
        !params.archived
          ? { data: [] }
          : params.cursor === "descendants-2"
            ? { data: [idleThread({ id: "owned-descendant" })] }
            : {
                data: [idleThread({ id: "unowned-descendant" })],
                nextCursor: "descendants-2",
              },
      ),
    });

    await expectArchiveBlocked(
      control,
      "spawned descendant is owned by an OpenClaw session",
      bindingStore,
    );
    expect(control.listDescendantPage).toHaveBeenCalledWith({
      ancestorThreadId: "thread-1",
      archived: true,
      limit: 100,
      sortKey: "created_at",
      sortDirection: "desc",
      useStateDbOnly: true,
    });
    expect(control.listDescendantPage).toHaveBeenCalledWith(
      expect.objectContaining({ archived: true, cursor: "descendants-2" }),
    );
  });

  it("rejects archive when an archived spawned descendant is active", async () => {
    const control = createEligibleControl({
      listDescendantPage: vi.fn(async (params) => ({
        data: params.archived ? [{ id: "active-descendant", projectId: null }] : [],
      })),
      readThread: vi.fn(async (threadId: string) =>
        idleThread({
          id: threadId,
          status: threadId === "active-descendant" ? { type: "active" } : { type: "idle" },
        }),
      ),
    });

    await expectArchiveBlocked(control, "Codex session is active in this App Server");
    expect(control.readThread).toHaveBeenCalledWith("active-descendant", false);
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
    await expect(
      bindingStore.mutate(lateIdentity, {
        kind: "set",
        binding: { threadId: "late-descendant", cwd: "/workspace/project" },
      }),
    ).rejects.toThrow("native archive is in progress");
    validationReleased.resolve();
    await expect(archiving).resolves.toEqual({ archived: true });
    expect(bindingStore.read(lateIdentity)).toBeUndefined();
    expect(control.readThread).toHaveBeenCalledWith("idle-descendant-false-first", false);
    expect(control.readThread).toHaveBeenCalledWith("idle-descendant-false-next", false);
    expect(control.readThread).toHaveBeenCalledWith("idle-descendant-true-first", false);
    expect(control.readThread).toHaveBeenCalledWith("idle-descendant-true-next", false);
    expect(control.archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it.each([
    {
      name: "a repeated cursor",
      response: { data: [], nextCursor: "cycle" },
      error: "repeated descendant-list cursor",
      calls: 2,
    },
    {
      name: "the ancestor as its own descendant",
      response: { data: [idleThread({ id: "thread-1" })] },
      error: "cyclic descendant thread list",
      calls: 1,
    },
    {
      name: "an invalid response",
      response: { data: null },
      error: "invalid descendant-list response",
      calls: 1,
    },
  ])(
    "fails closed when descendant enumeration returns $name",
    async ({ response, error, calls }) => {
      const control = createEligibleControl({
        listDescendantPage: vi.fn(async () => response as never),
      });

      await expectArchiveBlocked(control, error);
      expect(control.listDescendantPage).toHaveBeenCalledTimes(calls);
    },
  );

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
    expect(provider?.resolveCreateSession?.({ agentId: "main" })).toEqual({
      model: "openai/gpt-6-astra",
      agentRuntime: "codex",
    });
    await withEnvAsync({ CODEX_HOME: undefined }, async () => {
      await expect(
        provider?.continueSession?.({
          allowProcessHomeFallback: false,
          ...localSource,
          clientScopes: ["operator.admin"],
        }),
      ).rejects.toThrow("local Codex sessions are unavailable in isolated state");
      await expect(
        provider?.archive?.({
          allowProcessHomeFallback: false,
          ...localSource,
          confirmNoOtherRunner: true,
        }),
      ).rejects.toThrow("local Codex sessions are unavailable in isolated state");
      await expect(
        provider?.openTerminal?.({
          allowProcessHomeFallback: false,
          ...localSource,
        }),
      ).rejects.toThrow("local Codex sessions are unavailable in isolated state");
      await expect(
        provider?.startTerminalSession?.({
          allowProcessHomeFallback: false,
          agentId: "main",
          cwd: process.cwd(),
        }),
      ).rejects.toThrow("local Codex sessions are unavailable in isolated state");
    });
    await expect(
      provider?.archive?.({
        ...localSource,
        confirmNoOtherRunner: false,
      } as never),
    ).rejects.toThrow("requires confirmation");
    await expect(
      provider?.archive?.({
        ...localSource,
        confirmNoOtherRunner: true,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      provider?.archive?.({
        ...remoteSource,
        confirmNoOtherRunner: true,
      }),
    ).rejects.toThrow("paired-node Codex sessions are view-only");
    await expect(
      provider?.continueSession?.({
        ...remoteSource,
        clientScopes: ["operator.admin"],
      }),
    ).rejects.toThrow("paired node does not permit Codex session continuation");
    expect(control.requireEligibleThread).toHaveBeenCalledOnce();
    expect(control.archiveThread).toHaveBeenCalledOnce();
    expect(createSessionEntry).not.toHaveBeenCalled();
  });
});
