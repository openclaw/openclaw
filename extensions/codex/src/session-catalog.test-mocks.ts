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
const nodeHostMocks = await vi.hoisted(async () => {
  const { createNodeHostMocks } = await import("../../test-support/node-host.test-support.js");
  return createNodeHostMocks({ userShellFallback: true });
});

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
// mock-isolation: Shared owner preserves real exports with fresh command-resolution mocks.
vi.mock("openclaw/plugin-sdk/node-host", nodeHostMocks.mockRuntime);

export { commandRpcMocks, pinnedConnectionMocks, transcriptMirrorMocks, nodeHostMocks };
