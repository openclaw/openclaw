import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_CLI_SESSION_SOURCE_CAPABILITY } from "./node-cli-sessions.js";
import {
  commandRpcMocks,
  pinnedConnectionMocks,
  createCodexSessionCatalogControlFactory,
  createCodexSessionCatalogNodeHostCommands,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_CATALOG_TRANSCRIPT_READ_COMMAND,
  CODEX_CLI_SESSION_RESUME_COMMAND,
  CODEX_NODE_CONTINUE_COMMANDS,
  registerCodexSessionCatalog,
  config,
  createControl,
  createRuntime,
  createGatewayApi,
  createCodexTestBindingStore,
  transcriptMirrorMocks,
  type PluginRuntime,
  idleThread,
  fs,
  path,
  type OpenClawConfig,
} from "./session-catalog.test-helpers.js";

const nodeTempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Codex node catalog sources", () => {
  it("marks paired-node rows continuable only with complete permitted capabilities", async () => {
    const sourceByNode = new Map([
      ["ready-cli", { status: "idle", source: "cli" }],
      ["ready-vscode", { status: "notLoaded", source: "vscode" }],
      ["ready-atlas", { status: "notLoaded", source: "atlas" }],
      ["older-node", { status: "notLoaded", source: "cli" }],
      ["unix-source", { status: "notLoaded", source: "cli" }],
      ["websocket-source", { status: "notLoaded", source: "cli" }],
      ["missing-source", { status: "notLoaded", source: "cli" }],
      ["invalid-source", { status: "notLoaded", source: "cli" }],
      ["missing-run", { status: "idle", source: "cli" }],
      ["active", { status: "active", source: "cli" }],
      ["noninteractive", { status: "idle", source: "exec" }],
    ]);
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ nodeId }) => {
      const source = sourceByNode.get(nodeId);
      if (!source) {
        throw new Error("unexpected node");
      }
      return {
        payloadJSON: JSON.stringify({
          sourceHomeId: "a".repeat(64),
          canContinueCodex:
            nodeId === "missing-source"
              ? undefined
              : nodeId === "invalid-source"
                ? "true"
                : !["unix-source", "websocket-source"].includes(nodeId),
          sessions: [
            {
              threadId: `thread-${nodeId}`,
              status: source.status,
              source: source.source,
              archived: false,
            },
          ],
        }),
      };
    });
    const { runtime } = createRuntime({
      nodes: [...sourceByNode.keys()].map((nodeId) => ({
        nodeId,
        displayName: nodeId,
        connected: true,
        caps: nodeId === "older-node" ? [] : [CODEX_CLI_SESSION_SOURCE_CAPABILITY],
        commands: [...CODEX_NODE_CONTINUE_COMMANDS],
        invocableCommands:
          nodeId === "missing-run"
            ? CODEX_NODE_CONTINUE_COMMANDS.filter(
                (command) => command !== CODEX_CLI_SESSION_RESUME_COMMAND,
              )
            : [...CODEX_NODE_CONTINUE_COMMANDS],
      })),
      invoke,
    });
    const { api, getProvider } = createGatewayApi(runtime);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control: createControl(),
      getRuntimeConfig: () => config,
    });

    const hosts = await getProvider()?.list({
      hostIds: [...sourceByNode.keys()].map((id) => `node:${id}`),
    });
    const sessionByHost = new Map(hosts?.map((host) => [host.hostId, host.sessions[0]]) ?? []);
    expect(sessionByHost.get("node:ready-cli")).toMatchObject({
      canContinue: true,
      canArchive: false,
    });
    expect(sessionByHost.get("node:ready-vscode")).toMatchObject({
      canContinue: true,
      canArchive: false,
    });
    expect(sessionByHost.get("node:ready-atlas")).toMatchObject({
      canContinue: true,
      canArchive: false,
    });
    expect(sessionByHost.get("node:older-node")).toMatchObject({
      threadId: "thread-older-node",
      canContinue: false,
    });
    invoke.mockClear();
    await expect(
      getProvider()?.continueSession?.({
        hostId: "node:older-node",
        threadId: "thread-older-node",
        clientScopes: ["operator.admin"],
      }),
    ).rejects.toThrow("Update the node");
    expect(invoke).not.toHaveBeenCalled();
    expect(sessionByHost.get("node:missing-run")).toMatchObject({ canContinue: false });
    expect(sessionByHost.get("node:active")).toMatchObject({ canContinue: false });
    expect(sessionByHost.get("node:noninteractive")).toMatchObject({ canContinue: false });
    for (const nodeId of ["unix-source", "websocket-source", "missing-source", "invalid-source"]) {
      expect(sessionByHost.get(`node:${nodeId}`)).toMatchObject({
        threadId: `thread-${nodeId}`,
        canContinue: false,
      });
    }
  });

  it.each([false, undefined] as const)(
    "rejects stale Chat continuation when source support is %s",
    async (sourceSupport) => {
      let canContinueCodex: boolean | undefined = true;
      const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ command }) => ({
        payloadJSON: JSON.stringify(
          command === CODEX_APP_SERVER_THREADS_LIST_COMMAND
            ? {
                sourceHomeId: "a".repeat(64),
                canContinueCodex,
                sessions: [
                  {
                    threadId: "source-thread",
                    status: "notLoaded",
                    source: "cli",
                    archived: false,
                  },
                ],
              }
            : { data: [] },
        ),
      }));
      const { runtime, createSessionEntry } = createRuntime({
        nodes: [
          {
            nodeId: "source-node",
            connected: true,
            caps: [CODEX_CLI_SESSION_SOURCE_CAPABILITY],
            commands: [...CODEX_NODE_CONTINUE_COMMANDS],
            invocableCommands: [...CODEX_NODE_CONTINUE_COMMANDS],
          },
        ],
        invoke,
      });
      const { api, getProvider } = createGatewayApi(runtime);
      registerCodexSessionCatalog({
        api,
        bindingStore: createCodexTestBindingStore(),
        control: createControl(),
        getRuntimeConfig: () => config,
      });
      expect(await getProvider()?.list({ hostIds: ["node:source-node"] })).toMatchObject([
        { sessions: [{ threadId: "source-thread", canContinue: true }] },
      ]);
      canContinueCodex = sourceSupport;
      invoke.mockClear();
      await expect(
        getProvider()?.continueSession?.({
          hostId: "node:source-node",
          threadId: "source-thread",
          clientScopes: ["operator.admin"],
        }),
      ).rejects.toThrow("does not support Chat continuation");
      expect(invoke.mock.calls.map(([request]) => request.command)).toEqual([
        CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      ]);
      expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).not.toHaveBeenCalled();
      expect(createSessionEntry).not.toHaveBeenCalled();
    },
  );

  it("keeps node list and transcript reads on the native home across Gateway agent names and config reload", async () => {
    const codexHome = nodeTempDirs.make("codex-node-native-");
    const sessionsRoot = path.join(codexHome, "sessions");
    await fs.mkdir(sessionsRoot);
    const rollout = path.join(sessionsRoot, "source.jsonl");
    const thread = idleThread({ id: "thread-native", source: "cli", path: rollout });
    await fs.writeFile(
      rollout,
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: thread.id, source: "cli", originator: "codex_cli_rs" },
      })}\n`,
    );
    let runtimeConfig: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { nodeAlpha: {}, nodeBeta: {} } },
    };
    const factory = createCodexSessionCatalogControlFactory({
      env: { CODEX_HOME: path.relative(process.cwd(), codexHome) },
      getPluginConfig: () => undefined,
      getRuntimeConfig: () => runtimeConfig,
    });
    commandRpcMocks.codexControlRequest.mockImplementation(async (_config, method) =>
      method === "thread/list" ? { data: [thread] } : { data: [] },
    );
    pinnedConnectionMocks.request.mockImplementation(async ({ method }) =>
      method === "thread/read" ? { thread } : { data: [thread] },
    );
    const commands = createCodexSessionCatalogNodeHostCommands(factory);
    const listCommand = commands.find(
      (candidate) => candidate.command === CODEX_APP_SERVER_THREADS_LIST_COMMAND,
    )!;
    const transcriptCommand = commands.find(
      (candidate) => candidate.command === CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
    )!;
    const boundedTranscriptCommand = commands.find(
      (candidate) => candidate.command === CODEX_CATALOG_TRANSCRIPT_READ_COMMAND,
    )!;

    for (const agentId of ["gatewayOnly", undefined]) {
      await (await factory.forNode(agentId)).control.initialize();
      expect(
        JSON.parse(await listCommand.handle(JSON.stringify({ agentId, limit: 25 }))),
      ).toMatchObject({
        canContinueCodex: true,
        sessions: [{ threadId: thread.id }],
      });
      await expect(
        transcriptCommand.handle(JSON.stringify({ agentId, threadId: thread.id, limit: 25 })),
      ).resolves.toBe(JSON.stringify({ data: [] }));
      await expect(
        boundedTranscriptCommand.handle(
          JSON.stringify({ agentId, threadId: thread.id, limit: 25 }),
        ),
      ).resolves.toBe(JSON.stringify({ items: [] }));
      runtimeConfig = {
        agents: { ownership: "explicit", entries: { renamedNodeAgent: {} } },
      };
    }
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledWith(
      undefined,
      "thread/list",
      expect.any(Object),
      expect.objectContaining({
        agentDir: undefined,
        authProfileId: null,
        startOptions: expect.objectContaining({
          env: { CODEX_HOME: codexHome },
          homeScope: "user",
        }),
      }),
    );
    expect(pinnedConnectionMocks.getClient).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: undefined,
        authProfileId: null,
        startOptions: expect.objectContaining({
          env: { CODEX_HOME: codexHome },
          homeScope: "user",
        }),
      }),
    );
    await expect(listCommand.handle(JSON.stringify({ agentId: 42 }))).rejects.toThrow(
      "agentId must be a string",
    );
  });

  it.each([
    { transport: "unix", homeScope: "user" },
    { transport: "websocket", url: "ws://127.0.0.1:1234", homeScope: "agent" },
    { transport: "stdio", homeScope: "agent" },
  ])(
    "preserves the shipped explicit node source $transport/$homeScope without falling back",
    async (appServer) => {
      const nativeHome = nodeTempDirs.make("codex-node-configured-");
      let runtimeConfig: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
      };
      const factory = createCodexSessionCatalogControlFactory({
        env: {
          CODEX_HOME: path.relative(process.cwd(), nativeHome),
          OPENCLAW_STATE_DIR: nativeHome,
        },
        getPluginConfig: () => ({ appServer }),
        getRuntimeConfig: () => runtimeConfig,
      });
      const source = (await factory.homesForAgent("beta"))[0]!;
      const rollout = source.localSessionsRoot
        ? path.join(source.localSessionsRoot, "source.jsonl")
        : undefined;
      const thread = idleThread({
        id: "configured-thread",
        source: "cli",
        ...(rollout ? { path: rollout } : {}),
      });
      if (rollout) {
        await fs.mkdir(path.dirname(rollout), { recursive: true });
        await fs.writeFile(
          rollout,
          `${JSON.stringify({
            type: "session_meta",
            payload: {
              id: thread.id,
              source: "cli",
              originator: "codex_cli_rs",
            },
          })}\n`,
        );
      }
      commandRpcMocks.codexControlRequest.mockImplementation(async (_config, method) =>
        method === "thread/list" ? { data: [thread] } : { data: [] },
      );
      pinnedConnectionMocks.request.mockImplementation(async ({ method }) =>
        method === "thread/read" ? { thread } : { data: [thread] },
      );
      const commands = createCodexSessionCatalogNodeHostCommands(factory);
      const command = commands.find(
        (candidate) => candidate.command === CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      )!;
      const read = commands.find(
        (candidate) => candidate.command === CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
      )!;
      await (await factory.forNode("beta")).control.initialize();
      expect(
        JSON.parse(await command.handle(JSON.stringify({ agentId: "beta", limit: 25 }))),
      ).toMatchObject({
        canContinueCodex: appServer.transport === "stdio",
        sessions: [{ threadId: thread.id }],
      });
      await expect(
        read.handle(JSON.stringify({ agentId: "beta", threadId: thread.id, limit: 25 })),
      ).resolves.toBe(JSON.stringify({ data: [] }));
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledWith(
        { appServer },
        "thread/list",
        expect.any(Object),
        expect.objectContaining({
          agentDir: source.agentDir,
          startOptions: source.appServer.start,
        }),
      );
      expect(pinnedConnectionMocks.getClient).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDir: source.agentDir,
          startOptions: source.appServer.start,
        }),
      );
      commandRpcMocks.codexControlRequest.mockClear();
      await expect(command.handle(JSON.stringify({ limit: 25 }))).rejects.toThrow(
        "no explicit owner",
      );
      await expect(
        command.handle(JSON.stringify({ agentId: "gateway-only", limit: 25 })),
      ).rejects.toThrow("unknown Codex session catalog agent");
      runtimeConfig = {
        agents: { ownership: "explicit", entries: { alpha: {}, replacement: {} } },
      };
      await expect(command.handle(JSON.stringify({ agentId: "beta", limit: 25 }))).rejects.toThrow(
        "unknown Codex session catalog agent",
      );
      expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
    },
  );
});
