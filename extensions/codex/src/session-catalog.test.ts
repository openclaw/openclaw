// Codex supervision tests cover passive listing and safe local session takeover.
import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexThread } from "./app-server/protocol.js";
import { sessionBindingIdentity } from "./app-server/session-binding.js";
import {
  createCodexTestBindingStore,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./app-server/session-binding.test-helpers.js";
import {
  archiveLocalCodexSession,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_LOCAL_SESSION_HOST_ID,
  CODEX_SESSION_ARCHIVE_METHOD,
  CODEX_SESSION_CATALOG_METHOD,
  CODEX_SESSION_CONTINUE_METHOD,
  continueLocalCodexSession,
  createCodexSessionCatalogControl,
  createCodexSessionCatalogNodeHostCommands,
  listCodexSessionCatalog,
  registerCodexSessionCatalogGateway,
  type CodexSessionCatalogControl,
} from "./session-catalog.js";

const commandRpcMocks = vi.hoisted(() => ({
  codexControlRequest: vi.fn(),
}));
const transcriptMirrorMocks = vi.hoisted(() => ({
  importCodexThreadHistoryToTranscript: vi.fn(async () => ({
    importedMessages: 0,
    omittedMessages: 0,
  })),
}));

vi.mock("./command-rpc.js", () => ({
  codexControlRequest: commandRpcMocks.codexControlRequest,
}));
vi.mock("./app-server/transcript-mirror.js", () => ({
  importCodexThreadHistoryToTranscript: transcriptMirrorMocks.importCodexThreadHistoryToTranscript,
}));

type CreateSessionEntryParams = Parameters<
  PluginRuntime["agent"]["session"]["createSessionEntry"]
>[0];
type CreateSessionEntryResult = Awaited<
  ReturnType<PluginRuntime["agent"]["session"]["createSessionEntry"]>
>;
type SessionEntrySummary = ReturnType<
  PluginRuntime["agent"]["session"]["listSessionEntries"]
>[number];
type GatewayHandler = (options: GatewayRequestHandlerOptions) => void | Promise<void>;

const config = {} as OpenClawConfig;

function idleThread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    id: "thread-1",
    name: "Continue native task",
    cwd: "/workspace/project",
    status: { type: "idle" },
    ...overrides,
  };
}

function createControl(overrides: Partial<CodexSessionCatalogControl> = {}) {
  return {
    listPage: vi.fn(async () => ({ sessions: [] })),
    readThread: vi.fn(async () => idleThread()),
    archiveThread: vi.fn(async () => undefined),
    ...overrides,
  } satisfies CodexSessionCatalogControl;
}

function createEligibleControl(overrides: Partial<CodexSessionCatalogControl> = {}) {
  return createControl({
    listPage: vi.fn(async () => ({
      sessions: [{ threadId: "thread-1", status: "idle", source: "cli", archived: false as const }],
    })),
    ...overrides,
  });
}

function adoptedEntry(params: { sourceThreadId: string; sessionId?: string }) {
  return {
    sessionId: params.sessionId ?? "openclaw-session-existing",
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    pluginExtensions: {
      codex: {
        supervision: {
          sourceThreadId: params.sourceThreadId,
          modelLocked: true,
        },
      },
    },
  } as CreateSessionEntryResult["entry"];
}

function supervisionSessionKey(threadId: string): string {
  return `codex-supervision:${createHash("sha256").update(threadId).digest("hex")}`;
}

async function seedSupervisionBinding(params: {
  bindingStore: CodexAppServerBindingStore;
  sessionId: string;
  sessionKey: string;
  sourceThreadId: string;
  pending?: boolean;
}): Promise<void> {
  const binding: CodexAppServerThreadBinding = {
    threadId: params.pending ? params.sourceThreadId : `${params.sourceThreadId}-branch`,
    connectionScope: "supervision",
    supervisionSourceThreadId: params.sourceThreadId,
    cwd: "/workspace/project",
    conversationSourceTransferComplete: true,
    preserveNativeModel: true,
    historyCoveredThrough: new Date().toISOString(),
    ...(params.pending
      ? { pendingSupervisionBranch: { sourceThreadId: params.sourceThreadId } }
      : { model: "gpt-5.4", modelProvider: "openai" }),
  };
  const stored = await params.bindingStore.mutate(
    sessionBindingIdentity({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      config,
    }),
    { kind: "set", if: { kind: "absent" }, binding },
  );
  if (!stored) {
    throw new Error(`failed to seed supervision binding for ${params.sourceThreadId}`);
  }
}

function interruptedAdoptionEntry(params: { sourceThreadId: string; sessionId: string }) {
  return {
    sessionId: params.sessionId,
    sessionFile: `/tmp/${params.sessionId}.jsonl`,
    initializationPending: true,
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    pluginExtensions: {
      codex: {
        supervision: {
          sourceThreadId: params.sourceThreadId,
          initializing: true,
          modelLocked: true,
        },
      },
    },
  } as CreateSessionEntryResult["entry"];
}

function createRuntime(
  params: {
    entries?: SessionEntrySummary[];
    nodes?: Array<Record<string, unknown>>;
    invoke?: PluginRuntime["nodes"]["invoke"];
    failAfterCreate?: () => boolean;
  } = {},
) {
  const entries = params.entries ?? [];
  let sessionSequence = 0;
  const createSessionEntry = vi.fn(async (createParams: CreateSessionEntryParams) => {
    const key = createParams.key ?? "agent:main:created";
    const existing = entries.find((candidate) => candidate.sessionKey === key);
    let summary: SessionEntrySummary;
    if (existing) {
      const entry = existing.entry;
      const initialMatches =
        createParams.recoverMatchingInitialEntry === true &&
        entry.initializationPending === true &&
        entry.agentHarnessId === createParams.initialEntry.agentHarnessId &&
        entry.modelSelectionLocked === createParams.initialEntry.modelSelectionLocked &&
        JSON.stringify(entry.pluginExtensions) ===
          JSON.stringify(createParams.initialEntry.pluginExtensions);
      if (!initialMatches) {
        throw new Error(`Session "${key}" does not match its trusted recovery state.`);
      }
      summary = existing;
    } else {
      sessionSequence += 1;
      const sessionId = `openclaw-session-${sessionSequence}`;
      const entry = {
        sessionId,
        sessionFile: `/tmp/${sessionId}.jsonl`,
        ...createParams.initialEntry,
        ...(createParams.afterCreate ? { initializationPending: true as const } : {}),
      } as CreateSessionEntryResult["entry"];
      summary = { sessionKey: key, entry };
      entries.push(summary);
    }
    const entry = summary.entry;
    const sessionId = entry.sessionId;
    const result = { key, agentId: "main", sessionId, entry };
    try {
      const finalPatch = await createParams.afterCreate?.(result);
      if (existing && !finalPatch) {
        throw new Error("session creation recovery requires a final patch");
      }
      if (finalPatch) {
        entry.pluginExtensions = structuredClone(finalPatch.pluginExtensions);
      }
      delete entry.initializationPending;
      if (params.failAfterCreate?.() === true) {
        throw new Error("session finalization failed after binding commit");
      }
      return result;
    } catch (error) {
      const index = entries.indexOf(summary);
      if (index >= 0) {
        entries.splice(index, 1);
      }
      throw error;
    }
  });
  const runtime = {
    nodes: {
      list: vi.fn(async () => ({ nodes: params.nodes ?? [] })),
      invoke: params.invoke ?? vi.fn(async () => ({})),
    },
    agent: {
      session: {
        createSessionEntry,
        listSessionEntries: vi.fn(() => [...entries]),
      },
    },
  } as unknown as PluginRuntime;
  return { runtime, entries, createSessionEntry };
}

function createGatewayApi(runtime: PluginRuntime) {
  const handlers = new Map<string, GatewayHandler>();
  const registerControlUiDescriptor = vi.fn();
  const registerGatewayMethod = vi.fn(
    (method: string, handler: GatewayHandler, _options?: { scope?: string }) => {
      handlers.set(method, handler);
    },
  );
  const api = {
    runtime,
    session: { controls: { registerControlUiDescriptor } },
    registerGatewayMethod,
  } as unknown as OpenClawPluginApi;
  return { api, handlers, registerControlUiDescriptor, registerGatewayMethod };
}

async function callGatewayHandler(
  handler: GatewayHandler | undefined,
  params: unknown,
  respond = vi.fn(),
) {
  if (!handler) {
    throw new Error("Gateway handler was not registered");
  }
  await handler({ params, respond } as unknown as GatewayRequestHandlerOptions);
  return respond;
}

beforeEach(() => {
  commandRpcMocks.codexControlRequest.mockReset();
  transcriptMirrorMocks.importCodexThreadHistoryToTranscript.mockReset();
  transcriptMirrorMocks.importCodexThreadHistoryToTranscript.mockResolvedValue({
    importedMessages: 0,
    omittedMessages: 0,
  });
});

describe("Codex supervision catalog", () => {
  it("lists non-archived interactive threads without probing transcript previews", async () => {
    const pluginConfig = { supervision: { enabled: true } };
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [
        {
          id: "thread-title",
          name: "Match title",
          preview: "private transcript preview",
          cwd: "/workspace/one",
          status: { type: "idle" },
          source: "vscode",
        },
        {
          id: "thread-preview",
          name: "Other title",
          preview: "Match appears only in private preview text",
          status: { type: "idle" },
          source: "cli",
        },
      ],
      nextCursor: "next-page",
    });
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await expect(control.listPage({ limit: 25, searchTerm: "mAtCh" })).resolves.toEqual({
      sessions: [
        {
          threadId: "thread-title",
          name: "Match title",
          cwd: "/workspace/one",
          status: "idle",
          source: "vscode",
          archived: false,
        },
      ],
      nextCursor: "next-page",
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledWith(
      pluginConfig,
      "thread/list",
      {
        archived: false,
        limit: 25,
        modelProviders: [],
        sortKey: "recency_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode"],
      },
      {
        config,
        startOptions: expect.objectContaining({ transport: "stdio", homeScope: "user" }),
      },
    );
    expect(JSON.stringify(await control.listPage({ searchTerm: "mAtCh" }))).not.toContain(
      "private",
    );
    expect(commandRpcMocks.codexControlRequest.mock.calls.map((call) => call[1])).not.toContain(
      "thread/resume",
    );
  });

  it("keeps takeover forking out of the passive catalog control", async () => {
    const pluginConfig = { supervision: { enabled: true } };
    const response = { thread: idleThread({ id: "thread-source" }) };
    commandRpcMocks.codexControlRequest.mockResolvedValue(response);
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });

    await expect(control.readThread("thread-source", true)).resolves.toBe(response.thread);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledWith(
      pluginConfig,
      "thread/read",
      { threadId: "thread-source", includeTurns: true },
      {
        config,
        startOptions: expect.objectContaining({ transport: "stdio", homeScope: "user" }),
      },
    );
    expect(commandRpcMocks.codexControlRequest.mock.calls.map((call) => call[1])).not.toContain(
      "thread/fork",
    );
  });

  it("keeps paired-node catalogs non-archived and metadata-only", async () => {
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [{ threadId: "local", status: "idle", archived: false }],
      })),
    });
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async () => ({
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId: "remote",
            name: "Remote task",
            status: "idle",
            archived: false,
            preview: "must be stripped",
            turns: [{ private: true }],
          },
        ],
      }),
    }));
    const { runtime } = createRuntime({
      nodes: [
        {
          nodeId: "devbox",
          displayName: "Dev Box",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
      ],
      invoke,
    });

    const result = await listCodexSessionCatalog({
      bindingStore: createCodexTestBindingStore(),
      config,
      runtime,
      control,
    });

    expect(result.hosts).toEqual([
      {
        hostId: CODEX_LOCAL_SESSION_HOST_ID,
        label: "Local Codex",
        kind: "gateway",
        connected: true,
        sessions: [{ threadId: "local", status: "idle", archived: false }],
      },
      {
        hostId: "node:devbox",
        label: "Dev Box",
        kind: "node",
        nodeId: "devbox",
        connected: true,
        sessions: [{ threadId: "remote", name: "Remote task", status: "idle", archived: false }],
      },
    ]);
    expect(control.listPage).toHaveBeenCalledWith(
      expect.not.objectContaining({ archived: expect.anything() }),
    );
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "devbox",
        command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
        params: expect.not.objectContaining({ archived: expect.anything() }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("private");

    const [nodeCommand] = createCodexSessionCatalogNodeHostCommands(control);
    expect(nodeCommand).toMatchObject({
      command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      dangerous: false,
    });
    if (!nodeCommand) {
      throw new Error("Codex session catalog node command was not registered");
    }
    await expect(nodeCommand.handle(JSON.stringify({ archived: true }))).rejects.toThrow(
      "unknown Codex session catalog parameter: archived",
    );

    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({
        sessions: [{ threadId: "archived", status: "idle", archived: true }],
      }),
    });
    await expect(
      listCodexSessionCatalog({
        bindingStore: createCodexTestBindingStore(),
        config,
        runtime,
        control,
        query: { hostIds: ["node:devbox"] },
      }),
    ).resolves.toEqual({
      hosts: [
        expect.objectContaining({
          hostId: "node:devbox",
          sessions: [],
          error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
        }),
      ],
    });
  });

  it("caps aggregate host results at the public wire bound", async () => {
    const control = createControl();
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async () => ({
      payloadJSON: JSON.stringify({ sessions: [] }),
    }));
    const { runtime } = createRuntime({
      nodes: Array.from({ length: 120 }, (_, index) => ({
        nodeId: `node-${index.toString().padStart(3, "0")}`,
        connected: true,
        commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
      })),
      invoke,
    });

    const result = await listCodexSessionCatalog({
      bindingStore: createCodexTestBindingStore(),
      config,
      runtime,
      control,
    });

    expect(result.hosts).toHaveLength(100);
    expect(result.hosts[0]?.hostId).toBe(CODEX_LOCAL_SESSION_HOST_ID);
    expect(invoke).toHaveBeenCalledTimes(99);
  });

  it("enriches only the local source row with its adopted OpenClaw session", async () => {
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [{ threadId: "source-thread", status: "active", archived: false }],
      })),
    });
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async () => ({
      payloadJSON: JSON.stringify({
        sessions: [{ threadId: "source-thread", status: "idle", archived: false }],
      }),
    }));
    const { runtime, entries } = createRuntime({
      nodes: [
        {
          nodeId: "devbox",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
      ],
      invoke,
    });
    const sessionKey = supervisionSessionKey("source-thread");
    const sessionId = "openclaw-session-existing";
    entries.push({
      sessionKey,
      entry: adoptedEntry({
        sourceThreadId: "source-thread",
        sessionId,
      }),
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "source-thread",
    });

    const result = await listCodexSessionCatalog({
      bindingStore,
      config,
      runtime,
      control,
    });

    expect(result.hosts[0]?.sessions[0]).toMatchObject({
      threadId: "source-thread",
      openClawSessionKey: sessionKey,
    });
    expect(result.hosts[1]?.sessions[0]).toEqual({
      threadId: "source-thread",
      status: "idle",
      archived: false,
    });
  });

  it("does not expose an adopted marker while generic initialization remains pending", async () => {
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [{ threadId: "source-thread", status: "idle", archived: false }],
      })),
    });
    const { runtime, entries } = createRuntime();
    const sessionKey = supervisionSessionKey("source-thread");
    const sessionId = "openclaw-session-pending";
    entries.push({
      sessionKey,
      entry: {
        ...adoptedEntry({ sourceThreadId: "source-thread", sessionId }),
        initializationPending: true,
      },
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "source-thread",
      pending: true,
    });

    const result = await listCodexSessionCatalog({ bindingStore, config, runtime, control });

    expect(result.hosts[0]?.sessions[0]).not.toHaveProperty("openClawSessionKey");
  });

  it("ignores a public marker retarget and trusts the private source binding", async () => {
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [
          { threadId: "source-thread", status: "idle", archived: false },
          { threadId: "forged-thread", status: "idle", archived: false },
        ],
      })),
    });
    const sessionKey = supervisionSessionKey("source-thread");
    const sessionId = "openclaw-session-forged-marker";
    const { runtime, entries } = createRuntime({
      entries: [
        {
          sessionKey,
          entry: adoptedEntry({ sourceThreadId: "forged-thread", sessionId }),
        },
      ],
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "source-thread",
    });

    const result = await listCodexSessionCatalog({ bindingStore, config, runtime, control });

    expect(result.hosts[0]?.sessions).toEqual([
      {
        threadId: "source-thread",
        status: "idle",
        archived: false,
        openClawSessionKey: sessionKey,
      },
      { threadId: "forged-thread", status: "idle", archived: false },
    ]);
    expect(entries[0]?.entry.pluginExtensions).toMatchObject({
      codex: { supervision: { sourceThreadId: "forged-thread" } },
    });
  });
});

describe("Codex supervision actions", () => {
  it("creates one pending locked branch and reuses its source mapping", async () => {
    const sourceThread = idleThread({
      modelProvider: "openai",
      turns: [
        { id: "turn-completed", status: "completed", items: [] },
        { id: "turn-failed", status: "failed", items: [] },
        { id: "turn-active", status: "inProgress", items: [] },
      ],
    });
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl({ readThread: vi.fn(async () => sourceThread) });

    const first = await continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });
    const second = await continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });

    expect(first).toEqual({
      sessionKey: expect.stringMatching(/^codex-supervision:[0-9a-f]{64}$/),
      disposition: "forked",
    });
    expect(second).toEqual({ sessionKey: first.sessionKey, disposition: "existing" });
    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: config,
        key: first.sessionKey,
        label: "Continue native task",
        spawnedCwd: "/workspace/project",
        afterCreate: expect.any(Function),
        initialEntry: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: {
              supervision: {
                sourceThreadId: "thread-1",
                initializing: true,
                modelLocked: true,
              },
            },
          },
        },
      }),
    );
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledWith({
      thread: sourceThread,
      sessionFile: "/tmp/openclaw-session-1.jsonl",
      sessionId: "openclaw-session-1",
      sessionKey: first.sessionKey,
      agentId: "main",
      cwd: "/workspace/project",
      throughTurnId: "turn-failed",
      modelProvider: "openai",
      config,
    });
    await expect(
      bindingStore.read(
        sessionBindingIdentity({
          sessionId: "openclaw-session-1",
          sessionKey: first.sessionKey,
          config,
        }),
      ),
    ).resolves.toMatchObject({
      threadId: "thread-1",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      cwd: "/workspace/project",
      historyCoveredThrough: expect.any(String),
      conversationSourceTransferComplete: true,
      preserveNativeModel: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-1", lastTurnId: "turn-failed" },
    });
    expect(control.readThread).toHaveBeenCalledTimes(2);
    expect(control.readThread).toHaveBeenNthCalledWith(1, "thread-1", true);
    expect(control.readThread).toHaveBeenNthCalledWith(2, "thread-1", false);
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
  });

  it("does not expose or reuse an initializing session while history import is paused", async () => {
    let releaseImport: (() => void) | undefined;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    transcriptMirrorMocks.importCodexThreadHistoryToTranscript.mockImplementationOnce(async () => {
      await importGate;
      return { importedMessages: 0, omittedMessages: 0 };
    });
    const { runtime, entries, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl();

    const firstContinue = continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });
    await vi.waitFor(() => {
      expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledOnce();
    });

    const duringImport = await listCodexSessionCatalog({ bindingStore, config, runtime, control });
    expect(duringImport.hosts[0]?.sessions[0]).not.toHaveProperty("openClawSessionKey");
    expect(entries[0]?.entry.initializationPending).toBe(true);
    let secondSettled = false;
    const secondContinue = continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    }).then((result) => {
      secondSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(createSessionEntry).toHaveBeenCalledOnce();

    releaseImport?.();
    const [first, second] = await Promise.all([firstContinue, secondContinue]);
    expect(second).toEqual(first);
    expect(entries[0]?.entry.pluginExtensions).toEqual({
      codex: {
        supervision: { sourceThreadId: "thread-1", modelLocked: true },
      },
    });
    expect(entries[0]?.entry.initializationPending).toBeUndefined();
  });

  it("recovers the same pending session after a restart before binding commit", async () => {
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-interrupted-before-binding";
    const crashedRuntime = createRuntime();
    crashedRuntime.entries.push({
      sessionKey,
      entry: interruptedAdoptionEntry({ sourceThreadId: "thread-1", sessionId }),
    });
    const { runtime, entries, createSessionEntry } = createRuntime({
      entries: crashedRuntime.entries,
    });
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control: createEligibleControl(),
        threadId: "thread-1",
      }),
    ).resolves.toEqual({ sessionKey, disposition: "forked" });

    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({ key: sessionKey, recoverMatchingInitialEntry: true }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry).toMatchObject({
      sessionId,
      pluginExtensions: {
        codex: {
          supervision: { sourceThreadId: "thread-1", modelLocked: true },
        },
      },
    });
    expect(entries[0]?.entry.initializationPending).toBeUndefined();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: `/tmp/${sessionId}.jsonl`,
        sessionId,
        sessionKey,
      }),
    );
    await expect(
      bindingStore.read(sessionBindingIdentity({ sessionId, sessionKey, config })),
    ).resolves.toMatchObject({
      threadId: "thread-1",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      preserveNativeModel: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-1" },
    });
  });

  it("recovers the same pending session after a restart following binding commit", async () => {
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-interrupted-after-binding";
    const crashedRuntime = createRuntime();
    crashedRuntime.entries.push({
      sessionKey,
      entry: interruptedAdoptionEntry({ sourceThreadId: "thread-1", sessionId }),
    });
    const { runtime, entries, createSessionEntry } = createRuntime({
      entries: crashedRuntime.entries,
    });
    const { api } = createGatewayApi(runtime);
    const inner = createCodexTestBindingStore();
    const identity = sessionBindingIdentity({ sessionId, sessionKey, config });
    await inner.mutate(identity, {
      kind: "set",
      if: { kind: "absent" },
      binding: {
        threadId: "thread-1",
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-1",
        cwd: "/workspace/project",
        historyCoveredThrough: new Date().toISOString(),
        conversationSourceTransferComplete: true,
        preserveNativeModel: true,
        pendingSupervisionBranch: { sourceThreadId: "thread-1" },
      },
    });
    const mutate = vi.fn(inner.mutate);
    const bindingStore: CodexAppServerBindingStore = { ...inner, mutate };

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control: createEligibleControl(),
        threadId: "thread-1",
      }),
    ).resolves.toEqual({ sessionKey, disposition: "forked" });

    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry.sessionId).toBe(sessionId);
    expect(entries[0]?.entry.initializationPending).toBeUndefined();
    expect(entries[0]?.entry.pluginExtensions).toEqual({
      codex: {
        supervision: { sourceThreadId: "thread-1", modelLocked: true },
      },
    });
    expect(mutate).not.toHaveBeenCalled();
    await expect(bindingStore.read(identity)).resolves.toMatchObject({
      threadId: "thread-1",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      preserveNativeModel: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-1" },
    });
  });

  it.each([
    "a different working directory",
    "a different terminal turn",
    "pending cleanup artifacts",
  ] as const)("rejects recovery against %s in a same-thread binding", async (invalidState) => {
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-interrupted-invalid-binding";
    const crashedRuntime = createRuntime();
    crashedRuntime.entries.push({
      sessionKey,
      entry: interruptedAdoptionEntry({ sourceThreadId: "thread-1", sessionId }),
    });
    const { runtime, entries } = createRuntime({ entries: crashedRuntime.entries });
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const identity = sessionBindingIdentity({ sessionId, sessionKey, config });
    const binding: CodexAppServerThreadBinding = {
      threadId: "thread-1",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      cwd: "/workspace/project",
      historyCoveredThrough: new Date().toISOString(),
      conversationSourceTransferComplete: true,
      preserveNativeModel: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-1" },
    };
    if (invalidState === "a different working directory") {
      binding.cwd = "/workspace/other";
    } else if (invalidState === "a different terminal turn") {
      binding.pendingSupervisionBranch = {
        sourceThreadId: "thread-1",
        lastTurnId: "turn-other",
      };
    } else {
      binding.pendingSupervisionBranch = {
        sourceThreadId: "thread-1",
        cleanupThreadIds: ["thread-orphan"],
      };
    }
    await bindingStore.mutate(identity, {
      kind: "set",
      if: { kind: "absent" },
      binding,
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control: createEligibleControl(),
        threadId: "thread-1",
      }),
    ).rejects.toThrow("OpenClaw session is already bound to Codex thread thread-1");
    expect(entries).toEqual([]);
  });

  it("does not infer a terminal boundary from completedAt without a terminal status", async () => {
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl({
      readThread: vi.fn(async () =>
        idleThread({
          status: { type: "notLoaded" },
          turns: [{ id: "turn-unknown", completedAt: 123, items: [] }],
        }),
      ),
    });

    const result = await continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });

    expect(result.disposition).toBe("forked");
    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ throughTurnId: null, modelProvider: undefined }),
    );
    await expect(
      bindingStore.read(
        sessionBindingIdentity({
          sessionId: "openclaw-session-1",
          sessionKey: result.sessionKey,
          config,
        }),
      ),
    ).resolves.toMatchObject({
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      pendingSupervisionBranch: { sourceThreadId: "thread-1" },
    });
    const binding = await bindingStore.read(
      sessionBindingIdentity({
        sessionId: "openclaw-session-1",
        sessionKey: result.sessionKey,
        config,
      }),
    );
    expect(binding?.pendingSupervisionBranch).not.toHaveProperty("lastTurnId");
  });

  it("opens a mapped active source without applying the unadopted idle gate", async () => {
    const { runtime, entries, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const control = createEligibleControl({
      readThread: vi.fn(async () =>
        idleThread({ status: { type: "active", activeFlags: ["waitingOnApproval"] } }),
      ),
    });
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-session-existing";
    entries.push({
      sessionKey,
      entry: adoptedEntry({ sourceThreadId: "thread-1", sessionId }),
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "thread-1",
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control,
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      sessionKey,
      disposition: "existing",
    });
    expect(control.readThread).toHaveBeenCalledWith("thread-1", false);
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it("rolls back the session when its pending binding cannot be committed", async () => {
    const { runtime, entries, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const inner = createCodexTestBindingStore();
    let rejectBinding = true;
    const mutate = vi.fn(async (...args: Parameters<CodexAppServerBindingStore["mutate"]>) => {
      if (rejectBinding && args[1].kind === "set") {
        rejectBinding = false;
        return false;
      }
      return await inner.mutate(...args);
    });
    const bindingStore: CodexAppServerBindingStore = { ...inner, mutate };
    const control = createEligibleControl();

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("failed to bind OpenClaw session to Codex thread thread-1");
    expect(entries).toEqual([]);
    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledOnce();
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("clears a committed pending binding when session finalization fails", async () => {
    const { runtime, createSessionEntry } = createRuntime({ failAfterCreate: () => true });
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl();

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("session finalization failed after binding commit");
    const firstKey = createSessionEntry.mock.calls[0]?.[0].key;
    if (!firstKey) {
      throw new Error("missing deterministic supervision session key");
    }
    await expect(
      bindingStore.read(
        sessionBindingIdentity({
          sessionId: "openclaw-session-1",
          sessionKey: firstKey,
          config,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("walks the canonical non-archived catalog before continuing a known thread", async () => {
    const { runtime } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const listPage = vi.fn(async (params: { cursor?: string }) =>
      params.cursor
        ? {
            sessions: [
              {
                threadId: "thread-1",
                status: "idle",
                source: "vscode",
                archived: false as const,
              },
            ],
          }
        : {
            sessions: [
              {
                threadId: "other-thread",
                status: "idle",
                source: "cli",
                archived: false as const,
              },
            ],
            nextCursor: "page-2",
          },
    );
    const control = createControl({ listPage });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore: createCodexTestBindingStore(),
        config,
        control,
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({ disposition: "forked" });
    expect(listPage).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(listPage).toHaveBeenNthCalledWith(2, { cursor: "page-2", limit: 100 });
  });

  it("rejects archived interactive thread ids that are absent from the canonical catalog", async () => {
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const control = createControl({
      listPage: vi.fn(async () => ({ sessions: [] })),
      readThread: vi.fn(async () => idleThread({ source: "cli" })),
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore: createCodexTestBindingStore(),
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("not a non-archived interactive CLI or VS Code session");
    await expect(archiveLocalCodexSession({ control, threadId: "thread-1" })).rejects.toThrow(
      "not a non-archived interactive CLI or VS Code session",
    );
    expect(control.readThread).not.toHaveBeenCalled();
    expect(createSessionEntry).not.toHaveBeenCalled();
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("rejects internal App Server thread ids even if a control returns them", async () => {
    const { runtime } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [
          {
            threadId: "thread-1",
            status: "idle",
            source: "appServer",
            archived: false,
          },
        ],
      })),
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore: createCodexTestBindingStore(),
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("not a non-archived interactive CLI or VS Code session");
    await expect(archiveLocalCodexSession({ control, threadId: "thread-1" })).rejects.toThrow(
      "not a non-archived interactive CLI or VS Code session",
    );
    expect(control.readThread).not.toHaveBeenCalled();
  });

  it("fails closed when canonical catalog cursors cycle", async () => {
    const { runtime } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const control = createControl({
      listPage: vi.fn(async () => ({ sessions: [], nextCursor: "cycle" })),
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore: createCodexTestBindingStore(),
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("eligibility could not be verified");
    expect(control.listPage).toHaveBeenCalledTimes(2);
    expect(control.readThread).not.toHaveBeenCalled();
  });

  it("rechecks status and rejects active local sessions before either mutation", async () => {
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
    await expect(archiveLocalCodexSession({ control, threadId: "thread-1" })).rejects.toThrow(
      "active in this App Server",
    );
    expect(createSessionEntry).not.toHaveBeenCalled();
    expect(control.archiveThread).not.toHaveBeenCalled();
    expect(control.readThread).toHaveBeenNthCalledWith(1, "thread-1", true);
    expect(control.readThread).toHaveBeenNthCalledWith(2, "thread-1", false);
  });

  it("archives an idle local thread only after the fresh status read", async () => {
    const control = createEligibleControl();

    await expect(archiveLocalCodexSession({ control, threadId: "thread-1" })).resolves.toEqual({
      archived: true,
    });
    expect(control.readThread).toHaveBeenCalledWith("thread-1", false);
    expect(control.archiveThread).toHaveBeenCalledWith("thread-1");
    expect(control.readThread.mock.invocationCallOrder[0]).toBeLessThan(
      control.archiveThread.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("archives a not-loaded local thread after explicit runner confirmation", async () => {
    const control = createEligibleControl({
      readThread: vi.fn(async () => idleThread({ status: { type: "notLoaded" } })),
    });

    await expect(archiveLocalCodexSession({ control, threadId: "thread-1" })).resolves.toEqual({
      archived: true,
    });
    expect(control.archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("requires archive confirmation and rejects paired-node mutations at Gateway handlers", async () => {
    const { runtime, createSessionEntry } = createRuntime();
    const { api, handlers, registerControlUiDescriptor, registerGatewayMethod } =
      createGatewayApi(runtime);
    const control = createEligibleControl();
    registerCodexSessionCatalogGateway({
      api,
      bindingStore: createCodexTestBindingStore(),
      control,
      getRuntimeConfig: () => config,
    });

    expect(registerControlUiDescriptor).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sessions", requiredScopes: ["operator.write"] }),
    );
    for (const method of [
      CODEX_SESSION_CATALOG_METHOD,
      CODEX_SESSION_CONTINUE_METHOD,
      CODEX_SESSION_ARCHIVE_METHOD,
    ]) {
      expect(registerGatewayMethod).toHaveBeenCalledWith(method, expect.any(Function), {
        scope: "operator.write",
      });
    }

    const archivedRespond = await callGatewayHandler(handlers.get(CODEX_SESSION_CATALOG_METHOD), {
      archived: true,
    });
    expect(archivedRespond).toHaveBeenCalledWith(
      false,
      { error: "unknown Codex session catalog parameter: archived" },
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    const unconfirmedArchive = await callGatewayHandler(
      handlers.get(CODEX_SESSION_ARCHIVE_METHOD),
      { hostId: CODEX_LOCAL_SESSION_HOST_ID, threadId: "thread-1" },
    );
    expect(unconfirmedArchive).toHaveBeenCalledWith(
      false,
      {
        error:
          "confirmNoOtherRunner=true is required because Codex Desktop and CLI activity is process-local",
      },
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(control.readThread).not.toHaveBeenCalled();

    const confirmedArchive = await callGatewayHandler(handlers.get(CODEX_SESSION_ARCHIVE_METHOD), {
      hostId: CODEX_LOCAL_SESSION_HOST_ID,
      threadId: "thread-1",
      confirmNoOtherRunner: true,
    });
    expect(confirmedArchive).toHaveBeenCalledWith(true, { archived: true });

    for (const method of [CODEX_SESSION_CONTINUE_METHOD, CODEX_SESSION_ARCHIVE_METHOD]) {
      const respond = await callGatewayHandler(handlers.get(method), {
        hostId: "node:devbox",
        threadId: "thread-remote",
        ...(method === CODEX_SESSION_ARCHIVE_METHOD ? { confirmNoOtherRunner: true } : {}),
      });
      expect(respond).toHaveBeenCalledWith(
        false,
        { error: "paired-node Codex sessions are view-only" },
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
    expect(control.readThread).toHaveBeenCalledOnce();
    expect(control.archiveThread).toHaveBeenCalledOnce();
    expect(createSessionEntry).not.toHaveBeenCalled();
  });
});
