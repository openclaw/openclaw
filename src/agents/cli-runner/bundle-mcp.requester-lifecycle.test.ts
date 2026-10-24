import { json } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { materializeRequesterScopedMcpToolsForHarnessRunCore } from "../agent-bundle-mcp-harness.js";
import {
  getAdvertisedScopedMcpCatalog,
  retireSessionMcpRuntime,
  setSessionMcpRuntimeScheduler,
} from "../agent-bundle-mcp-manager-api.js";
import { getSessionMcpRuntimeTestManager } from "../agent-bundle-mcp-manager.test-support.js";
import { createMcpProofPluginRegistry } from "../mcp-connection-resolver.test-fixtures.js";
import { startCompletionServer } from "../simple-completion.test-support.js";
import { prepareNativeMcpTestConfig } from "./bundle-mcp.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps requester tools callable across static native preflight until session closure", async () => {
  const workspaceDir = tempDirs.make("openclaw-mcp-requester-discovery-");
  const sessions = new Set<string>();
  const deleted: string[] = [];
  const server = await startCompletionServer((request, response) => {
    void (async () => {
      const sessionId = String(request.headers["mcp-session-id"]);
      if (request.method === "DELETE") {
        sessions.delete(sessionId);
        deleted.push(sessionId);
        response.writeHead(200).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const message = (await json(request)) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string };
      };
      let result;
      if (message.method === "initialize") {
        const id = request.url === "/requester" ? "requester-session" : "static-session";
        sessions.add(id);
        response.setHeader("mcp-session-id", id);
        result = {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "mixed-discovery", version: "1" },
        };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: "read_note", inputSchema: { type: "object" } }] };
      } else if (message.method === "tools/call") {
        result = { content: [{ type: "text", text: sessionId }] };
      }
      if (!result) {
        response.writeHead(202).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })().catch(() => response.writeHead(500).end());
  });
  const url = server.origin;
  const registry = createMcpProofPluginRegistry();
  registry.apiFor("test-plugin").registerMcpServerConnectionResolver({
    serverName: "requester",
    resolve: async () => ({ url: `${url}/requester` }),
  });
  const sessionId = "mixed-native-discovery";
  const sessionKey = `agent:main:${sessionId}`;
  const scheduler = createTestGatewayScheduler();
  try {
    await setSessionMcpRuntimeScheduler(scheduler);
    await withEnvAsync({ OPENCLAW_STATE_DIR: workspaceDir }, async () => {
      await withPluginRuntimeRegistryScope(registry.registry, async () => {
        const manager = getSessionMcpRuntimeTestManager();
        expect(manager.listSessionIds()).not.toContain(sessionId);
        const config: OpenClawConfig = {
          plugins: { enabled: false },
          mcp: {
            servers: {
              static: { transport: "streamable-http", url: `${url}/static` },
              requester: { transport: "streamable-http" },
            },
          },
        };
        const tools = await materializeRequesterScopedMcpToolsForHarnessRunCore({
          sessionId,
          sessionKey,
          workspaceDir,
          cfg: config,
          requesterSenderId: "alice",
        });
        expect(tools?.tools.map((tool) => tool.name)).toEqual(["requester__read_note"]);
        try {
          const patch = await prepareNativeMcpTestConfig({
            workspaceDir,
            sessionId,
            config,
            senderId: "alice",
          });
          expect(Object.keys(patch?.mcp_servers ?? {})).toEqual(["static"]);
          const requesterTool = expectDefined(tools?.tools[0], "requester tool");
          await expect(requesterTool.execute("after-preflight", {})).resolves.toMatchObject({
            content: [{ type: "text", text: "requester-session" }],
          });
          expect(deleted).toEqual([]);
          expect(sessions).toEqual(new Set(["requester-session", "static-session"]));
          expect(
            getAdvertisedScopedMcpCatalog(sessionId)?.tools.map((tool) => tool.serverName),
          ).toEqual(["requester"]);
          await retireSessionMcpRuntime({
            sessionId,
            reason: "session-end",
            preserveActiveLeases: true,
          });
          expect(deleted).toEqual([]);
        } finally {
          await tools?.dispose();
        }
        expect(sessions.size).toBe(0);
        expect(deleted.toSorted()).toEqual(["requester-session", "static-session"]);
        expect(manager.listSessionIds()).not.toContain(sessionId);
      });
    });
  } finally {
    await retireSessionMcpRuntime({ sessionId, reason: "mixed-discovery-test-cleanup" });
    await scheduler.stop();
    await server[Symbol.asyncDispose]();
  }
});
