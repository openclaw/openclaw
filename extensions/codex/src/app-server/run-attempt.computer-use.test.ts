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

it("routes Computer Use MCP elicitations through the native bridge", async () => {
  const response = { action: "accept" as const, content: { approve: true }, _meta: null };
  const bridgeSpy = vi
    .spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest")
    .mockResolvedValue({ kind: "handled", response: structuredClone(response) });
  const marketplace = { name: "openai-bundled", path: "/marketplaces/openai-bundled" };
  const plugin = pluginSummary("computer-use@openai-bundled", {
    name: "computer-use",
    source: { type: "local", path: "/marketplaces/openai-bundled/plugins/computer-use" },
    installed: true,
    enabled: true,
  });
  const detail = pluginDetail("computer-use", [], {
    marketplaceName: marketplace.name,
    marketplacePath: marketplace.path,
    mcpServers: ["computer-use"],
  });
  detail.plugin.summary = plugin;
  const responses: Record<string, unknown> = {
    "plugin/installed": pluginInstalled([plugin], marketplace),
    "plugin/list": pluginList([plugin], marketplace),
    "plugin/read": detail,
    "mcpServerStatus/list": {
      data: [{ name: "desktop-control", tools: { "computer-use.get_app_state": {} } }],
      nextCursor: null,
    },
  };
  const elicitation = createStartedThreadHarness(async (method) =>
    Object.hasOwn(responses, method) ? responses[method] : undefined,
  );
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
  expect(result).toEqual(response);
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
  expect(readAttemptTerminal(await run).promptError).toBeNull();
});
