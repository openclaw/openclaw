/* oxlint-disable typescript/unbound-method -- assertions inspect vi.fn-backed object methods, not unbound class methods. */
import { expect, it, vi } from "vitest";
import { CODEX_CLI_SESSION_SOURCE_CAPABILITY } from "./node-cli-sessions.js";
import {
  transcriptMirrorMocks,
  nodeHostMocks,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_CATALOG_TRANSCRIPT_READ_COMMAND,
  CODEX_NODE_CONTINUE_COMMANDS,
  tempDirs,
  readCodexSessionTranscript,
  registerCodexSessionCatalog,
  config,
  idleThread,
  catalogThreadItem,
  compatibilityOwnerConfig,
  createControl,
  createEligibleControl,
  createRuntime,
  createGatewayApi,
  fs,
  os,
  path,
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerUserHomeDir,
  resolveDefaultAgentDir,
  resolveSessionAgentIdsStrict,
  createCodexTestBindingStore,
  CODEX_TERMINAL_RESUME_COMMAND,
  CODEX_TERMINAL_START_COMMAND,
  createCodexSessionCatalogNodeHostCommands,
  CODEX_LOCAL_SESSION_HOST_ID,
  createCodexSessionCatalogNodeInvokePolicies,
  type OpenClawConfig,
  type PluginRuntime,
} from "./session-catalog.test-helpers.js";

const nodeSourceHomeId = "a".repeat(64);
const payload = (value: unknown) => ({ payloadJSON: JSON.stringify(value) });
const nodePage = (sessions: unknown[]) => ({
  payloadJSON: JSON.stringify({ sourceHomeId: nodeSourceHomeId, canContinueCodex: true, sessions }),
});
const nodeSession = (threadId: string, fields: Record<string, unknown> = {}) => ({
  threadId,
  name: "Remote task",
  status: "idle",
  source: "cli",
  archived: false,
  ...fields,
});
const pairedNode = (commands: string[] = [...CODEX_NODE_CONTINUE_COMMANDS]) => ({
  nodeId: "devbox",
  connected: true,
  caps: [CODEX_CLI_SESSION_SOURCE_CAPABILITY],
  commands,
  invocableCommands: commands,
});
function registerProvider(
  runtime: PluginRuntime,
  getRuntimeConfig: () => OpenClawConfig | undefined = () => config,
  control = createControl(),
  startupConfig: OpenClawConfig = {},
) {
  const { api, getProvider } = createGatewayApi(runtime, startupConfig);
  registerCodexSessionCatalog({
    api,
    bindingStore: createCodexTestBindingStore(),
    control,
    getRuntimeConfig,
  });
  return getProvider()!;
}
const continueRequest = (overrides: { hostId?: string; clientScopes?: string[] } = {}) => ({
  hostId: "node:devbox",
  threadId: "thread-remote",
  clientScopes: ["operator.admin"],
  ...overrides,
});

function nodeCatalog(options: Parameters<typeof createRuntime>[0] = {}) {
  const context = createRuntime({
    nodes: [pairedNode()],
    ...options,
  });
  return { ...context, provider: registerProvider(context.runtime) };
}

it("advertises creation from startup config before the live snapshot is available", () => {
  const model = "openai/gpt-5.6-sol";
  const startupConfig = {
    agents: {
      defaults: {
        model: { primary: model },
        models: { [model]: {} },
        modelPolicy: { allow: [model] },
      },
    },
  } satisfies OpenClawConfig;
  const { runtime } = createRuntime();
  const provider = registerProvider(
    runtime,
    () => undefined,
    createEligibleControl(),
    startupConfig,
  );
  expect(provider.resolveCreateSession?.({ agentId: "main" })).toEqual({
    model,
    agentRuntime: "codex",
  });
});

it("adopts a paired-node session with bounded history and an executable binding", async () => {
  const remoteThreadId = "123e4567-e89b-12d3-a456-426614174001";
  const sessionFamilyId = "123e4567-e89b-12d3-a456-426614174002";
  let runtimeConfig = compatibilityOwnerConfig("beta");
  const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ command }) => {
    if (command === CODEX_APP_SERVER_THREADS_LIST_COMMAND) {
      return nodePage([
        nodeSession(remoteThreadId, {
          sessionId: sessionFamilyId,
          cwd: "/remote/repo",
          source: "vscode",
          modelProvider: "openai",
          createdAt: 123,
        }),
      ]);
    }
    if (command === CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND) {
      return payload({
        data: [
          {
            id: "turn-1",
            status: "completed",
            items: [{ id: "item-1", type: "agentMessage", text: "done" }],
          },
        ],
      });
    }
    throw new Error(`unexpected command: ${command}`);
  });
  const { runtime, entries, createSessionEntry, patchSessionEntry } = createRuntime({
    nodes: [{ ...pairedNode(), displayName: "Devbox" }],
    invoke,
  });
  const provider = registerProvider(runtime, () => runtimeConfig);

  const request = { ...continueRequest(), agentId: "alpha", threadId: remoteThreadId };
  const first = await provider.continueSession?.(request);
  const pendingList = await provider?.list({ agentId: "alpha", hostIds: ["node:devbox"] });
  expect(pendingList?.[0]?.sessions[0]?.sessionKey).toBeUndefined();
  await first?.afterConversationBound?.();
  const adopted = entries.find((entry) => entry.sessionKey === first?.sessionKey)?.entry;
  if (!adopted) {
    throw new Error("expected adopted session entry");
  }
  adopted.archivedAt = 123;
  adopted.archivedBy = { type: "human", id: "operator-1" };
  adopted.archiveReason = "manual";
  runtimeConfig = compatibilityOwnerConfig("beta");
  const second = await provider.continueSession?.(request);
  await second?.afterConversationBound?.();

  expect(first?.sessionKey).toBe(second?.sessionKey);
  expect(first?.conversationBinding?.data).toMatchObject({
    kind: "codex-cli-node-session",
    version: 1,
    nodeId: "devbox",
    // Forks share a session family; resume must select the exact listed thread.
    sessionId: remoteThreadId,
    agentId: "alpha",
    cwd: "/remote/repo",
  });
  expect(second?.conversationBinding?.data).toMatchObject({ agentId: "alpha" });
  expect(createSessionEntry).toHaveBeenCalledOnce();
  expect(createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty("label");
  expect(createSessionEntry).toHaveBeenCalledWith(
    expect.objectContaining({
      displayName: "Remote task",
      spawnedCwd: "/remote/repo",
      initialEntry: expect.objectContaining({
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        pluginExtensions: {
          codex: {
            sessionCatalog: expect.objectContaining({
              sourceHostId: "node:devbox",
              sourceThreadId: remoteThreadId,
              nodeId: "devbox",
              initializing: true,
            }),
          },
        },
      }),
    }),
  );
  expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledOnce();
  expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledWith(
    expect.objectContaining({
      thread: expect.objectContaining({
        id: remoteThreadId,
        turns: [expect.objectContaining({ id: "turn-1" })],
      }),
      throughTurnId: "turn-1",
      cwd: "/remote/repo",
    }),
  );
  // One finalize patch per continue; the restore rides afterConversationBound.
  expect(patchSessionEntry).toHaveBeenCalledTimes(2);
  const restored = entries.find((entry) => entry.sessionKey === second?.sessionKey)?.entry;
  expect(restored?.archivedAt).toBeUndefined();
  expect(restored?.archivedBy).toBeUndefined();
  expect(restored?.archiveReason).toBeUndefined();

  const listed = await provider?.list({ agentId: "alpha", hostIds: ["node:devbox"] });
  expect(listed?.[0]?.sessions[0]).toMatchObject({
    threadId: remoteThreadId,
    sessionKey: first?.sessionKey,
  });
});

it("keeps Gateway-first upgrades compatible with the released node selector and separates concurrent owners", async () => {
  const threadId = "123e4567-e89b-12d3-a456-426614174001";
  const runtimeConfig = {
    agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
  } as OpenClawConfig;
  // v2026.9.4 resolves every catalog packet through the node's configured agent roster.
  const selectReleasedNodeAgent = (params: unknown) =>
    resolveSessionAgentIdsStrict({
      config: runtimeConfig,
      agentId: (params as { agentId?: string }).agentId,
    }).sessionAgentId;
  const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ command, params }) => {
    selectReleasedNodeAgent(params);
    if (command === CODEX_APP_SERVER_THREADS_LIST_COMMAND) {
      return nodePage([nodeSession(threadId)]);
    }
    if (command === CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND) {
      return payload({ data: [] });
    }
    throw new Error(`unexpected command: ${command}`);
  });
  const { runtime, createSessionEntry } = createRuntime({
    nodes: [pairedNode([...CODEX_NODE_CONTINUE_COMMANDS, CODEX_TERMINAL_RESUME_COMMAND])],
    invoke,
  });
  const provider = registerProvider(runtime, () => runtimeConfig, createControl(), runtimeConfig);
  const continueSession = provider?.continueSession;
  if (!continueSession) {
    throw new Error("expected the Codex session catalog continue provider");
  }

  await expect(
    provider!.list({ agentId: "alpha", hostIds: ["node:devbox"] }),
  ).resolves.toMatchObject([{ sessions: [{ threadId }] }]);
  await expect(
    provider!.read({ agentId: "alpha", hostId: "node:devbox", threadId }),
  ).resolves.toMatchObject({ items: [] });
  const terminal = await provider!.openTerminal!({
    agentId: "alpha",
    hostId: "node:devbox",
    threadId,
  });
  expect(terminal.kind).toBe("node");
  if (terminal.kind === "node") {
    expect(selectReleasedNodeAgent(JSON.parse(terminal.paramsJSON))).toBe("alpha");
  }

  const [alpha, beta] = await Promise.all(
    ["alpha", "beta"].map((agentId) =>
      continueSession({ ...continueRequest(), agentId, threadId }),
    ),
  );

  expect(alpha?.sessionKey).toMatch(/^agent:alpha:harness:codex:node-session:/);
  expect(beta?.sessionKey).toMatch(/^agent:beta:harness:codex:node-session:/);
  expect(alpha?.sessionKey).not.toBe(beta?.sessionKey);
  expect([alpha, beta]).toMatchObject(
    ["alpha", "beta"].map((agentId) => ({
      conversationBinding: { data: { agentId, nodeId: "devbox", sessionId: threadId } },
    })),
  );
  expect(createSessionEntry).toHaveBeenCalledTimes(2);
  for (const [request] of invoke.mock.calls) {
    expect(request.nodeId).toBe("devbox");
    expect(["alpha", "beta"]).toContain(selectReleasedNodeAgent(request.params));
  }
});

it.each([
  [
    "missing run permission",
    {},
    "paired node does not permit Codex session continuation",
    {
      nodes: [
        pairedNode([
          CODEX_APP_SERVER_THREADS_LIST_COMMAND,
          CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
        ]),
      ],
    },
  ],
  ["non-canonical host", { hostId: "node:devbox " }, "hostId is invalid", {}],
  ["non-admin", { clientScopes: ["operator.write"] }, "requires operator.admin", {}],
  [
    "active session",
    {},
    "active on the paired node",
    {
      invoke: vi.fn<PluginRuntime["nodes"]["invoke"]>(async () =>
        nodePage([nodeSession("thread-remote", { status: "active", name: undefined })]),
      ),
    },
  ],
] satisfies [
  string,
  Parameters<typeof continueRequest>[0],
  string,
  Parameters<typeof createRuntime>[0],
][])("rejects %s before adoption", async (_name, request, error, options) => {
  const { provider, createSessionEntry } = nodeCatalog(options);
  await expect(provider.continueSession!(continueRequest(request))).rejects.toThrow(error);
  expect(createSessionEntry).not.toHaveBeenCalled();
});

it("builds local and paired-node terminal plans from verified catalog records", async () => {
  const threadId = "123e4567-e89b-12d3-a456-426614174000";
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-terminal-"));
  tempDirs.push(binDir);
  process.env.PATH = "";
  nodeHostMocks.userShellPaths.set("codex", binDir);
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const executable = path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
  const control = createEligibleControl({
    requireEligibleThread: vi.fn(async () =>
      idleThread({
        id: threadId,
        status: { type: "active" },
        source: "cli",
        cwd: "/workspace/local",
      }),
    ),
    listPage: vi.fn(async () => ({
      sessions: [
        { threadId, status: "active", source: "cli", cwd: "/workspace/local", archived: false },
      ],
    })),
  });
  // A title search cannot locate this thread by ID.
  const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async (request) =>
    payload({
      sourceHomeId: nodeSourceHomeId,
      sessions:
        typeof (request.params as { searchTerm?: string } | undefined)?.searchTerm === "string"
          ? []
          : [
              nodeSession(threadId, {
                name: "Normal project title",
                status: "active",
                source: "vscode",
                cwd: "/workspace/node",
              }),
            ],
    }),
  );
  const commands = [CODEX_APP_SERVER_THREADS_LIST_COMMAND, CODEX_TERMINAL_RESUME_COMMAND];
  const authorizedCommands = new Set(
    createCodexSessionCatalogNodeInvokePolicies().flatMap((policy) => policy.commands),
  );
  expect(authorizedCommands).toContain(CODEX_TERMINAL_RESUME_COMMAND);
  const policy = createCodexSessionCatalogNodeInvokePolicies()[0];
  if (!policy) {
    throw new Error("expected Codex node invoke policy");
  }
  const invokeNode = vi.fn(async () => ({ ok: true as const, payload: "listed" }));
  expect(policy.handle({ command: CODEX_TERMINAL_RESUME_COMMAND, invokeNode } as never)).toEqual({
    ok: true,
  });
  for (const [terminal, admin, allowed] of [
    [undefined, true, true],
    [true, true, true],
    [false, true, false],
    [undefined, false, false],
  ] as const) {
    expect(
      await policy.handle({
        command: CODEX_TERMINAL_START_COMMAND,
        nodeId: "node",
        params: {},
        invokeNode,
        config: {
          gateway: {
            cliAgents: { enabled: true },
            ...(terminal === undefined ? {} : { terminal: { enabled: terminal } }),
          },
        },
        client: { scopes: admin ? ["operator.admin"] : [] },
      }),
    ).toMatchObject({ ok: allowed });
  }
  expect(invokeNode).not.toHaveBeenCalled();
  const node = {
    nodeId: "devbox",
    connected: true,
    commands,
    invocableCommands: commands.filter((command) => authorizedCommands.has(command)),
  };
  const { runtime } = createRuntime({ nodes: [node], invoke });
  const { api, getProvider } = createGatewayApi(runtime);
  let pluginConfig: unknown = { appServer: { homeScope: "agent" } };
  const register = () =>
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control,
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
    });
  register();
  const terminalHost = (hostId: string, canOpenTerminal: boolean) =>
    expect.objectContaining({
      hostId,
      sessions: [expect.objectContaining({ threadId, canOpenTerminal })],
    });
  const expectTerminalAvailability = (local: boolean) =>
    expect(getProvider()?.list({})).resolves.toEqual(
      expect.arrayContaining([
        terminalHost(CODEX_LOCAL_SESSION_HOST_ID, local),
        terminalHost("node:devbox", true),
      ]),
    );
  const openTerminal = (hostId = CODEX_LOCAL_SESSION_HOST_ID) =>
    getProvider()?.openTerminal?.({ hostId, threadId });
  const startTerminal = (cwd: string, initialMessage?: string, nodeId?: string) =>
    getProvider()?.startTerminalSession?.({ agentId: "main", cwd, initialMessage, nodeId });

  await expectTerminalAvailability(false);
  await expect(openTerminal()).rejects.toThrow("Codex CLI is unavailable");
  await expect(startTerminal("/workspace/new", "--help")).rejects.toThrow(
    "install Codex or add codex to PATH",
  );
  await expect(startTerminal("/workspace/node-new", undefined, "devbox")).resolves.toEqual({
    kind: "node",
    nodeId: "devbox",
    command: CODEX_TERMINAL_START_COMMAND,
    uploadPathStyle: "native",
    paramsJSON: JSON.stringify({ cwd: "/workspace/node-new" }),
    cwd: "/workspace/node-new",
    title: "codex",
  });

  await fs.writeFile(executable, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
  if (process.platform !== "win32") {
    await fs.chmod(executable, 0o755);
  }
  now += 60_001;
  await expectTerminalAvailability(true);
  await expect(openTerminal()).resolves.toMatchObject({
    kind: "local",
    argv: [executable, "resume", threadId],
    cwd: "/workspace/local",
    pathEnv: binDir,
    env: {
      CODEX_HOME: resolveCodexAppServerHomeDir(resolveDefaultAgentDir(config)),
    },
  });
  await expect(startTerminal("/workspace/new", "Fix A&B and 100%")).resolves.toEqual({
    kind: "local",
    argv: [executable, "--", "Fix A&B and 100%"],
    cwd: "/workspace/new",
    env: {
      CODEX_HOME: resolveCodexAppServerHomeDir(resolveDefaultAgentDir(config)),
    },
    pathEnv: binDir,
    title: "codex",
  });
  await expect(startTerminal("/workspace/command-prompt", "resume")).resolves.toMatchObject({
    argv: [executable, "--", "resume"],
  });
  await expect(startTerminal("/workspace/blank")).resolves.toMatchObject({
    argv: [executable],
    cwd: "/workspace/blank",
  });
  const fresh = createCodexSessionCatalogNodeHostCommands(control).find(
    (command) => command.command === CODEX_TERMINAL_START_COMMAND,
  )!;
  process.env.PATH = binDir;
  const io = { signal: new AbortController().signal, emitChunk: vi.fn(), onInput: vi.fn() };
  await fresh.handle(
    JSON.stringify({ cwd: binDir, initialMessage: "--help", cols: 100, rows: 30 }),
    io,
  );
  expect(nodeHostMocks.runNodePtyCommand).toHaveBeenCalledWith(
    {
      file: executable,
      args: ["--", "--help"],
      cwd: binDir,
      requiredCwd: true,
      cols: 100,
      rows: 30,
    },
    io,
  );
  for (const field of ["agentId", "argv", "env", "executable"]) {
    await expect(
      fresh.handle(JSON.stringify({ cwd: binDir, cols: 80, rows: 24, [field]: "injected" }), io),
    ).rejects.toThrow("unknown terminal start parameter");
  }
  const terminalNode = (
    nodeId: string,
    connected = true,
    invocableCommands: string[] = [CODEX_TERMINAL_START_COMMAND],
  ) => ({ nodeId, connected, invocableCommands });
  const hosts = [
    terminalNode("ready"),
    terminalNode("resume-only", true, [CODEX_TERMINAL_RESUME_COMMAND]),
    terminalNode("offline", false),
    { ...terminalNode("denied", true, []), commands: [CODEX_TERMINAL_START_COMMAND] },
  ];
  const localList = vi.spyOn(control, "listPage").mockRejectedValue(new Error("app-server down"));
  const localProgress = vi.fn();
  let rejectNodes!: (error: Error) => void;
  const pending = getProvider()!.list({
    onHost: localProgress,
    listNodes: () =>
      new Promise((_, reject) => {
        rejectNodes = reject;
      }),
  });
  await vi.waitFor(() =>
    expect(localProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: CODEX_LOCAL_SESSION_HOST_ID,
        connected: false,
        canStartTerminal: true,
      }),
    ),
  );
  rejectNodes(new Error("node registry down"));
  expect(await pending).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ hostId: CODEX_LOCAL_SESSION_HOST_ID, canStartTerminal: true }),
      expect.objectContaining({ hostId: "node:registry", canStartTerminal: false }),
    ]),
  );
  localList.mockRestore();
  invoke.mockClear();
  const onHost = vi.fn();
  const catalogHosts = await getProvider()?.list({
    onHost,
    agentId: "main",
    listNodes: async () => ({ nodes: hosts }),
  });
  const terminalHosts = catalogHosts?.filter((host) => host.canStartTerminal);
  expect(terminalHosts?.filter((host) => host.hostId.startsWith("node:"))).toEqual([
    expect.objectContaining({ hostId: "node:ready", label: "ready", sessions: [] }),
  ]);
  expect(onHost.mock.calls.map(([host]) => host)).toEqual(expect.arrayContaining(catalogHosts!));
  expect(invoke).not.toHaveBeenCalled();
  expect(terminalHosts?.filter((host) => host.kind === "gateway")).toEqual([
    expect.objectContaining({ hostId: CODEX_LOCAL_SESSION_HOST_ID }),
  ]);
  const userSource = catalogHosts?.find((host) => host.label === "Local Codex · user");
  expect(userSource).toMatchObject({ canStartTerminal: false });
  await expect(
    getProvider()?.startTerminalSession?.({
      agentId: "main",
      hostId: userSource!.hostId,
      cwd: binDir,
    }),
  ).rejects.toThrow("select the local machine or a connected node");
  pluginConfig = { appServer: { homeScope: "user" } };
  register();
  await expect(openTerminal()).resolves.toMatchObject({
    env: { CODEX_HOME: resolveCodexAppServerUserHomeDir(process.env) },
  });
  await expect(openTerminal("node:devbox")).resolves.toMatchObject({
    kind: "node",
    nodeId: "devbox",
    command: CODEX_TERMINAL_RESUME_COMMAND,
    uploadPathStyle: "native",
    cwd: "/workspace/node",
  });
  expect(invoke.mock.calls.at(-1)?.[0].params).not.toHaveProperty("searchTerm");

  node.invocableCommands = [CODEX_APP_SERVER_THREADS_LIST_COMMAND];
  await expect(getProvider()?.list({ hostIds: ["node:devbox"] })).resolves.toMatchObject([
    { sessions: [{ threadId, canOpenTerminal: false }] },
  ]);
  await expect(openTerminal("node:devbox")).rejects.toThrow(
    "paired-node Codex terminal is unavailable",
  );
});

it("marks not-loaded local interactive sessions as actionable", async () => {
  const { runtime } = createRuntime();
  const provider = registerProvider(
    runtime,
    () => config,
    createEligibleControl({
      listPage: vi.fn(async () => ({
        sessions: [
          nodeSession("thread-1", {
            name: undefined,
            fallbackName: "Readable fallback",
            status: "notLoaded",
          }),
        ],
      })),
    }),
  );

  await expect(provider.list({})).resolves.toMatchObject([
    {
      hostId: CODEX_LOCAL_SESSION_HOST_ID,
      sessions: [
        {
          threadId: "thread-1",
          name: "Readable fallback",
          canContinue: true,
          canArchive: true,
        },
      ],
    },
  ]);
});

it("reads local transcript turns one bounded App Server page at a time", async () => {
  const question = catalogThreadItem("item-1", {
    type: "userMessage",
    content: [{ type: "text", text: "question" }],
  });
  const answer = catalogThreadItem("item-2", { text: "full answer" });
  const listTurnPage = vi.fn(async () => ({
    data: [{ id: "turn-1", items: [question, answer] }],
    nextCursor: "turns-page-2",
  }));
  const control = createEligibleControl({ listTurnPage });

  await expect(
    readCodexSessionTranscript({
      runtime: createRuntime().runtime,
      control,
      hostId: CODEX_LOCAL_SESSION_HOST_ID,
      threadId: "thread-1",
      limit: 50,
    }),
  ).resolves.toEqual({
    hostId: CODEX_LOCAL_SESSION_HOST_ID,
    label: "Local Codex",
    threadId: "thread-1",
    items: [
      { id: "item-2", type: "agentMessage", text: "full answer", raw: answer },
      { id: "item-1", type: "userMessage", text: "question", raw: question },
    ],
    nextCursor: "turns-page-2",
  });
  expect(listTurnPage).toHaveBeenCalledWith({
    threadId: "thread-1",
    limit: 1,
    sortDirection: "desc",
    itemsView: "full",
  });
  expect(control.readThread).not.toHaveBeenCalled();
});

it.each([
  { mode: "bounded", command: CODEX_CATALOG_TRANSCRIPT_READ_COMMAND, nativeLimit: 25 },
  { mode: "legacy", command: CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND, nativeLimit: 1 },
])("reads a paired-node transcript through its $mode command", async ({ command, nativeLimit }) => {
  const source = catalogThreadItem("item-remote", {
    type: "userMessage",
    content: [{ type: "text", text: "remote prompt" }],
  });
  const projected = {
    id: "item-remote",
    type: "userMessage",
    text: "remote prompt",
    raw: source,
  };
  const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async (request) => {
    if (request.command !== command) {
      throw new Error("unexpected node command");
    }
    return payload({
      ...(command === CODEX_CATALOG_TRANSCRIPT_READ_COMMAND
        ? { items: [projected] }
        : { data: [{ id: "turn-remote", items: [source] }] }),
      nextCursor: "remote-position-2",
    });
  });
  const { runtime } = createRuntime({
    nodes: [
      {
        nodeId: "devbox",
        connected: true,
        commands: [
          CODEX_APP_SERVER_THREADS_LIST_COMMAND,
          CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
          command,
        ],
        displayName: "Devbox",
      },
    ],
    invoke,
  });

  await expect(
    readCodexSessionTranscript({
      runtime,
      control: createControl(),
      hostId: "node:devbox",
      threadId: "thread-remote",
      cursor: "remote-position-1",
      limit: 25,
    }),
  ).resolves.toEqual({
    hostId: "node:devbox",
    label: "Devbox",
    threadId: "thread-remote",
    items: [projected],
    nextCursor: "remote-position-2",
  });
  expect(invoke).toHaveBeenLastCalledWith({
    nodeId: "devbox",
    command,
    params: {
      agentId: "main",
      threadId: "thread-remote",
      cursor: "remote-position-1",
      limit: nativeLimit,
    },
    timeoutMs: 65_000,
    scopes: ["operator.write"],
  });
});
