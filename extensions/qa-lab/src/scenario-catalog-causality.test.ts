import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { assertNoGatewayLogSentinels } from "./gateway-log-sentinel.js";
import { readQaScenarioById, readQaScenarioPackYamlSource } from "./scenario-catalog.js";
import { readFlowAssertExpression, requireFlowScenario } from "./scenario-catalog.test-utils.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { createRestartFlowFixture } from "./scenario-restart-flow.test-support.js";

function matchesAction(action: unknown, fields: { call?: string; saveAs?: string; set?: string }) {
  return (
    typeof action === "object" &&
    action !== null &&
    Object.entries(fields).every(([key, value]) => Reflect.get(action, key) === value)
  );
}

function callIndex(actions: unknown[], call: string, saveAs?: string) {
  return actions.findIndex((action) =>
    matchesAction(action, { call, ...(saveAs ? { saveAs } : {}) }),
  );
}

function assertionIndex(actions: unknown[], ...needles: string[]) {
  return actions.findIndex((action) =>
    needles.every((needle) => readFlowAssertExpression(action).includes(needle)),
  );
}

function lambdaExpression(action: unknown) {
  const call = action as { args?: { lambda?: { expr?: string } }[] } | undefined;
  return call?.args?.[0]?.lambda?.expr ?? "";
}

function flowFixture(id: string, step = 0) {
  const scenario = requireFlowScenario(readQaScenarioById(id));
  return {
    scenario,
    actions: scenario.execution.flow?.steps[step]?.actions ?? [],
    contract: JSON.stringify(scenario.execution.flow),
    prompt:
      typeof scenario.execution.config?.prompt === "string" ? scenario.execution.config.prompt : "",
  };
}

function checkpointActions(actions: unknown[]) {
  const loop = actions.find(
    (action): action is { forEach?: { actions?: unknown[] } } =>
      typeof action === "object" && action !== null && "forEach" in action,
  );
  return loop?.forEach?.actions ?? [];
}

function requireAction(actions: unknown[], fields: Parameters<typeof matchesAction>[1]) {
  const action = actions.find((candidate) => matchesAction(candidate, fields));
  if (!action) {
    throw new Error(`scenario action is missing: ${JSON.stringify(fields)}`);
  }
  return action;
}

function expectInOrder(first: number, ...indices: number[]) {
  expect(first).toBeGreaterThanOrEqual(0);
  let previous = first;
  for (const index of indices) {
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

function expectContains(text: string, ...needles: string[]) {
  for (const needle of needles) {
    expect(text).toContain(needle);
  }
}

function runActions(
  scenarioId: string,
  actions: unknown[],
  api: NonNullable<Parameters<typeof runLoadedScenarioFlow>[1]>["api"] = {},
  state?: NonNullable<Parameters<typeof runLoadedScenarioFlow>[1]>["state"],
) {
  return runLoadedScenarioFlow(scenarioId, {
    api,
    state,
    flow: { steps: [{ name: "checks loaded scenario actions", actions }] },
  });
}

async function expectActionsPass(...args: Parameters<typeof runActions>) {
  await expect(runActions(...args)).resolves.toMatchObject({ status: "pass" });
}

const setExpression = (set: string, expr: string) => ({ set, value: { expr } });

describe("qa scenario catalog causality", () => {
  it("treats denied Telegram admission as silent transport suppression", () => {
    for (const scenarioId of [
      "telegram-policy-hot-reload",
      "telegram-group-policy-hot-reload",
      "telegram-repeated-command-authorization",
    ]) {
      const { contract } = flowFixture(scenarioId);
      expect(contract).toContain("waitForNoOutbound");
      expect(contract).not.toContain("not authorized");
    }
  });

  it("never slices bounded gateway log snapshots with absolute cursors", () => {
    expect(readQaScenarioPackYamlSource()).not.toMatch(
      /readGatewayLogs\s*\(\s*\)[^\r\n]*\.slice\s*\(/u,
    );
  });

  it("rejects an unrelated pending wait at the current restart checkpoint", async () => {
    const { actions } = flowFixture("gateway-restart-inflight-run");
    const pendingWait = requireAction(checkpointActions(actions), {
      call: "waitForCondition",
      saveAs: "checkpointTranscript",
    });
    const observations: unknown[] = [];
    const result = runActions(
      "gateway-restart-inflight-run",
      [
        setExpression("checkpoint", "2"),
        { set: "sessionKey", value: "agent:qa:checkpoint" },
        pendingWait,
      ],
      {
        readSessionTranscriptSummary: async (
          _env: unknown,
          _sessionKey: string,
          options: unknown,
        ) => {
          observations.push(options);
          // Aggregate counts can include an unrelated pending wait after checkpoint 1.
          return {
            assistantToolCallCounts: { exec: 2, wait: 2 },
            completedToolCallCounts: { wait: 1 },
            hasPendingCodeModeWait: false,
          };
        },
      },
    );
    await expect(result).rejects.toThrow("test condition was not met");
    expect(observations.length).toBeGreaterThan(0);
    for (const options of observations) {
      expect(options).toMatchObject({ pendingCodeModeExecNeedle: "CHECKPOINT-2" });
    }
  });

  it("runs channel work through three graceful replacements and ordinary resume inputs", async () => {
    const fixture = createRestartFlowFixture();
    await expect(fixture.run()).resolves.toMatchObject({ status: "pass" });
    expect(fixture.events).toEqual([
      "inbound",
      ...[1, 2, 3].flatMap((n) => [`pending:CHECKPOINT-${n}`, `restart:${n}`, `resume:${n}`]),
      "delivery",
      "quiet:3000:1",
    ]);
    expect(fixture.restartOrigins).toEqual(
      [64001, 64002, 64003].map((port) => [`http://127.0.0.1:${port}`]),
    );
  });

  it.each([
    ["duplicate resume", "test condition was not met"],
    ["duplicate delivery", "expected exactly one resumed final delivery"],
  ] as const)("rejects %s in the loaded graceful-restart flow", async (fault, message) => {
    const fixture = createRestartFlowFixture(fault);
    await expect(fixture.run()).rejects.toThrow(message);
  });

  it("keeps full-access restart delivery independent from subagent completion handoff", async () => {
    const { prompt, actions } = flowFixture("gateway-restart-full-access-live", 1);
    const childIndex = callIndex(actions, "waitForCondition", "childRun");
    const childExpr = lambdaExpression(actions[childIndex]);

    expectContains(
      prompt,
      "expectsCompletionMessage false",
      "do not call sessions_yield or wait for the child",
    );
    expectContains(
      childExpr,
      "run.execution.status === 'terminal'",
      "run.execution.outcome?.status === 'ok'",
      "run.delivery?.status === 'not_required'",
    );
    expectInOrder(callIndex(actions, "waitForOutboundMessage", "outbound"), childIndex);

    await expectActionsPass(
      "gateway-restart-full-access-live",
      [
        { set: "sessionKey", value: "agent:qa:restart-proof" },
        ...actions.slice(childIndex, childIndex + 3),
      ],
      {
        readNativeQaSubagentRuns: async () => [
          {
            label: "restart-proof-child",
            childSessionKey: "agent:qa:restart-proof:child",
            execution: { status: "terminal", outcome: { status: "ok" } },
            delivery: { status: "not_required" },
          },
        ],
        readSessionTranscriptSummary: async () => ({ finalText: "CHILD-RESTART-OK" }),
      },
    );
  });

  it.each(["gateway-restart-inflight-run", "gateway-restart-multi-live"] as const)(
    "ignores pre-scenario gateway sentinel logs during %s resume",
    async (scenarioId) => {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      const actions = scenario.execution.flow?.steps.flatMap((step) => step.actions) ?? [];
      const gatewayActions = actions.filter(
        (action) =>
          (action as { set?: string }).set === "gatewayLogCursor" ||
          (action as { call?: string }).call === "assertNoGatewayLogSentinels",
      );
      expect(gatewayActions).toHaveLength(2);
      const priorLogs = "codex_app_server progress stalled before this scenario\n";

      await expectActionsPass(scenarioId, gatewayActions, {
        markGatewayLogCursor: () => priorLogs.length,
        assertNoGatewayLogSentinels: (
          options?: Parameters<typeof assertNoGatewayLogSentinels>[1],
        ) => assertNoGatewayLogSentinels(`${priorLogs}gateway recovered cleanly`, options),
      });
    },
  );

  it("scopes instruction-followthrough diagnostics to requests after the scenario cursor", () => {
    const { contract: flow } = flowFixture("instruction-followthrough-repo-contract");
    const cursorIndex = flow.indexOf("/debug/request-cursor");
    const promptIndex = flow.indexOf('"call":"runAgentPrompt"');
    const requestsIndex = flow.indexOf("/debug/requests?after=${requestCursorBefore}");

    expectInOrder(cursorIndex, promptIndex, requestsIndex);
    expect(flow).not.toContain("`${env.mock.baseUrl}/debug/requests`");
  });

  it.each([
    ["thread-memory-isolation", false, false],
    ["memory-tools-channel-context", false, true],
    ["agent-tool-consumption", true, false],
  ] as const)(
    "asserts the complete memory tool chain before %s delivery",
    (scenarioId, immediate, durable) => {
      const { actions } = flowFixture(scenarioId);
      const outboundIndex = durable
        ? callIndex(actions, "waitForCondition", "durableChannelLifecycle")
        : callIndex(actions, "waitForOutboundMessage");
      const requestCollectionIndex = !immediate
        ? callIndex(actions, "waitForCondition", "scenarioRequests")
        : actions.findIndex((action) => matchesAction(action, { set: "scenarioRequests" }));
      expectInOrder(
        requestCollectionIndex,
        ...[
          "scenarioRequests.length === 3",
          "searchPlanRequest.plannedToolName === 'memory_search'",
          "searchResultRequest.toolOutputCallId === searchPlanRequest.plannedToolCallId",
          `${immediate ? "getResultRequest" : "finalRequest"}.toolOutputCallId === searchResultRequest.plannedToolCallId`,
        ].map((needle) => assertionIndex(actions, needle)),
        outboundIndex,
      );

      if (durable) {
        const durableExpr = lambdaExpression(actions[outboundIndex]);
        expectContains(
          durableExpr,
          "event.cursor < finalSent.cursor",
          "event.cursor < previewRetired.cursor",
        );
      }

      if (!immediate) {
        expect(lambdaExpression(actions[requestCollectionIndex]), scenarioId).toContain(
          "requests.length >= 3 ? requests : undefined",
        );
      } else {
        expect(callIndex(actions, "waitForCondition", "scenarioRequests"), scenarioId).toBe(-1);
      }
    },
  );

  it.each(["memory-tools-channel-context", "agent-progress-evidence"])(
    "isolates %s durable lifecycle evidence by account",
    async (scenarioId) => {
      const channel = scenarioId === "memory-tools-channel-context";
      const saveAs = channel ? "durableChannelLifecycle" : "durableCompletionLifecycle";
      const cursorName = channel ? "busCursorBeforeInbound" : "busCursorBefore";
      const messages = channel ? "visibleChannelOutbounds" : "completionMessages";
      const targetPrefix = channel ? "channel" : "dm";
      const { scenario, actions } = flowFixture(scenarioId);
      const durableWaitIndex = callIndex(actions, "waitForCondition", saveAs);
      expect(actions[durableWaitIndex]).toMatchObject({
        args: [expect.any(Object), { expr: `liveTurnTimeoutMs(env, ${channel ? 30000 : 60000})` }],
      });
      const cardinalityAssertIndex = assertionIndex(actions, `${messages}.length === 1`);
      expectInOrder(durableWaitIndex, cardinalityAssertIndex);
      const config = scenario.execution.config ?? {};
      const conversationId = String(config[channel ? "channelId" : "conversationId"]);
      const marker = String(config[channel ? "expectedNeedle" : "completionText"]);
      const target = `${targetPrefix}:${conversationId}`;
      const state = createQaBusState();
      const foreignKind = targetPrefix === "dm" ? "channel" : "dm";
      for (const [accountId, to] of [
        ["foreign", target],
        ["qa-channel", target],
        ["qa-channel", `${foreignKind}:${conversationId}`],
      ] as const) {
        const preview = state.addOutboundMessage({ accountId, to, text: marker });
        state.deleteMessage({ accountId, messageId: preview.id });
        state.addOutboundMessage({ accountId, to, text: marker });
      }

      await expectActionsPass(
        scenarioId,
        [
          setExpression("outboundStartIndex", "0"),
          setExpression(cursorName, "0"),
          ...actions.slice(durableWaitIndex, cardinalityAssertIndex + 1),
          { assert: { expr: `${saveAs}.message.accountId === transport.accountId` } },
        ],
        {},
        state,
      );
    },
  );

  it("isolates Active Memory request traces from interleaved heartbeats", async () => {
    const { scenario, actions } = flowFixture("active-memory-preprompt-recall");
    const baselineTrace = requireAction(actions, { set: "baselineMockRequests" });
    const activeTrace = requireAction(actions, { set: "activeRequests" });

    const marker = String(scenario.execution.config?.turnMarker);
    const heartbeat = { allInputText: "[OpenClaw heartbeat poll]" };
    const scenarioRequest = (suffix: string) => ({ allInputText: `${marker} ${suffix}` });
    const traces = new Map<string, unknown[]>([
      ["10", [heartbeat, scenarioRequest("baseline main")]],
      [
        "20",
        [
          heartbeat,
          ...["search plan", "search result", "memory get result"].map((suffix) =>
            scenarioRequest(`You are a memory search agent. ${suffix}`),
          ),
          scenarioRequest("active main"),
        ],
      ],
    ]);

    await expectActionsPass(
      "active-memory-preprompt-recall",
      [
        setExpression("requestCursorBeforeBaseline", "10"),
        baselineTrace,
        { assert: "baselineMockRequests.length === 1" },
        setExpression("requestCursorBeforeActive", "20"),
        activeTrace,
        { assert: "activeRequests.length === 4" },
      ],
      {
        env: { mock: { baseUrl: "http://mock.invalid" } },
        fetchJson: async (url: string) =>
          traces.get(new URL(url).searchParams.get("after") ?? "") ?? [],
      },
    );
  });
});
