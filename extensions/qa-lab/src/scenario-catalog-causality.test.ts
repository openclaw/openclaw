import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { assertNoGatewayLogSentinels } from "./gateway-log-sentinel.js";
import {
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  readQaScenarioPackYamlSource,
} from "./scenario-catalog.js";
import { readFlowAssertExpression, requireFlowScenario } from "./scenario-catalog.test-utils.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { createRestartFlowFixture } from "./scenario-restart-flow.test-support.js";

describe("qa scenario catalog causality", () => {
  it("exposes the message tool directly for delivery decision inspection", () => {
    const scenario = readQaScenarioById("message-delivery-decision-inspection");

    expect(scenario.gatewayConfigPatch).toMatchObject({
      tools: {
        toolSearch: false,
        alsoAllow: ["message"],
      },
    });
  });

  it("requires one host-owned fallback for message suppression and no duplicate after restart", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("message-delivery-decision-inspection"),
    );
    const suppressionActions = scenario.execution.flow?.steps[1]?.actions ?? [];
    const restartActions = scenario.execution.flow?.steps[2]?.actions ?? [];
    const outboundCount =
      "state.getSnapshot().messages.filter((message) => message.direction === 'outbound').length";

    expect(scenario.execution.config?.expectedFallbackText).toBe(
      "The tool run finished, but no final summary was produced. I did not repeat any completed actions.",
    );
    expect(suppressionActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          waitForOutbound: {
            conversation: { id: "qa-message-suppression-room", kind: "direct" },
            textIncludes: { ref: "config.expectedFallbackText" },
            timeoutMs: 60000,
          },
          saveAs: "suppressionOutbound",
        }),
      ]),
    );
    expect(suppressionActions.map(readFlowAssertExpression)).toContain(
      `${outboundCount} === suppressionOutboundStart + 1 && suppressionOutbound.text === config.expectedFallbackText`,
    );
    expect(restartActions.map(readFlowAssertExpression)).toContain(
      `${outboundCount} === suppressionOutboundStart + 1`,
    );
    expect([...suppressionActions, ...restartActions].map(readFlowAssertExpression)).not.toContain(
      `${outboundCount} === suppressionOutboundStart`,
    );
    expect(JSON.stringify(scenario.execution.flow)).not.toContain("waitForNoOutbound");
    expect(JSON.stringify(scenario.execution.flow)).not.toContain("visibleOutbound=0");
  });

  it("treats denied Telegram admission as silent transport suppression", () => {
    for (const scenarioId of [
      "telegram-policy-hot-reload",
      "telegram-group-policy-hot-reload",
      "telegram-repeated-command-authorization",
    ]) {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      const flow = JSON.stringify(scenario.execution.flow);
      expect(flow).toContain("waitForNoOutbound");
      expect(flow).not.toContain("not authorized");
    }
  });

  it("never slices bounded gateway log snapshots with absolute cursors", () => {
    expect(readQaScenarioPackYamlSource()).not.toMatch(
      /readGatewayLogs\s*\(\s*\)[^\r\n]*\.slice\s*\(/u,
    );
  });

  it("loads live gateway sentinel scenarios for harness self-health", () => {
    const scenarioIds = [
      "plugin-hook-health-sentinel",
      "plugin-manifest-contract-health",
      "webchat-direct-reply-routing",
      "long-context-progress-watchdog",
      "gateway-restart-inflight-run",
      "gateway-restart-multi-live",
      "streaming-final-integrity",
    ];

    for (const scenarioId of scenarioIds) {
      const scenario = readQaScenarioById(scenarioId);
      expect(scenario.execution.flow?.steps.length).toBeGreaterThan(0);
      expect(scenario.coverage?.primary.length).toBeGreaterThan(0);
    }
    expect(readQaScenarioById("webchat-direct-reply-routing").sourcePath).toBe(
      "qa/scenarios/channels/webchat-direct-reply-routing.yaml",
    );
    expect(readQaScenarioById("long-context-progress-watchdog").sourcePath).toBe(
      "qa/scenarios/runtime/long-context-progress-watchdog.yaml",
    );
    const liveMultiRestart = requireFlowScenario(readQaScenarioById("gateway-restart-multi-live"));
    const liveMultiRestartFlow = liveMultiRestart.execution.flow;
    const liveMultiRestartContract = JSON.stringify(liveMultiRestartFlow);
    const liveMultiRestartPrompt =
      typeof liveMultiRestart.execution.config?.prompt === "string"
        ? liveMultiRestart.execution.config.prompt
        : "";
    const liveMultiRestartActions = liveMultiRestartFlow?.steps[1]?.actions ?? [];
    const checkpointLoop = liveMultiRestartActions.find(
      (action): action is { forEach?: { actions?: unknown[] } } =>
        typeof action === "object" && action !== null && "forEach" in action,
    );
    const checkpointActions = checkpointLoop?.forEach?.actions ?? [];
    const checkpointTranscriptIndex = checkpointActions.findIndex(
      (action) =>
        (action as { call?: string }).call === "waitForCondition" &&
        (action as { saveAs?: string }).saveAs === "checkpointTranscript",
    );
    const checkpointStoreIndex = checkpointActions.findIndex(
      (action) =>
        (action as { call?: string }).call === "readRawQaSessionStore" &&
        (action as { saveAs?: string }).saveAs === "checkpointStore",
    );
    const checkpointPersistenceAssertIndex = checkpointActions.findIndex((action) => {
      const expression = readFlowAssertExpression(action);
      return (
        expression.includes("checkpointEntry") &&
        expression.includes("checkpointTranscript.userMessageCount >= 1") &&
        expression.includes("checkpointTranscript.eventCursor > 0") &&
        expression.includes("checkpointTranscript.probeTextEndLine ?? 0") &&
        expression.includes("restartRecoveryDeliveryContext?.channel === 'qa-channel'") &&
        expression.includes("restartRecoveryDeliveryContext.to === `dm:${conversationId}`")
      );
    });
    const checkpointRestartIndex = checkpointActions.findIndex(
      (action) => (action as { call?: string }).call === "restartGatewayWithConfigPatch",
    );
    const finalOutboundIndex = liveMultiRestartActions.findIndex(
      (action) =>
        (action as { call?: string }).call === "waitForOutboundMessage" &&
        (action as { saveAs?: string }).saveAs === "outbound",
    );
    const outboundCountIndex = liveMultiRestartActions.findIndex(
      (action) => (action as { set?: string }).set === "outboundCountAfterDelivery",
    );
    const quietWindowIndex = liveMultiRestartActions.findIndex(
      (action) => typeof action === "object" && action !== null && "waitForNoOutbound" in action,
    );
    const finalCardinalityAssertIndex = liveMultiRestartActions.findIndex((action) =>
      readFlowAssertExpression(action).includes("finalMatches.length === 1"),
    );
    expect(liveMultiRestart.execution.retryCount).toBe(0);
    expect(liveMultiRestart.execution.runtime).toBe("openclaw");
    expect(liveMultiRestart.runtimePairLane).toBeUndefined();
    expect(JSON.stringify(liveMultiRestart.gatewayConfigPatch)).toContain(
      '"alsoAllow":["qa_restart_wait","qa_restart_unsafe_probe"]',
    );
    expect(liveMultiRestartContract).toContain("pendingCodeModeExecNeedle");
    expect(liveMultiRestartContract).toContain("summary.hasPendingCodeModeWait");
    expect(liveMultiRestartContract).toContain("checkpoint");
    expect(liveMultiRestartContract).toContain("restarts=3");
    for (const fixturePath of [
      "restart-audit/components.md",
      "restart-audit/risks.md",
      "restart-audit/deployments.md",
      "restart-audit/controls.md",
      "restart-audit/recommendation.md",
    ]) {
      expect(liveMultiRestartPrompt).toContain(fixturePath);
    }
    expect(liveMultiRestartPrompt).toContain(
      "On this original user turn, perform only checkpoint 1",
    );
    expect(liveMultiRestartPrompt).toContain(
      "After the third Gateway-recovery system message, perform the audit and final report",
    );
    expect(liveMultiRestartPrompt).toContain(
      "make exactly one `exec` call with `restartSafe: true`",
    );
    expect(liveMultiRestartPrompt).toContain(
      "expired, or aborted `wait` result after restart is expected",
    );
    expect(liveMultiRestartPrompt).toContain(
      "Do not issue another `exec` until a new Gateway-recovery system message arrives",
    );
    expect(liveMultiRestartPrompt).toContain(
      '.some(candidate => candidate.toolName === "qa_restart_unsafe_probe")',
    );
    expect(liveMultiRestartPrompt).toContain("Do not read the `restart-audit/` directory path");
    expect(liveMultiRestartContract).toContain("sendInbound");
    expect(liveMultiRestartContract).not.toContain("startAgentRun");
    expect(liveMultiRestartContract).toContain("id: `dm:${conversationId}`");
    expect(liveMultiRestartContract).toContain("dmScope: env.cfg.session?.dmScope");
    expect(liveMultiRestartContract).toContain('"saveAs":"inbound"');
    expect(liveMultiRestartContract).toContain("probeText: config.finalMarker");
    expect(liveMultiRestartContract).toContain(
      "pendingCodeModeExecNeedle: `CHECKPOINT-${checkpoint}`",
    );
    expect(liveMultiRestartContract).not.toContain(
      "assistantToolCallCounts.wait ?? 0) > (summary.completedToolCallCounts.wait ?? 0)",
    );
    expect(checkpointTranscriptIndex).toBeGreaterThanOrEqual(0);
    expect(checkpointStoreIndex).toBeGreaterThan(checkpointTranscriptIndex);
    expect(checkpointPersistenceAssertIndex).toBeGreaterThan(checkpointStoreIndex);
    expect(checkpointRestartIndex).toBeGreaterThan(checkpointPersistenceAssertIndex);
    expect(finalOutboundIndex).toBeGreaterThanOrEqual(0);
    expect(outboundCountIndex).toBeGreaterThan(finalOutboundIndex);
    expect(quietWindowIndex).toBeGreaterThan(outboundCountIndex);
    expect(liveMultiRestartActions[quietWindowIndex]).toMatchObject({
      waitForNoOutbound: {
        quietMs: 3000,
        sinceIndex: { ref: "outboundCountAfterDelivery" },
      },
    });
    expect(finalCardinalityAssertIndex).toBeGreaterThan(quietWindowIndex);
    expect(
      liveMultiRestartActions.some((action) => (action as { call?: string }).call === "sleep"),
    ).toBe(false);
    expect(liveMultiRestartContract).toContain("dispatching restart-safe recovery");
    expect(readQaScenarioExecutionConfig("gateway-restart-multi-live")).toMatchObject({
      requiredProviderMode: "live-frontier",
      requiredProvider: "openai",
      requiredModel: "gpt-5.4",
    });
  });

  it.each([false, true])(
    "admits a restart checkpoint only when its own wait is pending (%s)",
    async (hasPendingCodeModeWait) => {
      const scenario = requireFlowScenario(readQaScenarioById("gateway-restart-inflight-run"));
      const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
      const checkpointLoop = actions.find(
        (action): action is { forEach: { actions: unknown[] } } =>
          typeof action === "object" && action !== null && "forEach" in action,
      );
      const pendingWait = checkpointLoop?.forEach.actions.find(
        (action) =>
          (action as { call?: string }).call === "waitForCondition" &&
          (action as { saveAs?: string }).saveAs === "checkpointTranscript",
      );
      if (!pendingWait) {
        throw new Error("restart scenario checkpoint wait is missing");
      }
      const observations: unknown[] = [];
      const result = runLoadedScenarioFlow("gateway-restart-inflight-run", {
        flow: {
          steps: [
            {
              name: "gates the current checkpoint",
              actions: [
                { set: "checkpoint", value: { expr: "2" } },
                { set: "sessionKey", value: "agent:qa:checkpoint" },
                pendingWait,
              ],
            },
          ],
        },
        api: {
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
              hasPendingCodeModeWait,
            };
          },
        },
      });
      if (hasPendingCodeModeWait) {
        await expect(result).resolves.toMatchObject({ status: "pass" });
      } else {
        await expect(result).rejects.toThrow("test condition was not met");
      }
      expect(observations.length).toBeGreaterThan(0);
      for (const options of observations) {
        expect(options).toMatchObject({ pendingCodeModeExecNeedle: "CHECKPOINT-2" });
      }
    },
  );

  it("runs one persisted inbound through three distinct restart lifecycles and quiet delivery", async () => {
    const scenario = requireFlowScenario(readQaScenarioById("gateway-restart-inflight-run"));
    // These settings are applied by the suite launcher, outside the flow interpreter.
    // In particular, the unsafe probe must start available for its later absence to prove fencing.
    expect(scenario.execution).toMatchObject({ retryCount: 0, suiteIsolation: "isolated" });
    expect(scenario.gatewayConfigPatch).toMatchObject({
      logging: { audit: { executionIdentity: true } },
      plugins: {
        slots: { memory: "none" },
        entries: { acpx: { enabled: false }, "memory-core": { enabled: false } },
      },
      tools: { alsoAllow: ["qa_restart_wait", "qa_restart_unsafe_probe"] },
    });
    const fixture = createRestartFlowFixture();
    await expect(fixture.run()).resolves.toMatchObject({ status: "pass" });
    expect(fixture.events).toEqual([
      "inbound",
      "pending:CHECKPOINT-1",
      "persisted:1",
      "restart:1",
      "pending:CHECKPOINT-2",
      "persisted:2",
      "restart:2",
      "pending:CHECKPOINT-3",
      "persisted:3",
      "restart:3",
      "delivery",
      "quiet:3000:1",
    ]);
    expect(fixture.auditRunIds).toEqual(["delivery-1", "delivery-1"]);
    expect(fixture.restartOrigins).toEqual([
      ["http://127.0.0.1:64001"],
      ["http://127.0.0.1:64002"],
      ["http://127.0.0.1:64003"],
    ]);
  });

  it.each([
    ["missing delivery claim", "did not persist the one original prompt", 0],
    ["stale lifecycle", "did not rotate the accepted delivery run/lifecycle fence", 2],
    ["stale delivery owner", "did not rotate the accepted delivery run/lifecycle fence", 2],
    ["changed audit identity", "original admitted audit identity changed", 3],
    ["duplicate delivery", "expected exactly one automatically recovered marker", 3],
    ["extra inbound", "expected one real qa-channel inbound turn", 3],
    ["late delivery", "unexpected outbound during quiet window", 3],
  ] as const)("rejects %s in the loaded three-restart flow", async (fault, message, restarts) => {
    const fixture = createRestartFlowFixture(fault);
    await expect(fixture.run()).rejects.toThrow(message);
    expect(fixture.restartOrigins).toHaveLength(restarts);
  });

  it("keeps full-access restart delivery independent from subagent completion handoff", async () => {
    const scenario = requireFlowScenario(readQaScenarioById("gateway-restart-full-access-live"));
    const prompt =
      typeof scenario.execution.config?.prompt === "string" ? scenario.execution.config.prompt : "";
    const actions = scenario.execution.flow?.steps[1]?.actions ?? [];
    const outboundIndex = actions.findIndex(
      (action) =>
        (action as { call?: string; saveAs?: string }).call === "waitForOutboundMessage" &&
        (action as { saveAs?: string }).saveAs === "outbound",
    );
    const childIndex = actions.findIndex(
      (action) =>
        (action as { call?: string; saveAs?: string }).call === "waitForCondition" &&
        (action as { saveAs?: string }).saveAs === "childTask",
    );
    const childWait = actions[childIndex] as
      | { args?: Array<{ lambda?: { expr?: string } }> }
      | undefined;

    expect(prompt).toContain("expectsCompletionMessage false");
    expect(prompt).toContain("do not call sessions_yield or wait for the child");
    expect(childWait?.args?.[0]?.lambda?.expr).toContain("task.status === 'completed'");
    expect(childWait?.args?.[0]?.lambda?.expr).not.toContain("terminalOutcome");
    expect(childWait?.args?.[0]?.lambda?.expr).toContain(
      "task.deliveryStatus === 'not_applicable'",
    );
    expect(outboundIndex).toBeGreaterThanOrEqual(0);
    expect(childIndex).toBeGreaterThan(outboundIndex);

    const childAssertionPath = actions.slice(childIndex, childIndex + 3);
    await expect(
      runLoadedScenarioFlow("gateway-restart-full-access-live", {
        flow: {
          steps: [
            {
              name: "accepts a successful silent child task",
              actions: [
                { set: "sessionKey", value: "agent:qa:restart-proof" },
                ...childAssertionPath,
              ],
            },
          ],
        },
        api: {
          env: {
            gateway: {
              call: async () => ({
                tasks: [
                  {
                    title: "restart-proof-child",
                    sessionKey: "agent:qa:restart-proof",
                    childSessionKey: "agent:qa:restart-proof:child",
                    status: "completed",
                    deliveryStatus: "not_applicable",
                  },
                ],
              }),
            },
          },
          readSessionTranscriptSummary: async () => ({ finalText: "CHILD-RESTART-OK" }),
        },
      }),
    ).resolves.toMatchObject({ status: "pass" });
  });

  it.each(["gateway-restart-inflight-run", "gateway-restart-multi-live"] as const)(
    "ignores pre-scenario gateway sentinel logs during %s recovery",
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

      await expect(
        runLoadedScenarioFlow(scenarioId, {
          flow: {
            steps: [{ name: "ignores prior sentinels", actions: gatewayActions }],
          },
          api: {
            markGatewayLogCursor: () => priorLogs.length,
            assertNoGatewayLogSentinels: (
              options?: Parameters<typeof assertNoGatewayLogSentinels>[1],
            ) => assertNoGatewayLogSentinels(`${priorLogs}gateway recovered cleanly`, options),
          },
        }),
      ).resolves.toMatchObject({ status: "pass" });
    },
  );

  it("scopes prompt diagnostics to requests after each scenario cursor", () => {
    for (const scenarioId of [
      "instruction-followthrough-repo-contract",
      "subagent-handoff",
    ] as const) {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      const flow = JSON.stringify(scenario.execution.flow);
      const cursorIndex = flow.indexOf("/debug/request-cursor");
      const promptIndex = flow.indexOf('"call":"runAgentPrompt"');
      const requestsIndex = flow.indexOf("/debug/requests?after=${requestCursorBefore}");

      expect(cursorIndex, scenarioId).toBeGreaterThanOrEqual(0);
      expect(cursorIndex, scenarioId).toBeLessThan(promptIndex);
      expect(requestsIndex, scenarioId).toBeGreaterThan(promptIndex);
      expect(flow, scenarioId).not.toContain("`${env.mock.baseUrl}/debug/requests`");
    }
  });

  it.each([
    [
      "thread-memory-isolation",
      "poll",
      "finalRequest.toolOutputCallId === searchResultRequest.plannedToolCallId",
      null,
    ],
    [
      "memory-tools-channel-context",
      "poll",
      "finalRequest.toolOutputCallId === searchResultRequest.plannedToolCallId",
      "durableChannelLifecycle",
    ],
    [
      "agent-tool-consumption",
      "immediate",
      "getResultRequest.toolOutputCallId === searchResultRequest.plannedToolCallId",
      null,
    ],
  ] as const)(
    "asserts the complete memory tool chain before %s delivery",
    (scenarioId, requestCollectionMode, finalLinkNeedle, durableWaitSaveAs) => {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
      const outboundIndex = actions.findIndex((action) =>
        durableWaitSaveAs
          ? (action as { call?: string }).call === "waitForCondition" &&
            (action as { saveAs?: string }).saveAs === durableWaitSaveAs
          : (action as { call?: string }).call === "waitForOutboundMessage",
      );
      const requestCollectionIndex = actions.findIndex((action) =>
        requestCollectionMode === "poll"
          ? (action as { call?: string }).call === "waitForCondition" &&
            (action as { saveAs?: string }).saveAs === "scenarioRequests"
          : (action as { set?: string }).set === "scenarioRequests",
      );
      const requestCountAssertIndex = actions.findIndex((action) =>
        readFlowAssertExpression(action).includes("scenarioRequests.length === 3"),
      );
      const searchPlanAssertIndex = actions.findIndex((action) =>
        readFlowAssertExpression(action).includes(
          "searchPlanRequest.plannedToolName === 'memory_search'",
        ),
      );
      const searchResultAssertIndex = actions.findIndex((action) =>
        readFlowAssertExpression(action).includes(
          "searchResultRequest.toolOutputCallId === searchPlanRequest.plannedToolCallId",
        ),
      );
      const finalRequestAssertIndex = actions.findIndex((action) =>
        readFlowAssertExpression(action).includes(finalLinkNeedle),
      );

      expect(requestCollectionIndex, scenarioId).toBeGreaterThanOrEqual(0);
      expect(requestCountAssertIndex, scenarioId).toBeGreaterThan(requestCollectionIndex);
      expect(searchPlanAssertIndex, scenarioId).toBeGreaterThan(requestCountAssertIndex);
      expect(searchResultAssertIndex, scenarioId).toBeGreaterThan(searchPlanAssertIndex);
      expect(finalRequestAssertIndex, scenarioId).toBeGreaterThan(searchResultAssertIndex);
      expect(outboundIndex, scenarioId).toBeGreaterThan(finalRequestAssertIndex);

      if (durableWaitSaveAs) {
        const durableWait = actions[outboundIndex] as
          | { args?: Array<{ lambda?: { expr?: string } }> }
          | undefined;
        const durableExpr = durableWait?.args?.[0]?.lambda?.expr ?? "";
        expect(durableExpr, scenarioId).toContain("event.cursor < finalSent.cursor");
        expect(durableExpr, scenarioId).toContain("event.cursor < previewRetired.cursor");
      }

      if (requestCollectionMode === "poll") {
        const requestPoll = actions[requestCollectionIndex] as
          | { args?: Array<{ lambda?: { expr?: string } }> }
          | undefined;
        expect(requestPoll?.args?.[0]?.lambda?.expr, scenarioId).toContain(
          "requests.length >= 3 ? requests : undefined",
        );
      } else {
        expect(
          actions.some(
            (action) =>
              (action as { call?: string }).call === "waitForCondition" &&
              (action as { saveAs?: string }).saveAs === "scenarioRequests",
          ),
          scenarioId,
        ).toBe(false);
      }
    },
  );

  it.each([
    ["memory-tools-channel-context", "durableChannelLifecycle", 30000],
    ["agent-progress-evidence", "durableCompletionLifecycle", 60000],
  ] as const)("keeps the policy-aware durable delivery budget for %s", (scenarioId, saveAs, ms) => {
    const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
    const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
    const durableWait = actions.find(
      (action) =>
        (action as { call?: string }).call === "waitForCondition" &&
        (action as { saveAs?: string }).saveAs === saveAs,
    );

    expect(durableWait, scenarioId).toMatchObject({
      args: [expect.any(Object), { expr: `liveTurnTimeoutMs(env, ${ms})` }],
    });
  });

  it.each([
    {
      scenarioId: "memory-tools-channel-context",
      saveAs: "durableChannelLifecycle",
      cursorName: "busCursorBeforeInbound",
      conversationKey: "channelId",
      markerKey: "expectedNeedle",
      targetPrefix: "channel",
    },
    {
      scenarioId: "agent-progress-evidence",
      saveAs: "durableCompletionLifecycle",
      cursorName: "busCursorBefore",
      conversationKey: "conversationId",
      markerKey: "completionText",
      targetPrefix: "dm",
    },
  ] as const)("isolates $scenarioId durable lifecycle evidence by account", async (fixture) => {
    const scenario = requireFlowScenario(readQaScenarioById(fixture.scenarioId));
    const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
    const durableWaitIndex = actions.findIndex(
      (action) =>
        (action as { call?: string }).call === "waitForCondition" &&
        (action as { saveAs?: string }).saveAs === fixture.saveAs,
    );
    const cardinalityAssertIndex = actions.findIndex((action) =>
      readFlowAssertExpression(action).includes(
        fixture.scenarioId === "memory-tools-channel-context"
          ? "visibleChannelOutbounds.length === 1"
          : "completionMessages.length === 1",
      ),
    );
    expect(durableWaitIndex, fixture.scenarioId).toBeGreaterThanOrEqual(0);
    expect(cardinalityAssertIndex, fixture.scenarioId).toBeGreaterThan(durableWaitIndex);
    if (durableWaitIndex < 0 || cardinalityAssertIndex <= durableWaitIndex) {
      throw new Error(`missing durable lifecycle assertion path for ${fixture.scenarioId}`);
    }
    const postWaitAssertionPath = actions.slice(durableWaitIndex, cardinalityAssertIndex + 1);

    const config = scenario.execution.config ?? {};
    const conversationId = String(config[fixture.conversationKey]);
    const marker = String(config[fixture.markerKey]);
    const target = `${fixture.targetPrefix}:${conversationId}`;
    const state = createQaBusState();
    for (const accountId of ["foreign", "qa-channel"]) {
      const preview = state.addOutboundMessage({ accountId, to: target, text: marker });
      state.deleteMessage({ accountId, messageId: preview.id });
      state.addOutboundMessage({ accountId, to: target, text: marker });
    }
    const foreignKind = fixture.targetPrefix === "dm" ? "channel" : "dm";
    const foreignKindTarget = `${foreignKind}:${conversationId}`;
    const foreignKindPreview = state.addOutboundMessage({
      accountId: "qa-channel",
      to: foreignKindTarget,
      text: marker,
    });
    state.deleteMessage({ accountId: "qa-channel", messageId: foreignKindPreview.id });
    state.addOutboundMessage({
      accountId: "qa-channel",
      to: foreignKindTarget,
      text: marker,
    });

    await expect(
      runLoadedScenarioFlow(fixture.scenarioId, {
        state,
        flow: {
          steps: [
            {
              name: "keeps foreign account lifecycle evidence isolated",
              actions: [
                { set: "outboundStartIndex", value: { expr: "0" } },
                { set: fixture.cursorName, value: { expr: "0" } },
                ...postWaitAssertionPath,
                {
                  assert: {
                    expr: `${fixture.saveAs}.message.accountId === transport.accountId`,
                  },
                },
              ],
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ status: "pass" });
  });

  it("isolates Active Memory request traces from interleaved heartbeats", async () => {
    const scenario = requireFlowScenario(readQaScenarioById("active-memory-preprompt-recall"));
    const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
    const baselineTrace = actions.find(
      (action) => (action as { set?: string }).set === "baselineMockRequests",
    );
    const activeTrace = actions.find(
      (action) => (action as { set?: string }).set === "activeRequests",
    );
    expect(baselineTrace).toBeDefined();
    expect(activeTrace).toBeDefined();
    if (!baselineTrace || !activeTrace) {
      throw new Error("active-memory-preprompt-recall request trace actions are missing");
    }

    const marker = String(scenario.execution.config?.turnMarker);
    const heartbeat = { allInputText: "[OpenClaw heartbeat poll]" };
    const scenarioRequest = (suffix: string) => ({ allInputText: `${marker} ${suffix}` });
    const traces = new Map<string, unknown[]>([
      ["10", [heartbeat, scenarioRequest("baseline main")]],
      [
        "20",
        [
          heartbeat,
          scenarioRequest("You are a memory search agent. search plan"),
          scenarioRequest("You are a memory search agent. search result"),
          scenarioRequest("You are a memory search agent. memory get result"),
          scenarioRequest("active main"),
        ],
      ],
    ]);

    await expect(
      runLoadedScenarioFlow("active-memory-preprompt-recall", {
        flow: {
          steps: [
            {
              name: "filters provider-global traces before exact counts",
              actions: [
                { set: "requestCursorBeforeBaseline", value: { expr: "10" } },
                baselineTrace,
                { assert: "baselineMockRequests.length === 1" },
                { set: "requestCursorBeforeActive", value: { expr: "20" } },
                activeTrace,
                { assert: "activeRequests.length === 4" },
              ],
            },
          ],
        },
        api: {
          env: { mock: { baseUrl: "http://mock.invalid" } },
          fetchJson: async (url: string) =>
            traces.get(new URL(url).searchParams.get("after") ?? "") ?? [],
        },
      }),
    ).resolves.toMatchObject({ status: "pass" });
  });
});
