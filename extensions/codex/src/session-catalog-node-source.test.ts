import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_CLI_SESSION_SOURCE_CAPABILITY } from "./node-cli-sessions.js";
import { catalogRow } from "./session-catalog-index.test-support.js";
import { catalogFactory, catalogProvider } from "./session-catalog-resident.test-support.js";
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
  createControl,
  createRuntime,
  transcriptMirrorMocks,
  type PluginRuntime,
  idleThread,
  fs,
  path,
  type OpenClawConfig,
  config,
  nodeHostMocks,
  resolveCodexAppServerLocalHomeDir,
  CODEX_LOCAL_SESSION_HOST_ID,
  type CodexCatalogHome,
} from "./session-catalog.test-helpers.js";

const nodeTempDirs = useAutoCleanupTempDirTracker(afterEach);
const pairedNode = (nodeId: string) => ({
  nodeId,
  connected: true,
  caps: [CODEX_CLI_SESSION_SOURCE_CAPABILITY],
  commands: [...CODEX_NODE_CONTINUE_COMMANDS],
  invocableCommands: [...CODEX_NODE_CONTINUE_COMMANDS],
});
const nodeListing = (
  threadId: string,
  canContinueCodex: unknown,
  status = "notLoaded",
  source = "cli",
) => ({
  sourceHomeId: "a".repeat(64),
  canContinueCodex,
  sessions: [{ threadId, status, source, archived: false }],
});

async function nativeCommands(
  factory: ReturnType<typeof createCodexSessionCatalogControlFactory>,
  thread: ReturnType<typeof idleThread>,
) {
  if (thread.path) {
    await fs.mkdir(path.dirname(thread.path), { recursive: true });
    await fs.writeFile(
      thread.path,
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: thread.id, source: "cli", originator: "codex_cli_rs" },
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
  return (command: string, params: Record<string, unknown>) =>
    commands.find((candidate) => candidate.command === command)!.handle(JSON.stringify(params));
}

describe("Codex node catalog sources", () => {
  it("marks paired-node rows continuable only with complete permitted capabilities", async () => {
    const sourceByNode = new Map([
      ["ready-cli", ["idle", "cli"]],
      ["ready-vscode", ["notLoaded", "vscode"]],
      ["ready-atlas", ["notLoaded", "atlas"]],
      ["older-node", ["notLoaded", "cli"]],
      ["unix-source", ["notLoaded", "cli"]],
      ["missing-source", ["notLoaded", "cli"]],
      ["invalid-source", ["notLoaded", "cli"]],
      ["missing-run", ["idle", "cli"]],
      ["active", ["active", "cli"]],
      ["noninteractive", ["idle", "exec"]],
    ]);
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ nodeId }) => {
      const source = sourceByNode.get(nodeId);
      if (!source) {
        throw new Error("unexpected node");
      }
      return {
        payloadJSON: JSON.stringify(
          nodeListing(
            `thread-${nodeId}`,
            nodeId === "missing-source"
              ? undefined
              : nodeId === "invalid-source"
                ? "true"
                : nodeId !== "unix-source",
            source[0],
            source[1],
          ),
        ),
      };
    });
    const { runtime } = createRuntime({
      nodes: [...sourceByNode.keys()].map((nodeId) =>
        Object.assign(pairedNode(nodeId), {
          displayName: nodeId,
          caps: nodeId === "older-node" ? [] : [CODEX_CLI_SESSION_SOURCE_CAPABILITY],
          invocableCommands:
            nodeId === "missing-run"
              ? CODEX_NODE_CONTINUE_COMMANDS.filter(
                  (command) => command !== CODEX_CLI_SESSION_RESUME_COMMAND,
                )
              : [...CODEX_NODE_CONTINUE_COMMANDS],
        }),
      ),
      invoke,
    });
    const provider = catalogProvider(createControl(), runtime);

    const hosts = await provider.list({
      hostIds: [...sourceByNode.keys()].map((id) => `node:${id}`),
    });
    const sessionByHost = new Map(hosts?.map((host) => [host.hostId, host.sessions[0]]) ?? []);
    for (const nodeId of sourceByNode.keys()) {
      expect(sessionByHost.get(`node:${nodeId}`)).toMatchObject({
        threadId: `thread-${nodeId}`,
        canContinue: nodeId.startsWith("ready-"),
        canArchive: false,
      });
    }
    invoke.mockClear();
    await expect(
      provider.continueSession?.({
        hostId: "node:older-node",
        threadId: "thread-older-node",
        clientScopes: ["operator.admin"],
      }),
    ).rejects.toThrow("Update the node");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([false, undefined] as const)(
    "rejects stale Chat continuation when source support is %s",
    async (sourceSupport) => {
      let canContinueCodex: boolean | undefined = true;
      const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ command }) => ({
        payloadJSON: JSON.stringify(
          command === CODEX_APP_SERVER_THREADS_LIST_COMMAND
            ? nodeListing("source-thread", canContinueCodex)
            : { data: [] },
        ),
      }));
      const { runtime, createSessionEntry } = createRuntime({
        nodes: [pairedNode("source-node")],
        invoke,
      });
      const provider = catalogProvider(createControl(), runtime);
      expect(await provider.list({ hostIds: ["node:source-node"] })).toMatchObject([
        { sessions: [{ threadId: "source-thread", canContinue: true }] },
      ]);
      canContinueCodex = sourceSupport;
      invoke.mockClear();
      await expect(
        provider.continueSession?.({
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
    const thread = idleThread({
      id: "thread-native",
      source: "cli",
      path: path.join(codexHome, "sessions", "source.jsonl"),
    });
    let runtimeConfig: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { nodeAlpha: {}, nodeBeta: {} } },
    };
    const factory = createCodexSessionCatalogControlFactory({
      env: { CODEX_HOME: path.relative(process.cwd(), codexHome) },
      getPluginConfig: () => undefined,
      getRuntimeConfig: () => runtimeConfig,
    });
    const command = await nativeCommands(factory, thread);

    for (const agentId of ["gatewayOnly", undefined]) {
      await (await factory.forNode(agentId)).control.initialize();
      const params = { agentId, threadId: thread.id, limit: 25 };
      expect(
        JSON.parse(await command(CODEX_APP_SERVER_THREADS_LIST_COMMAND, { agentId, limit: 25 })),
      ).toMatchObject({
        canContinueCodex: true,
        sessions: [{ threadId: thread.id }],
      });
      await expect(command(CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND, params)).resolves.toBe(
        JSON.stringify({ data: [] }),
      );
      await expect(command(CODEX_CATALOG_TRANSCRIPT_READ_COMMAND, params)).resolves.toBe(
        JSON.stringify({ items: [] }),
      );
      runtimeConfig = {
        agents: { ownership: "explicit", entries: { renamedNodeAgent: {} } },
      };
    }
    const nativeScope = expect.objectContaining({
      agentDir: undefined,
      authProfileId: null,
      startOptions: expect.objectContaining({ env: { CODEX_HOME: codexHome }, homeScope: "user" }),
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledWith(
      {},
      "thread/list",
      expect.any(Object),
      nativeScope,
    );
    expect(pinnedConnectionMocks.getClient).toHaveBeenCalledWith(nativeScope);
    await expect(command(CODEX_APP_SERVER_THREADS_LIST_COMMAND, { agentId: 42 })).rejects.toThrow(
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
      const command = await nativeCommands(factory, thread);
      const list = (agentId?: string) =>
        command(CODEX_APP_SERVER_THREADS_LIST_COMMAND, { agentId, limit: 25 });
      await (await factory.forNode("beta")).control.initialize();
      expect(JSON.parse(await list("beta"))).toMatchObject({
        canContinueCodex: appServer.transport === "stdio",
        sessions: [{ threadId: thread.id }],
      });
      await expect(
        command(CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND, {
          agentId: "beta",
          threadId: thread.id,
          limit: 25,
        }),
      ).resolves.toBe(JSON.stringify({ data: [] }));
      const configuredScope = expect.objectContaining({
        agentDir: source.agentDir,
        startOptions: source.appServer.start,
      });
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledWith(
        { appServer },
        "thread/list",
        expect.any(Object),
        configuredScope,
      );
      expect(pinnedConnectionMocks.getClient).toHaveBeenCalledWith(configuredScope);
      commandRpcMocks.codexControlRequest.mockClear();
      await expect(list()).rejects.toThrow("no explicit owner");
      await expect(list("gateway-only")).rejects.toThrow("unknown Codex session catalog agent");
      runtimeConfig = {
        agents: { ownership: "explicit", entries: { alpha: {}, replacement: {} } },
      };
      await expect(list("beta")).rejects.toThrow("unknown Codex session catalog agent");
      expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["stdio", "websocket"] as const)(
    "keeps terminal capabilities and execution on the selected %s source",
    async (transport) => {
      const binDir = nodeTempDirs.make("codex-terminal-source-");
      const executable = path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
      await fs.writeFile(
        executable,
        process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n",
      );
      if (process.platform !== "win32") {
        await fs.chmod(executable, 0o755);
      }
      process.env.PATH = "";
      nodeHostMocks.userShellPaths.set("codex", binDir);
      const factory = catalogFactory({
        getPluginConfig: () => undefined,
        getRuntimeConfig: () => config,
      });
      const primary = (await factory.homesForAgent("main"))[0]!;
      const local = transport === "stdio";
      const source: CodexCatalogHome = {
        ...primary,
        sourceHomeId: local ? "synthetic-home-secondary" : "synthetic-home-remote",
        hostId: local
          ? CODEX_LOCAL_SESSION_HOST_ID
          : `${CODEX_LOCAL_SESSION_HOST_ID}:synthetic-home-remote`,
        label: local ? "Local Codex · Secondary" : "Remote Codex",
        appServer: { ...primary.appServer, start: { ...primary.appServer.start, transport } },
      };
      const threadId = "123e4567-e89b-12d3-a456-426614174000";
      const control = createControl({
        listPage: async () => catalogRow(threadId, 100, { status: "idle", source: "cli" }).page,
      });
      const provider = catalogProvider({
        ...factory,
        homesForAgent: async () => [source],
        forRequest: () => control,
      });
      expect(await provider.list({})).toMatchObject([
        {
          hostId: source.hostId,
          canStartTerminal: local,
          sessions: [{ threadId, canOpenTerminal: local }],
        },
      ]);
      const request = { hostId: source.hostId, threadId, sourceHomeId: source.sourceHomeId };
      if (local) {
        await expect(provider.openTerminal!(request)).resolves.toMatchObject({
          kind: "local",
          argv: [executable, "resume", threadId],
          env: {
            CODEX_HOME: resolveCodexAppServerLocalHomeDir(source.appServer.start, source.agentDir),
          },
        });
      } else {
        await expect(provider.openTerminal!(request)).rejects.toThrow(
          "Native terminal requires a local Codex source",
        );
      }
      await expect(
        provider.openTerminal!({ ...request, sourceHomeId: "removed-home" }),
      ).rejects.toThrow("Codex session source home is unavailable");
    },
  );
});
