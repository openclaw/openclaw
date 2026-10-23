import path from "node:path";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import * as elicitationBridge from "./elicitation-bridge.js";
import {
  pluginDetail,
  pluginInstalled,
  pluginList,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import { requestParams } from "./run-attempt-continuity.test-support.js";
import {
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

it("routes Computer Use MCP elicitations through the native bridge and cancels the turn", async () => {
  const bridgeSpy = vi
    .spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest")
    .mockResolvedValue({
      kind: "handled",
      response: { action: "accept", content: { approve: true }, _meta: null },
    });
  const marketplace = { name: "openai-bundled", path: "/marketplaces/openai-bundled" };
  const plugin = pluginSummary("computer-use@openai-bundled", {
    name: "computer-use",
    source: { type: "local", path: "/marketplaces/openai-bundled/plugins/computer-use" },
    installed: true,
    enabled: true,
  });
  const request = async (method: string) => {
    if (method === "plugin/installed") {
      return pluginInstalled([plugin], marketplace);
    }
    if (method === "plugin/list") {
      return pluginList([plugin], marketplace);
    }
    if (method === "plugin/read") {
      const detail = pluginDetail("computer-use", [], {
        marketplaceName: marketplace.name,
        marketplacePath: marketplace.path,
      });
      Object.assign(detail.plugin, { summary: plugin, mcpServers: ["computer-use"] });
      return detail;
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: [
          {
            name: "desktop-control",
            tools: { "computer-use.get_app_state": {} },
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
  expect(result).toEqual({ action: "accept", content: { approve: true }, _meta: null });
  expect(bridgeSpy.mock.calls[0]?.[0]).toMatchObject({
    threadId: "thread-1",
    turnId: "turn-1",
    requestParams: { serverName: "desktop-control" },
    computerUseMcpServerName: "desktop-control",
  });
  expect(requestParams(elicitation, "turn/start")).toMatchObject({
    approvalPolicy: { granular: { mcp_elicitations: true } },
  });
  abortController.abort("user_cancelled");
  const terminal = readAttemptTerminal(await run);
  expect(elicitation.requests.filter(({ method }) => method === "turn/interrupt")).toEqual([
    { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
  ]);
  expect(terminal).toMatchObject({
    aborted: true,
    timedOut: false,
    promptError: null,
  });
  expect(
    elicitation.requests.filter(({ method }) => method === "thread/backgroundTerminals/list"),
  ).toEqual([{ method: "thread/backgroundTerminals/list", params: { threadId: "thread-1" } }]);
});
