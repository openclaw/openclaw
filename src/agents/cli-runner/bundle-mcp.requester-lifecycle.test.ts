import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { materializeRequesterScopedMcpToolsForHarnessRunCore } from "../agent-bundle-mcp-harness.js";
import { startMcpLifecycleServer } from "../agent-bundle-mcp-lifecycle.test-support.js";
import {
  retireSessionMcpRuntime,
  setSessionMcpRuntimeScheduler,
} from "../agent-bundle-mcp-manager-api.js";
import { createMcpProofPluginRegistry } from "../mcp-connection-resolver.test-fixtures.js";
import { prepareNativeMcpTestConfig } from "./bundle-mcp.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps requester tools callable across static native preflight until session closure", async () => {
  const workspaceDir = tempDirs.make("openclaw-mcp-requester-discovery-");
  const deleted: string[] = [];
  const server = await startMcpLifecycleServer({
    toolName: "read_note",
    onDelete: async (endpoint) => {
      deleted.push(endpoint);
    },
    text: (endpoint, sessionId) => `${endpoint}:${sessionId}`,
  });
  const registry = createMcpProofPluginRegistry();
  registry.apiFor("test-plugin").registerMcpServerConnectionResolver({
    serverName: "requester",
    resolve: async () => ({ url: `${server.url}/requester` }),
  });
  const sessionId = "mixed-native-discovery";
  const sessionKey = `agent:main:${sessionId}`;
  const scheduler = createTestGatewayScheduler();
  try {
    await setSessionMcpRuntimeScheduler(scheduler);
    await withEnvAsync({ OPENCLAW_STATE_DIR: workspaceDir }, async () => {
      await withPluginRuntimeRegistryScope(registry.registry, async () => {
        const config: OpenClawConfig = {
          plugins: { enabled: false },
          mcp: {
            servers: {
              static: { transport: "streamable-http", url: `${server.url}/static` },
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
            content: [{ type: "text", text: "/requester:1" }],
          });
          expect(deleted).toEqual([]);
          await retireSessionMcpRuntime({
            sessionId,
            reason: "session-end",
            preserveActiveLeases: true,
          });
          expect(deleted).toEqual([]);
        } finally {
          await tools?.dispose();
        }
        expect(deleted.toSorted()).toEqual(["/requester", "/static"]);
      });
    });
  } finally {
    await retireSessionMcpRuntime({ sessionId, reason: "mixed-discovery-test-cleanup" });
    await scheduler.stop();
    await server.close();
  }
});
