import { afterEach, expect, it, type Mock } from "vitest";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { resetAdjustedParamsByToolCallIdForTests } from "./agent-tools.before-tool-call.state.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";
import { resolveToolSearchConfig } from "./tool-search-config.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { AnyAgentTool } from "./tools/common.js";

type SessionsSendTimeoutFixtures = {
  getSessionTool: (
    name: "sessions_send",
    options: { agentSessionKey: string; agentChannel: string },
  ) => AnyAgentTool;
  callGatewayMock: Mock;
};

export function registerSessionsSendTimeoutTests({
  getSessionTool,
  callGatewayMock,
}: SessionsSendTimeoutFixtures) {
  afterEach(resetAdjustedParamsByToolCallIdForTests);

  it.each([
    {
      name: "terminal timeout with an explicit diagnostic",
      waitResult: {
        status: "timeout",
        endedAt: 3000,
        stopReason: "timeout",
        error: "agent run timed out",
      },
      expectedError: "agent run timed out",
    },
    {
      name: "terminal timeout with a provider-specific diagnostic",
      waitResult: {
        status: "timeout",
        endedAt: 3000,
        stopReason: "timeout",
        error: "provider request exceeded its deadline",
      },
      expectedError: "provider request exceeded its deadline",
    },
    {
      name: "provider-attributed terminal timeout without a diagnostic",
      waitResult: {
        status: "ok",
        endedAt: 3000,
        timeoutPhase: "provider",
        providerStarted: true,
      },
      expectedError: "agent run timed out",
    },
  ] as const)(
    "sessions_send preserves a $name through Tool Search without starting A2A",
    async ({ waitResult, expectedError }) => {
      const calls: Array<{ method?: string; params?: unknown }> = [];
      const requesterKey = "agent:main:main";
      const targetKey = "agent:director1:main";
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string; params?: unknown };
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-terminal", status: "accepted", acceptedAt: 2000 };
        }
        if (request.method === "agent.wait") {
          return { runId: "run-terminal", ...waitResult };
        }
        return {};
      });

      const tool = getSessionTool("sessions_send", {
        agentSessionKey: requesterKey,
        agentChannel: "discord",
      });
      const catalogRef = createToolSearchCatalogRef();
      registerHeadlessToolSearchCatalog({ catalogRef, tools: [tool] });
      const runtime = new ToolSearchRuntime(
        { catalogRef },
        resolveToolSearchConfig({ tools: { toolSearch: { enabled: true, mode: "tools" } } }),
        { validateInput: true },
      );

      const details = await runtime.callValue("sessions_send", {
        sessionKey: targetKey,
        message: "ping",
        timeoutSeconds: 1,
      });
      expect(details).toEqual({
        runId: "run-terminal",
        status: "timeout",
        error: expectedError,
        sentBeforeError: true,
        sessionKey: targetKey,
      });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
      expect(calls.filter((call) => call.method === "agent.wait")).toHaveLength(1);
    },
  );
}
