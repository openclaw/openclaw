import path from "node:path";
import { createCombinedSessionMcpRuntime } from "./agent-bundle-mcp-combined.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import { writeListToolsMcpServer } from "./agent-bundle-mcp-stdio.test-support.js";

export async function createConnectionInvalidationMcpFixture(
  tempDir: string,
  receiptEndpoint: string,
) {
  const invalidatingServer = {
    serverName: "invalidatingServer",
    serverPath: path.join(tempDir, "invalidating-server.mjs"),
    logPath: path.join(tempDir, "invalidating-server.log"),
  };
  const slowConnectServer = {
    serverName: "slowConnectServer",
    serverPath: path.join(tempDir, "slow-connect-server.mjs"),
    logPath: path.join(tempDir, "slow-connect-server.log"),
  };
  await writeListToolsMcpServer(
    {
      filePath: invalidatingServer.serverPath,
      logPath: invalidatingServer.logPath,
      capabilities: { tools: { listChanged: true } },
      notifyListChangedOnInitialized: true,
      notifyListChangedOnInitializedReleaseToken: "invalidate-while-connecting",
    },
    receiptEndpoint,
  );
  await writeListToolsMcpServer(
    {
      filePath: slowConnectServer.serverPath,
      logPath: slowConnectServer.logPath,
      initializeReleaseToken: "finish-connecting",
    },
    receiptEndpoint,
  );
  const runtimeParams = {
    sessionId: "session-inflight-connect-test",
    sessionKey: "agent:test:session-inflight-connect-test",
    workspaceDir: "/workspace",
    cfg: {
      mcp: {
        servers: Object.fromEntries(
          [invalidatingServer, slowConnectServer].map(({ serverName, serverPath }) => [
            serverName,
            { command: process.execPath, args: [serverPath], connectionTimeoutMs: 2_000 },
          ]),
        ),
      },
    },
  };
  // Keep the production composition, with visible owners for client-side invalidation.
  const invalidatingRuntime = createSessionMcpRuntime({
    ...runtimeParams,
    includeServerNames: new Set([invalidatingServer.serverName]),
  });
  const slowRuntime = createSessionMcpRuntime({
    ...runtimeParams,
    includeServerNames: new Set([slowConnectServer.serverName]),
  });
  return {
    invalidatingServer,
    slowConnectServer,
    invalidatingRuntime,
    runtime: createCombinedSessionMcpRuntime({
      ...runtimeParams,
      parts: [invalidatingRuntime, slowRuntime],
    }),
  };
}
