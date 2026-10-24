import { vi, type Mock } from "vitest";

const commandRpcMocks = vi.hoisted(() => ({
  codexControlRequest: vi.fn() as Mock,
}));
const pinnedConnectionMocks = vi.hoisted(() => ({
  client: {
    connectionId: "pinned-catalog-client",
    getInstanceId: () => "pinned-catalog-client",
  },
  getClient: vi.fn() as Mock,
  releaseClient: vi.fn() as Mock,
  request: vi.fn() as Mock,
}));
const transcriptMirrorMocks = vi.hoisted(() => ({
  importCodexThreadHistoryToTranscript: vi.fn<
    typeof import("./app-server/transcript-mirror.js").importCodexThreadHistoryToTranscript
  >(async () => undefined),
}));
const nodeHostMocks = vi.hoisted(() => ({
  runNodePtyCommand: vi.fn(async () => ({ exitCode: 0 })),
  userShellPaths: new Map<string, string>(),
}));

vi.mock("./command-rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./command-rpc.js")>();
  const { codexCatalogSourceForClient, getCodexCatalogSource, recordCodexCatalogResponseSource } =
    await import("./session-catalog-source.js");
  return {
    ...actual,
    codexControlRequest: async (
      ...args: Parameters<typeof import("./command-rpc.js").codexControlRequest>
    ) => {
      let response = await commandRpcMocks.codexControlRequest(...args);
      const source =
        getCodexCatalogSource(response) ??
        codexCatalogSourceForClient(commandRpcMocks.codexControlRequest);
      if (args[1] === "thread/list" && args[3]?.catalogPreview) {
        const [{ projectCodexCatalogNativeResponse }, { sanitizeTerminalText }] = await Promise.all(
          [
            import("./session-catalog-native-projection.js"),
            import("openclaw/plugin-sdk/text-chunking"),
          ],
        );
        response = projectCodexCatalogNativeResponse(
          response,
          sanitizeTerminalText,
          args[3].catalogPreviewCache,
          args[3].catalogRows,
        );
      }
      recordCodexCatalogResponseSource(args[1], response, source);
      return response;
    },
  };
});
vi.mock("./app-server/request.js", () => ({
  requestCodexAppServerClientJson: pinnedConnectionMocks.request,
}));
vi.mock("./app-server/shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-server/shared-client.js")>()),
  getLeasedSharedCodexAppServerClient: pinnedConnectionMocks.getClient,
  releaseLeasedSharedCodexAppServerClient: pinnedConnectionMocks.releaseClient,
}));
vi.mock("./app-server/transcript-mirror.js", () => ({
  importCodexThreadHistoryToTranscript: transcriptMirrorMocks.importCodexThreadHistoryToTranscript,
}));
vi.mock("openclaw/plugin-sdk/node-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/node-host")>();
  return {
    ...actual,
    runNodePtyCommand: nodeHostMocks.runNodePtyCommand,
    resolveNodeHostExecutable: (
      command: string,
      options: {
        env?: NodeJS.ProcessEnv;
        pathEnv?: string;
        includeExtensionless?: boolean;
        strategy: "direct" | "fallback" | "prefer";
      },
    ) => {
      const env = options.env ?? process.env;
      const pathEnv = options.pathEnv ?? env.PATH ?? env.Path ?? "";
      const direct = actual.resolveNodeHostExecutable(command, {
        env,
        pathEnv,
        includeExtensionless: options.includeExtensionless,
        strategy: "direct",
      });
      if (direct && options.strategy !== "prefer") {
        return direct;
      }
      const shellPath = nodeHostMocks.userShellPaths.get(command);
      if (!shellPath) {
        return direct;
      }
      const shellExecutable = actual.resolveNodeHostExecutable(command, {
        env,
        pathEnv: shellPath,
        includeExtensionless: options.includeExtensionless,
        strategy: "direct",
      });
      return shellExecutable
        ? { executable: shellExecutable.executable, pathEnv: shellPath }
        : direct;
    },
  };
});

export { commandRpcMocks, pinnedConnectionMocks, transcriptMirrorMocks, nodeHostMocks };
