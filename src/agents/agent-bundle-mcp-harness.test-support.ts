import {
  fixtureCatalog,
  fixtureRuntime,
  withFixtureLeases,
} from "./agent-bundle-mcp-fixture.test-support.js";
import { createRequesterMcpConnect } from "./agent-bundle-mcp-requester-connect.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

type Requester = { sessionId: string; requesterSenderId: string };

export function makeRuntime(params: Requester): SessionMcpRuntime {
  const catalog = fixtureCatalog("user-mail", [{ toolName: "inbox", description: "read inbox" }]);
  const runtime = fixtureRuntime(() => catalog, {
    sessionId: params.sessionId,
    configFingerprint: "fp",
    requesterScope: { requesterSenderId: params.requesterSenderId },
    peekCatalog: () => catalog,
    callTool: async (_server, toolName) => ({
      content: [{ type: "text", text: `live:${toolName}:${params.requesterSenderId}` }],
      isError: false,
    }),
  });
  runtime.createdAt = Date.now();
  return withFixtureLeases(runtime, true);
}

export async function makeConnectRuntime(
  params: Requester & { publicOrigin?: string },
): Promise<SessionMcpRuntime> {
  const runtime = makeRuntime(params);
  const catalog = { version: 1, generatedAt: 0, servers: {}, tools: [] };
  runtime.peekCatalog = () => catalog;
  runtime.getCatalog = async () => catalog;
  runtime.requesterConnect = await createRequesterMcpConnect({
    serverNames: new Set(["calendar"]),
    mcpServers: {
      calendar: {
        url: "https://mcp.example/rpc",
        auth: "oauth",
        oauth: { identity: "per-requester" },
      },
    },
    safeServerNamesByServer: new Map([["calendar", "calendar"]]),
    requesterScope: {
      requesterSenderId: params.requesterSenderId,
      messageChannel: "telegram",
      agentAccountId: "bot",
    },
    cfg: params.publicOrigin ? { gateway: { publicOrigin: params.publicOrigin } } : undefined,
    configFingerprint: "connect-fingerprint",
  });
  return runtime;
}
