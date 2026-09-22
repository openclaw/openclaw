import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  commandRpcMocks,
  pinnedConnectionMocks,
  createCodexSessionCatalogControlFactory,
  createCodexSessionCatalogNodeHostCommands,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_CATALOG_TRANSCRIPT_READ_COMMAND,
  idleThread,
  fs,
  path,
  type OpenClawConfig,
} from "./session-catalog.test-helpers.js";

const nodeTempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Codex node catalog sources", () => {
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
      env: { CODEX_HOME: codexHome },
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
      expect(
        JSON.parse(await listCommand.handle(JSON.stringify({ agentId, limit: 25 }))),
      ).toMatchObject({
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
        env: { CODEX_HOME: nativeHome, OPENCLAW_STATE_DIR: nativeHome },
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
      expect(
        JSON.parse(await command.handle(JSON.stringify({ agentId: "beta", limit: 25 }))),
      ).toMatchObject({
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
