import { createHash } from "node:crypto";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { QaSuiteScenarioSkipError } from "./errors.js";
import {
  readQaScenarioById,
  readQaScenarioPack,
  type QaScenarioExecution,
  type QaScenarioFlow,
  type QaSeedScenarioWithSource,
} from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import {
  runLoadedScenarioFlow,
  assertTelegramRichObservationFlow,
  telegramRichObservationCases,
} from "./scenario-flow-runner.test-support.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

type FlowApi = Parameters<typeof runScenarioFlow>[0]["api"];

function createImportApi(
  id: string,
  runScenario: FlowApi["runScenario"] = async (name, steps) => {
    const stepResults = [];
    for (const step of steps) {
      const details = (await step.run())?.details;
      stepResults.push({
        name: step.name,
        status: "pass" as const,
        ...(details !== undefined ? { details } : {}),
      });
    }
    return { name, status: "pass", steps: stepResults };
  },
): FlowApi {
  return {
    state: createQaBusState(),
    scenario: makeQaSuiteTestScenario(id),
    config: {},
    runScenario,
  };
}

function readWebchatTranscriptWaitFlow() {
  const scenario = readQaScenarioById("webchat-direct-reply-routing");
  const actions = scenario.execution.flow?.steps[0]?.actions;
  if (!actions) {
    throw new Error("webchat direct reply scenario has no actions");
  }
  const waitIndex = actions.findIndex(
    (action) =>
      typeof action === "object" &&
      action !== null &&
      "saveAs" in action &&
      action.saveAs === "transcriptSummary",
  );
  if (waitIndex < 0) {
    throw new Error("webchat direct reply scenario has no transcript wait");
  }
  return {
    steps: [
      {
        name: "waits for the durable assistant transcript",
        actions: [
          { set: "sessionKey", value: "agent:qa:test-session" },
          ...actions.slice(waitIndex, waitIndex + 3),
        ],
      },
    ],
  } satisfies QaScenarioFlow;
}

async function runWebchatTranscriptWait(
  readSessionTranscriptSummary: () => Promise<{
    finalText: string;
    hasDirectReplySelfMessage: boolean;
  }>,
) {
  return await runLoadedScenarioFlow("webchat-direct-reply-routing", {
    flow: readWebchatTranscriptWaitFlow(),
    api: {
      readSessionTranscriptSummary,
      waitForCondition: async <T>(check: () => Promise<T | undefined>) => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const value = await check();
          if (value !== undefined) {
            return value;
          }
        }
        throw new Error("test condition was not met");
      },
      normalizeLowercaseStringOrEmpty,
      formatErrorMessage: coerceErrorMessage,
      liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
    },
  });
}

const planningEvidenceCoverageIds = new Set([
  "agent-runtime.external-harness-selection-planning",
  "openai.codex-harness-no-meta-leak",
  "openai.codex-harness-planning",
]);

type PlanningEvidenceScenario = QaSeedScenarioWithSource & {
  execution: Extract<QaScenarioExecution, { kind: "flow" }> & { flow?: QaScenarioFlow };
};

function isPlanningEvidenceScenario(
  scenario: QaSeedScenarioWithSource,
): scenario is PlanningEvidenceScenario {
  return (
    scenario.execution.kind === "flow" &&
    [...(scenario.coverage?.primary ?? []), ...(scenario.coverage?.secondary ?? [])].some(
      (coverageId) => planningEvidenceCoverageIds.has(coverageId),
    )
  );
}

type PlanningEvidenceFixture = {
  currentSummary: Record<string, unknown>;
  failureMessage: string;
  outboundText: string;
  scenario: PlanningEvidenceScenario;
};

function readPlanningEvidenceFlow(scenario: PlanningEvidenceScenario): QaScenarioFlow {
  const step = scenario.execution.flow?.steps.find((candidate) =>
    candidate.actions.some(
      (action) =>
        typeof action === "object" &&
        action !== null &&
        "call" in action &&
        action.call === "runAgentPrompt",
    ),
  );
  if (!step) {
    throw new Error(`planning scenario has no agent turn: ${scenario.id}`);
  }
  const artifactIndex = step.actions.findIndex(
    (action) =>
      typeof action === "object" &&
      action !== null &&
      "set" in action &&
      action.set === "artifactPath",
  );
  const evidenceActions = artifactIndex >= 0 ? step.actions.slice(0, artifactIndex) : step.actions;
  return {
    steps: [
      {
        name: "proves current-attempt planning evidence",
        actions: [
          { set: "selected", value: { provider: "openai", model: "gpt-5.6-luna" } },
          ...evidenceActions,
        ],
      },
    ],
  };
}

function createPlanningEvidenceFixture(
  scenario: PlanningEvidenceScenario,
): PlanningEvidenceFixture {
  const config = scenario.execution.config ?? {};
  const artifactFile = typeof config.artifactFile === "string" ? config.artifactFile : undefined;
  const expectedReply = typeof config.expectedReply === "string" ? config.expectedReply : undefined;
  const internalMarker =
    typeof config.internalMarker === "string" ? config.internalMarker : undefined;

  if (scenario.execution.runtime === "codex" && expectedReply && internalMarker) {
    return {
      scenario,
      outboundText: expectedReply,
      failureMessage: "missing successful current-attempt progress_card update",
      currentSummary: {
        eventCursor: 9,
        assistantMirrors: [{ identity: "current-turn:assistant", text: expectedReply }],
        successfulToolCallCounts: { progress_card: 1 },
      },
    };
  }
  if (scenario.execution.runtime === "codex" && artifactFile) {
    const outboundText = `Built ${artifactFile}`;
    return {
      scenario,
      outboundText,
      failureMessage: "missing Codex harness progress_card signal",
      currentSummary: {
        eventCursor: 9,
        assistantMirrors: [{ identity: "current-turn:assistant", text: outboundText }],
        successfulToolCallCounts: { progress_card: 1 },
      },
    };
  }
  if (scenario.execution.runtime === "openclaw" && artifactFile) {
    return {
      scenario,
      outboundText: `Built ${artifactFile}`,
      failureMessage: "missing OpenClaw progress_card signal",
      currentSummary: {
        eventCursor: 9,
        successfulToolCallCounts: { progress_card: 1 },
      },
    };
  }
  throw new Error(`unsupported planning evidence metadata: ${scenario.id}`);
}

function runPlanningEvidenceFixture(
  fixture: PlanningEvidenceFixture,
  currentSummary = fixture.currentSummary,
) {
  const state = createQaBusState();
  const readOptions: unknown[] = [];
  const summaries = [
    {
      eventCursor: 7,
      assistantMirrors: [{ identity: "old-turn:assistant", text: fixture.outboundText }],
      successfulToolCallCounts: { progress_card: 1 },
    },
    currentSummary,
  ];
  let readIndex = 0;
  const cardStep = fixture.scenario.execution.config?.internalMarker;
  const result = runLoadedScenarioFlow(fixture.scenario.id, {
    flow: readPlanningEvidenceFlow(fixture.scenario),
    state,
    onWaitForOutboundMessage: ({ state: currentState }) => {
      currentState.addOutboundMessage({
        accountId: "qa-channel",
        to: "dm:qa-operator",
        text: fixture.outboundText,
      });
    },
    api: {
      env: {
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
        gateway: {
          call: async (method: string) =>
            method === "progressCard.get"
              ? { card: { revision: 1, steps: [{ step: cardStep }] } }
              : { messages: [{ role: "assistant", content: fixture.outboundText }] },
        },
      },
      readSessionTranscriptSummary: async (...args: unknown[]) => {
        readOptions.push(args[2]);
        const summary = summaries[readIndex];
        readIndex += 1;
        if (!summary) {
          throw new Error("unexpected transcript summary read");
        }
        return summary;
      },
      resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      normalizeLowercaseStringOrEmpty,
      runAgentPrompt: async () => ({ started: { runId: "current-run" }, waited: { status: "ok" } }),
    },
  });
  return { readOptions, result };
}

const planningEvidenceFixtures = readQaScenarioPack()
  .scenarios.filter(isPlanningEvidenceScenario)
  .map(createPlanningEvidenceFixture);

describe("scenario-flow-runner", () => {
  it.each(
    telegramRichObservationCases.filter(
      (testCase) => testCase === "message" || testCase === "wrong-edit-marker",
    ),
  )(
    "correlates Telegram rich observations without crossing account IDs: %s",
    assertTelegramRichObservationFlow,
  );

  it("keeps live goal followthrough inside the active-goal context limit", async () => {
    const state = createQaBusState();
    const artifactFile = "goal-continuance-live-00000000.txt";
    const artifactText = "Goal continuance advanced the concrete next step.";
    const conversation = "dm:goal-followthrough-live-00000000";

    const sessionListCalls: string[] = [];
    const result = await runLoadedScenarioFlow("goal-followthrough-live", {
      state,
      api: {
        env: {
          providerMode: "live-frontier",
          gateway: {
            workspaceDir: "/qa-goal",
            call: async (method: string) => {
              sessionListCalls.push(method);
              return {
                sessions: [
                  {
                    key: "agent:qa:main",
                    hasActiveRun: sessionListCalls.length === 1,
                    goal: { status: "active", objective: artifactFile },
                  },
                ],
              };
            },
          },
        },
        path: { join: (...parts: string[]) => parts.join("/") },
        fs: {
          readFile: async (file: string) => {
            const continued = state
              .getSnapshot()
              .messages.some(
                (message) => message.direction === "inbound" && message.text === "continue",
              );
            if (file === `/qa-goal/${artifactFile}` && continued) {
              return artifactText;
            }
            throw new Error("goal artifact has not been written");
          },
        },
        normalizeLowercaseStringOrEmpty,
      },
      onWaitForOutboundMessage: ({ waitCount, state: currentState }) => {
        const currentInbound = currentState
          .getSnapshot()
          .messages.findLast((message) => message.direction === "inbound");
        currentState.addOutboundMessage({
          accountId: "qa-channel",
          to: conversation,
          replyToId: currentInbound?.id,
          text: waitCount === 1 ? "GOAL-CONTINUANCE-READY" : "GOAL-CONTINUANCE-DONE",
        });
      },
    });

    expect(result.status).toBe("pass");
    expect(sessionListCalls).toEqual(["sessions.list", "sessions.list", "sessions.list"]);
    const start = state
      .getSnapshot()
      .messages.find(
        (message) => message.direction === "inbound" && message.text.startsWith("/goal start "),
      );
    expect(start).toBeDefined();
    const objective = start?.text.slice("/goal start ".length) ?? "";
    expect(objective.length).toBeLessThanOrEqual(200);
    expect(objective).toContain("GOAL-CONTINUANCE-READY");
    expect(objective).toContain("GOAL-CONTINUANCE-DONE");
    expect(objective).toContain(artifactFile);
    expect(objective).toContain(artifactText);
    expect(
      state
        .getSnapshot()
        .messages.some((message) => message.direction === "inbound" && message.text === "continue"),
    ).toBe(true);
  });

  it("fails before continuation when the model prematurely completes a staged goal", async () => {
    const state = createQaBusState();
    const artifactFile = "goal-continuance-live-00000000.txt";
    const conversation = "dm:goal-followthrough-live-00000000";

    await expect(
      runLoadedScenarioFlow("goal-followthrough-live", {
        state,
        api: {
          env: {
            providerMode: "live-frontier",
            gateway: {
              workspaceDir: "/qa-goal",
              call: async () => ({
                sessions: [
                  {
                    key: "agent:qa:main",
                    hasActiveRun: false,
                    goal: { status: "complete", objective: artifactFile },
                  },
                ],
              }),
            },
          },
          path: { join: (...parts: string[]) => parts.join("/") },
          fs: {
            readFile: async () => {
              throw new Error("goal artifact has not been written");
            },
          },
        },
        onWaitForOutboundMessage: ({ state: currentState }) => {
          const currentInbound = currentState
            .getSnapshot()
            .messages.findLast((message) => message.direction === "inbound");
          currentState.addOutboundMessage({
            accountId: "qa-channel",
            to: conversation,
            replyToId: currentInbound?.id,
            text: "GOAL-CONTINUANCE-READY",
          });
        },
      }),
    ).rejects.toThrow("goal closed before continue");
    expect(
      state
        .getSnapshot()
        .messages.some((message) => message.direction === "inbound" && message.text === "continue"),
    ).toBe(false);
  });

  it("rejects an artifact written after the ready preview but before the first goal turn settles", async () => {
    const state = createQaBusState();
    const artifactFile = "goal-continuance-live-00000000.txt";
    const conversation = "dm:goal-followthrough-live-00000000";
    let sessionListCalls = 0;

    await expect(
      runLoadedScenarioFlow("goal-followthrough-live", {
        state,
        api: {
          env: {
            providerMode: "live-frontier",
            gateway: {
              workspaceDir: "/qa-goal",
              call: async () => {
                sessionListCalls += 1;
                return {
                  sessions: [
                    {
                      key: "agent:qa:main",
                      hasActiveRun: sessionListCalls === 1,
                      goal: { status: "active", objective: artifactFile },
                    },
                  ],
                };
              },
            },
          },
          path: { join: (...parts: string[]) => parts.join("/") },
          fs: {
            readFile: async () => {
              if (sessionListCalls >= 2) {
                return "Goal continuance advanced the concrete next step.";
              }
              throw new Error("goal artifact has not been written");
            },
          },
        },
        onWaitForOutboundMessage: ({ state: currentState }) => {
          const currentInbound = currentState
            .getSnapshot()
            .messages.findLast((message) => message.direction === "inbound");
          currentState.addOutboundMessage({
            accountId: "qa-channel",
            to: conversation,
            replyToId: currentInbound?.id,
            text: "GOAL-CONTINUANCE-READY",
          });
        },
      }),
    ).rejects.toThrow("goal created the second-step artifact before continue");

    expect(sessionListCalls).toBe(2);
    expect(
      state
        .getSnapshot()
        .messages.some((message) => message.direction === "inbound" && message.text === "continue"),
    ).toBe(false);
  });

  it.each(planningEvidenceFixtures)(
    "rejects stale prior-attempt planning evidence for $scenario.id",
    async (fixture) => {
      const currentSummary = {
        eventCursor: 8,
        ...(fixture.scenario.execution.runtime === "codex"
          ? {
              assistantMirrors: [
                { identity: "current-turn:assistant", text: fixture.outboundText },
              ],
            }
          : {}),
        successfulToolCallCounts: {},
      };
      const { readOptions, result } = runPlanningEvidenceFixture(fixture, currentSummary);

      await expect(result).rejects.toThrow(fixture.failureMessage);
      expect(readOptions).toEqual([{ allowEmpty: true }, { afterEventCursor: 7 }]);
    },
  );

  it("runs the canonical reaction lifecycle with target-bound actions", async () => {
    const state = createQaBusState();
    const actionTargets: unknown[] = [];
    const result = await runLoadedScenarioFlow("reaction-edit-delete", {
      state,
      api: {
        handleQaAction: async (params: {
          action: "delete" | "edit" | "react";
          args: Record<string, unknown>;
        }) => {
          actionTargets.push(params.args.to);
          const messageId = String(params.args.messageId);
          if (params.action === "react") {
            return state.reactToMessage({
              messageId,
              emoji: String(params.args.emoji),
            });
          }
          if (params.action === "edit") {
            return state.editMessage({
              messageId,
              text: String(params.args.text),
            });
          }
          return state.deleteMessage({ messageId });
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(actionTargets).toEqual(["channel:qa-room", "channel:qa-room", "channel:qa-room"]);
  });

  it("fails when a flow calls a transport method the adapter does not implement", async () => {
    await expect(
      runLoadedScenarioFlow("channel-message-flows", {
        omitOutboundSequence: true,
      }),
    ).rejects.toThrow(
      'QA scenario "channel-message-flows" cannot run "waitForOutboundSequence": the active transport adapter does not implement this method.',
    );
  });

  it("supports qaImport inside flow expressions", async () => {
    const result = await runScenarioFlow({
      api: createImportApi("qa-import"),
      scenarioTitle: "qa-import",
      vars: { preparedValue: "ready" },
      flow: {
        steps: [
          {
            name: "uses qaImport",
            actions: [
              {
                set: "basename",
                value: {
                  expr: '(await qaImport("node:path")).basename("/tmp/skill/SKILL.md")',
                },
              },
              {
                assert: {
                  expr: 'basename === "SKILL.md"',
                },
              },
              { assert: 'preparedValue === "ready"' },
            ],
            detailsExpr: "basename",
          },
        ],
      },
    });

    expect(result).toEqual({
      name: "qa-import",
      status: "pass",
      steps: [
        {
          name: "uses qaImport",
          status: "pass",
          details: "SKILL.md",
        },
      ],
    });
  });

  it("loads bundled QA runtime modules through qaImport", async () => {
    const result = await runScenarioFlow({
      api: createImportApi("qa-fixture-import"),
      scenarioTitle: "qa-fixture-import",
      flow: {
        steps: [
          {
            name: "uses bundled fixture qaImport",
            actions: [
              {
                set: "plugin",
                value: {
                  expr: 'await qaImport("./codex-plugin.fixture.js")',
                },
              },
              {
                set: "artifacts",
                value: { expr: 'await qaImport("./suite-artifacts.js")' },
              },
              {
                set: "redaction",
                value: { expr: 'await qaImport("./gateway-log-redaction.js")' },
              },
              {
                assert: {
                  expr:
                    'typeof plugin.evaluateCodexPluginLifecycle === "function" && ' +
                    'typeof artifacts.publishQaSuiteArtifactFiles === "function" && ' +
                    'typeof redaction.redactQaGatewayDebugText === "function"',
                },
              },
            ],
            detailsExpr: '"loaded"',
          },
        ],
      },
    });

    expect(result.status).toBe("pass");
    expect(result.steps[0]?.details).toBe("loaded");
  });

  it("passes an imported QA skip error through to runScenario", async () => {
    const message = "known-harness-gap flow import skip";
    let receivedError: unknown;

    const result = await runScenarioFlow({
      api: createImportApi("qa-skip-import", async (_name, steps) => {
        try {
          await steps[0]?.run();
        } catch (error) {
          receivedError = error;
        }
        return {
          name: "qa-skip-import",
          status: "skip" as const,
          steps: [{ name: "throws imported skip", status: "skip" as const, details: message }],
          details: message,
        };
      }),
      scenarioTitle: "qa-skip-import",
      flow: {
        steps: [
          {
            name: "throws imported skip",
            actions: [
              {
                call: "qaImport",
                args: ["./errors.js"],
                saveAs: "qaErrors",
              },
              {
                throw: {
                  expr: `new qaErrors.QaSuiteScenarioSkipError(${JSON.stringify(message)})`,
                },
              },
            ],
          },
        ],
      },
    });

    expect(receivedError).toBeInstanceOf(QaSuiteScenarioSkipError);
    expect(receivedError).toMatchObject({
      name: "QaSuiteScenarioSkipError",
      message,
    });
    expect(result.status).toBe("skip");
    expect(result.details).toBe(message);
  });

  it.each([
    {
      scenarioId: "channel-chat-baseline",
      to: "channel:qa-room",
      text: "generic shared-channel reply without the required marker",
    },
  ])("rejects unmarked outbound replies for $scenarioId", async ({ scenarioId, to, text }) => {
    await expect(
      runLoadedScenarioFlow(scenarioId, {
        onWaitForOutboundMessage: ({ state }) => {
          state.addOutboundMessage({
            accountId: "qa-channel",
            to,
            text,
          });
        },
      }),
    ).rejects.toThrow("waiting for outbound marker");
  });

  it("rejects reconnect follow-up replies that replay the first marker", async () => {
    await expect(
      runLoadedScenarioFlow("qa-channel-reconnect-dedupe", {
        onWaitForOutboundMessage: ({ waitCount, state }) => {
          if (waitCount === 1) {
            state.addOutboundMessage({
              accountId: "qa-channel",
              to: "channel:qa-room",
              text: "RECONNECT-FIRST-OK",
            });
            return;
          }
          state.addOutboundMessage({
            accountId: "qa-channel",
            to: "channel:qa-room",
            text: "RECONNECT-FIRST-OK",
          });
        },
      }),
    ).rejects.toThrow("waiting for outbound marker");
  });

  it("rejects reconnect follow-up turns with extra unmarked outbound replies", async () => {
    await expect(
      runLoadedScenarioFlow("qa-channel-reconnect-dedupe", {
        onWaitForOutboundMessage: ({ waitCount, state }) => {
          if (waitCount === 1) {
            state.addOutboundMessage({
              accountId: "qa-channel",
              to: "channel:qa-room",
              text: "RECONNECT-FIRST-OK",
            });
            return;
          }
          state.addOutboundMessage({
            accountId: "qa-channel",
            to: "channel:qa-room",
            text: "RECONNECT-SECOND-OK",
          });
          state.addOutboundMessage({
            accountId: "qa-channel",
            to: "channel:qa-room",
            text: "unmarked duplicate delivery",
          });
        },
      }),
    ).rejects.toThrow("exactly one marked post-restart reply");
  });

  it("waits through transient transcript states until the webchat reply is durable", async () => {
    let readCount = 0;
    const missingFile = Object.assign(new Error("transcript not written yet"), { code: "ENOENT" });
    const summaries = [
      missingFile,
      { finalText: "", hasDirectReplySelfMessage: false },
      { finalText: "WEBCHAT-DIRECT-REPLY-OK", hasDirectReplySelfMessage: false },
    ];

    const result = await runWebchatTranscriptWait(async () => {
      const summary = summaries[readCount];
      readCount += 1;
      if (summary instanceof Error) {
        throw summary;
      }
      if (!summary) {
        throw new Error("unexpected transcript read");
      }
      return summary;
    });

    expect(result.status).toBe("pass");
    expect(readCount).toBe(3);
  });
});

const scenarioId = "runtime-long-context-cache-stability";
const evidenceLine =
  "CACHE-FIXTURE-0050: stable tool-result evidence for prompt-cache reuse across long sessions.";

async function checkCacheEvidence(marker: string) {
  const scenario = readQaScenarioById(scenarioId);
  const actions = scenario.execution.flow?.steps[0]?.actions;
  const start =
    actions?.findIndex(
      (action) =>
        typeof action === "object" &&
        action !== null &&
        "set" in action &&
        action.set === "cappedReadOutputIndex",
    ) ?? -1;
  if (!actions || start < 0) {
    throw new Error("cache scenario has no evidence assertion");
  }
  const output = [evidenceLine, marker, "fixture tail"].join("\n");
  const flow: QaScenarioFlow = {
    steps: [
      {
        name: "checks actual capped read and follow-up evidence",
        actions: [
          {
            set: "debugRequests",
            value: [
              {
                plannedToolCallId: "read-1",
                plannedToolName: "read",
                plannedToolArgs: { path: "large-cache-fixture.txt" },
              },
              {
                toolOutputCallId: "read-1",
                toolOutput: output,
                allInputText: output,
              },
              {
                prompt: "Using the already-read large-cache-fixture.txt",
                allInputText: evidenceLine,
              },
            ],
          },
          ...actions.slice(start),
        ],
      },
    ],
  };
  return await runLoadedScenarioFlow(scenarioId, { flow, api: { env: { mock: {} } } });
}

describe("large read cache evidence", () => {
  it("accepts a native truncation marker without a shell warning prefix", async () => {
    await expect(checkCacheEvidence("…12345 chars truncated…")).resolves.toMatchObject({
      status: "pass",
    });
  });
});

function splitModelRef(ref: string) {
  const slash = ref.indexOf("/");
  return slash > 0 ? { provider: ref.slice(0, slash), model: ref.slice(slash + 1) } : null;
}

describe("live inbound voice talkback scenario", () => {
  it("reuses the spoken WAV fixture and ignores a deleted streaming preview", async () => {
    const state = createQaBusState();
    const expectedReply = "Matrix QA voice pre-flight OK.";

    const result = await runLoadedScenarioFlow("inbound-voice-talkback-live", {
      state,
      api: {
        env: {
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.4",
          gateway: {
            runtimeEnv: {
              OPENAI_API_KEY: "test-openai-key",
            },
          },
        },
        splitModelRef,
        markGatewayLogCursor: () => 0,
        readGatewayLogs: () => "",
        resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      },
      onWaitForOutboundMessage: ({ state: currentState }) => {
        const preview = currentState.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-live-voice-talkback",
          text: expectedReply,
        });
        currentState.deleteMessage({
          accountId: "qa-channel",
          messageId: preview.id,
        });
        currentState.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-live-voice-talkback",
          text: expectedReply,
        });
      },
    });

    expect(result.status).toBe("pass");
    const inbound = state.getSnapshot().messages.find((message) => message.direction === "inbound");
    const audioBase64 = inbound?.attachments?.[0]?.contentBase64;
    expect(audioBase64).toBeTruthy();
    const audio = Buffer.from(audioBase64 ?? "", "base64");
    expect(audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(audio).toHaveLength(54_238);
    expect(createHash("sha256").update(audio).digest("hex")).toBe(
      "14f4c287682e7762cb17debd99b5126fcb43c875f8a225953ffc71295e6a71cb",
    );
    const outbound = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound");
    expect(outbound).toHaveLength(2);
    expect(outbound.map((message) => message.deleted === true)).toEqual([true, false]);
    expect(outbound.filter((message) => !message.deleted).map((message) => message.text)).toEqual([
      expectedReply,
    ]);
  });
});
