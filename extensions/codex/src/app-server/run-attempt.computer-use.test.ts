import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import * as elicitationBridge from "./elicitation-bridge.js";
import type { v2 } from "./protocol.js";
import { turnCompleted } from "./protocol.test-helpers.js";
import {
  createStartedThreadHarness,
  createTestParams,
  mockCall,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt", () => {
  it.each(["completed", "cancelled"] as const)(
    "routes Computer Use MCP elicitations through the native bridge (%s)",
    async (outcome) => {
      const bridgeSpy = vi
        .spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest")
        .mockResolvedValue({
          kind: "handled",
          response: { action: "accept", content: { approve: true }, _meta: null },
        });
      const request = async (method: string) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          const installed = {
            marketplaces: [
              {
                name: "openai-bundled",
                path: "/marketplaces/openai-bundled",
                plugins: [
                  {
                    id: "computer-use@openai-bundled",
                    name: "computer-use",
                    source: {
                      type: "local",
                      path: "/marketplaces/openai-bundled/plugins/computer-use",
                    },
                    installed: true,
                    enabled: true,
                  },
                ],
              },
            ],
            marketplaceLoadErrors: [],
          } satisfies v2.PluginInstalledResponse;
          return method === "plugin/installed"
            ? installed
            : ({ ...installed, featuredPluginIds: [] } satisfies v2.PluginListResponse);
        }
        if (method === "plugin/read") {
          return {
            plugin: {
              marketplaceName: "openai-bundled",
              marketplacePath: "/marketplaces/openai-bundled",
              summary: {
                id: "computer-use@openai-bundled",
                name: "computer-use",
                source: {
                  type: "local",
                  path: "/marketplaces/openai-bundled/plugins/computer-use",
                },
                installed: true,
                enabled: true,
              },
              description: null,
              skills: [],
              apps: [],
              mcpServers: ["computer-use"],
            },
          };
        }
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "desktop-control",
                tools: {
                  "computer-use.get_app_state": {},
                },
              },
            ],
            nextCursor: null,
          };
        }
        return undefined;
      };
      const elicitation = createStartedThreadHarness(request);
      const abortController = new AbortController();
      const params = createTestParams();
      params.abortSignal = abortController.signal;
      await attachSqliteSessionTarget(
        params,
        path.join(tempDir, "sessions.json"),
        "session-computer-use",
      );
      const run = runCodexAppServerAttempt(params, {
        pluginConfig: {
          computerUse: {
            enabled: true,
            marketplaceName: "openai-bundled",
            mcpServerName: "desktop-control",
          },
        },
      });
      // The keyed router only accepts turn-scoped requests once the turn is bound.
      await elicitation.waitForMethod("turn/start");
      const result = await elicitation.handleServerRequest({
        id: "request-elicitation-1",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "desktop-control",
          mode: "form",
        },
      });
      expect(result).toEqual({
        action: "accept",
        content: { approve: true },
        _meta: null,
      });
      const [bridgeCall] = mockCall(bridgeSpy, "elicitation bridge") as [
        {
          requestParams?: { serverName?: string };
          computerUseMcpServerName?: string;
          threadId?: string;
          turnId?: string;
        },
      ];
      expect(bridgeCall.threadId).toBe("thread-1");
      expect(bridgeCall.turnId).toBe("turn-1");
      expect(bridgeCall.requestParams?.serverName).toBe("desktop-control");
      expect(bridgeCall.computerUseMcpServerName).toBe("desktop-control");
      const turnStart = elicitation.requests.find(({ method }) => method === "turn/start");
      const turnStartParams = turnStart?.params as
        | { approvalPolicy?: { granular?: { mcp_elicitations?: boolean } } }
        | undefined;
      expect(turnStartParams?.approvalPolicy?.granular?.mcp_elicitations).toBe(true);
      if (outcome === "cancelled") {
        abortController.abort("user_cancelled");
        await elicitation.waitForMethod("turn/interrupt");
        expect(elicitation.requests.filter(({ method }) => method === "turn/interrupt")).toEqual([
          { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
        ]);
      } else {
        await elicitation.notify(turnCompleted({ id: "turn-1", status: "completed" }));
      }
      expect(readAttemptTerminal(await run)).toMatchObject({
        aborted: outcome === "cancelled",
        timedOut: false,
        promptError: null,
      });
      if (outcome === "cancelled") {
        expect(
          elicitation.requests.filter(({ method }) => method === "thread/backgroundTerminals/list"),
        ).toEqual([
          { method: "thread/backgroundTerminals/list", params: { threadId: "thread-1" } },
        ]);
      }
    },
  );
});
