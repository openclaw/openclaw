import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import * as elicitationBridge from "./elicitation-bridge.js";
import type { v2 } from "./protocol.js";
import {
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt", () => {
  it("routes Computer Use MCP elicitations through the native bridge and cancels the turn", async () => {
    const turnInterrupted = createDeferred<void>();
    const bridgeSpy = vi
      .spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest")
      .mockResolvedValue({
        kind: "handled",
        response: { action: "accept", content: { approve: true }, _meta: null },
      });
    const plugin = {
      id: "computer-use@openai-bundled",
      name: "computer-use",
      source: { type: "local", path: "/marketplaces/openai-bundled/plugins/computer-use" },
      installed: true,
      enabled: true,
    } satisfies v2.PluginInstalledResponse["marketplaces"][number]["plugins"][number];
    const request = async (method: string) => {
      if (method === "turn/interrupt") {
        turnInterrupted.resolve();
      }
      if (method === "plugin/installed" || method === "plugin/list") {
        const installed = {
          marketplaces: [
            {
              name: "openai-bundled",
              path: "/marketplaces/openai-bundled",
              plugins: [plugin],
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
            summary: plugin,
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
    // Protocol events drive these cases; cold startup must not spend the execution budget.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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
    await run.waitForTurnAccepted();
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
    expect(bridgeSpy.mock.calls[0]?.[0]).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      requestParams: { serverName: "desktop-control" },
      computerUseMcpServerName: "desktop-control",
    });
    const turnStart = elicitation.requests.find(({ method }) => method === "turn/start");
    const turnStartParams = turnStart?.params as
      | { approvalPolicy?: { granular?: { mcp_elicitations?: boolean } } }
      | undefined;
    expect(turnStartParams?.approvalPolicy?.granular?.mcp_elicitations).toBe(true);
    abortController.abort("user_cancelled");
    await turnInterrupted.promise;
    expect(elicitation.requests.filter(({ method }) => method === "turn/interrupt")).toEqual([
      { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
    ]);
    expect(readAttemptTerminal(await run)).toMatchObject({
      aborted: true,
      timedOut: false,
      promptError: null,
    });
    expect(
      elicitation.requests.filter(({ method }) => method === "thread/backgroundTerminals/list"),
    ).toEqual([{ method: "thread/backgroundTerminals/list", params: { threadId: "thread-1" } }]);
  });
});
