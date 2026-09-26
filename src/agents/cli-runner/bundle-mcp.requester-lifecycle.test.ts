import http from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { materializeRequesterScopedMcpToolsForHarnessRunCore } from "../agent-bundle-mcp-harness.js";
import {
  getAdvertisedScopedMcpCatalog,
  getSessionMcpRuntimeManagerForTesting,
  retireSessionMcpRuntime,
} from "../agent-bundle-mcp-manager-api.js";
import { createMcpProofPluginRegistry } from "../mcp-connection-resolver.test-fixtures.js";
import { AuthStorage } from "../sessions/auth-storage.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import { buildCodexUserMcpServersThreadConfigPatchForRun } from "./bundle-mcp-codex.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps requester tools callable across static native preflight until session closure", async () => {
  const workspaceDir = tempDirs.make("openclaw-mcp-requester-discovery-");
  const sessions = new Set<string>();
  const deleted: string[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method === "DELETE") {
        const id = String(request.headers["mcp-session-id"]);
        sessions.delete(id);
        deleted.push(id);
        response.writeHead(200).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
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
        result = {
          content: [{ type: "text", text: String(request.headers["mcp-session-id"]) }],
        };
      }
      if (!result) {
        response.writeHead(202).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("MCP proof server did not acquire a loopback port");
  }
  const url = `http://127.0.0.1:${address.port}`;
  const registry = createMcpProofPluginRegistry();
  registry.apiFor("test-plugin").registerMcpServerConnectionResolver({
    serverName: "requester",
    resolve: async () => ({ url: `${url}/requester` }),
  });
  const sessionId = "mixed-native-discovery";
  const sessionKey = `agent:main:${sessionId}`;
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: workspaceDir }, async () => {
      await withPluginRuntimeRegistryScope(registry.registry, async () => {
        const manager = getSessionMcpRuntimeManagerForTesting();
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
          const authStorage = AuthStorage.inMemory();
          const patch = await buildCodexUserMcpServersThreadConfigPatchForRun({
            cwd: workspaceDir,
            run: {
              agentId: "main",
              sessionId,
              sessionKey,
              sessionFile: sessionKey,
              workspaceDir,
              config,
              senderId: "alice",
              prompt: "hello",
              timeoutMs: 5_000,
              runId: sessionId,
              provider: "openai",
              modelId: "gpt-5.6-luna",
              model: {
                id: "gpt-5.6-luna",
                name: "Test model",
                api: "openai-responses",
                provider: "openai",
                baseUrl: "http://127.0.0.1:1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 100_000,
                maxTokens: 1_000,
              },
              authStorage,
              authProfileStore: { version: 1, profiles: {} },
              modelRegistry: ModelRegistry.inMemory(authStorage),
              thinkLevel: "off",
            },
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
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
