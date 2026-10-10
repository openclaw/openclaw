import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { extractToolPayload } from "openclaw/plugin-sdk/tool-payload";
import { afterEach, describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  readQaScenarioFile,
} from "./scenario-catalog.js";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { recentOutboundSummary } from "./suite-runtime-transport.js";
import { projectQaToolActivity } from "./tool-activity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const telegramStreamingFinalScenarios = [
  {
    scenarioId: "telegram-stream-final-single-message",
    finalTexts: ["QA-TELEGRAM-STREAM-SINGLE-OK"],
  },
  {
    scenarioId: "telegram-long-final-reuses-preview",
    finalTexts: ["TELEGRAM-LONG-FINAL-BEGIN first", "second TELEGRAM-LONG-FINAL-END"],
  },
  {
    scenarioId: "telegram-long-final-three-chunks",
    finalTexts: [
      "TELEGRAM-LONG-FINAL-3CHUNK-BEGIN first",
      "second final chunk",
      "third TELEGRAM-LONG-FINAL-3CHUNK-END",
    ],
  },
] as const;

function runTelegramStreamingFinalScenario(params: {
  scenarioId: string;
  finalTexts: readonly string[];
}) {
  return runLoadedScenarioFlow(params.scenarioId, {
    state: createQaBusState(),
    onWaitForOutboundMessage: ({ state }) => {
      const preview = state.addOutboundMessage({
        accountId: "qa-channel",
        to: "channel:telegram-stream-room",
        text: "deleted streaming preview",
      });
      state.deleteMessage({ accountId: "qa-channel", messageId: preview.id });
      for (const text of params.finalTexts) {
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "channel:telegram-stream-room",
          text,
        });
      }
    },
  });
}

function runFanoutScenario(
  options: {
    receipt?:
      | "missing"
      | "failed"
      | "unlinked"
      | "same-child"
      | "wrong-label"
      | "missing-run"
      | "same-run";
    providerMode?: "live-frontier" | "mock-openai";
    reply?: string;
    completion?: "unfinished" | "failed" | "wrong-run" | "yielded" | "empty" | "wrong-result";
  } = {},
) {
  const providerMode = options.providerMode ?? "live-frontier";
  return runLoadedScenarioFlow("subagent-fanout-synthesis", {
    api: {
      env: {
        providerMode,
      },
      readSessionToolActivity: async (_env: unknown, sessionKey: string) => {
        const attempt = sessionKey.split(":")[3];
        const messages = ["alpha", "beta"].flatMap((worker) => {
          const isBeta = worker === "beta";
          const callId = `spawn-${worker}`;
          const call = {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: callId,
                name: "sessions_spawn",
                arguments: {
                  label:
                    options.receipt === "wrong-label" && isBeta
                      ? "unrelated"
                      : `qa-fanout-${worker}${providerMode === "mock-openai" ? "" : `-${attempt}`}`,
                  cleanup: "delete",
                },
              },
            ],
          };
          const result = {
            role: "toolResult",
            toolName: "sessions_spawn",
            toolCallId: options.receipt === "unlinked" && isBeta ? "unrelated" : callId,
            isError: options.receipt === "failed" && isBeta,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: options.receipt === "failed" && isBeta ? "error" : "accepted",
                  childSessionKey: `agent:qa:subagent:${options.receipt === "same-child" ? "alpha" : worker}`,
                  runId:
                    options.receipt === "missing-run" && isBeta
                      ? undefined
                      : `run-${options.receipt === "same-run" ? "alpha" : worker}`,
                }),
              },
            ],
          };
          return options.receipt === "missing" && isBeta ? [call] : [call, result];
        });
        return projectQaToolActivity(messages);
      },
      waitForAgentRun: async (_env: unknown, runId: string) => {
        const completion = runId === "run-beta" ? options.completion : undefined;
        if (completion === "unfinished") {
          return { runId, status: "timeout" };
        }
        const reply =
          providerMode === "mock-openai" ? (runId === "run-alpha" ? "ALPHA-OK" : "BETA-OK") : "ok";
        return {
          runId: completion === "wrong-run" ? "unrelated-run" : runId,
          status: completion === "failed" ? "error" : "ok",
          endedAt: 200,
          ...(completion === "yielded" ? { yielded: true } : {}),
          terminalReply:
            completion === "empty"
              ? { disposition: "empty" }
              : {
                  disposition: "visible",
                  text: completion === "wrong-result" ? "ALPHA-OK" : reply,
                },
        };
      },
      startAgentRun: async () => ({ runId: "parent-run" }),
      waitForAgentHistoryReply: async (
        _env: unknown,
        _sessionKey: string,
        matches: (text: string) => boolean,
      ) => {
        const text = options.reply ?? "subagent-1: ok\nsubagent-2: ok";
        if (!matches(text)) {
          throw new Error("parent synthesis missing");
        }
        return { text };
      },
      // Delete-cleanup retires these rows after the requester has consumed both results.
      readNativeQaSubagentRuns: async () => [],
      extractQaToolPayload: extractToolPayload,
      normalizeLowercaseStringOrEmpty,
      formatErrorMessage: (error: Error) => error.message,
    },
  });
}

describe("qa scenario catalog channel contracts", () => {
  const agentRuntime = "agent-runtime";

  it("runs the Telegram RTT exact-marker scenario through an isolated direct message", () => {
    const scenario = requireFlowScenario(readQaScenarioById("telegram-reply-chain-exact-marker"));
    expect(scenario.execution.transportPolicy).toEqual({ directMessageOnly: true });
    expect(scenario.execution.flow?.steps[0]?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sendInbound: expect.objectContaining({
            conversation: { id: "telegram-reply-chain-dm", kind: "direct" },
          }),
        }),
        expect.objectContaining({
          waitForOutbound: expect.objectContaining({
            conversation: { id: "telegram-reply-chain-dm", kind: "direct" },
          }),
        }),
      ]),
    );
  });

  it("routes native command session targeting through Crabline Telegram", () => {
    const scenario = readQaScenarioById("native-command-session-target");
    const config = readQaScenarioExecutionConfig("native-command-session-target") as
      | {
          requiredChannelDriver?: string;
          requiredProviderMode?: string;
        }
      | undefined;

    expect(scenario.execution.channel).toBe("telegram");
    expect(scenario.execution.channels).toEqual(["telegram"]);
    expect(config?.requiredProviderMode).toBe("mock-openai");
    expect(config?.requiredChannelDriver).toBe("crabline");
    const flow = JSON.stringify(requireFlowScenario(scenario).execution.flow);
    expect(flow).toContain("transport.buildAgentDelivery");
    expect(flow).toContain("peer: { kind: 'group', id: delivery.replyTo }");
  });

  it("keeps channel-owned scenarios independent from the driver implementation", () => {
    const channelByScenarioId = new Map<string, { channel: string; sharedCall?: string }>([
      [
        "matrix-restart-resume",
        { channel: "matrix", sharedCall: "env.gateway.restartAfterStateMutation" },
      ],
      [
        "slack-restart-resume",
        { channel: "slack", sharedCall: "env.gateway.restartAfterStateMutation" },
      ],
      [
        "whatsapp-restart-resume",
        { channel: "whatsapp", sharedCall: "env.gateway.restartAfterStateMutation" },
      ],
      [
        "whatsapp-access-control-dm-disabled",
        { channel: "whatsapp", sharedCall: "config.expectReply" },
      ],
      [
        "whatsapp-access-control-dm-open",
        { channel: "whatsapp", sharedCall: "config.expectReply" },
      ],
      [
        "whatsapp-access-control-group-disabled",
        { channel: "whatsapp", sharedCall: "config.expectReply" },
      ],
      [
        "whatsapp-access-control-group-open",
        { channel: "whatsapp", sharedCall: "config.expectReply" },
      ],
      ["whatsapp-pairing-block", { channel: "whatsapp" }],
      ["matrix-allowlist-hot-reload", { channel: "matrix" }],
    ]);

    for (const [scenarioId, expected] of channelByScenarioId) {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      expect(scenario.execution.channel, scenarioId).toBe(expected.channel);
      if (expected.sharedCall) {
        expect(scenario.execution.flowKind, scenarioId).toBe("steps");
        expect(scenario.execution.suiteIsolation, scenarioId).toBe("isolated");
        expect(JSON.stringify(scenario.execution.flow), scenarioId).toContain(expected.sharedCall);
      }
    }
  });

  it("keeps the memory channel-context proof on the internal QA channel", () => {
    expect(readQaScenarioById("memory-tools-channel-context").execution.channel).toBe("qa-channel");
  });

  it("keeps channel participant identity proof on isolated QA Channel lifecycle owners", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("channel-participant-identity-inspection"),
    );
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution.channel).toBe("qa-channel");
    expect(scenario.execution.suiteIsolation).toBe("isolated");
    expect(scenario.gatewayConfigPatch).toMatchObject({
      logging: { audit: { executionIdentity: true } },
      messages: { queue: { mode: "collect", debounceMsByChannel: { "qa-channel": 1000 } } },
      channels: { "qa-channel": { groupPolicy: "allowlist" } },
    });
    expect(flow).toContain("inspectQaExecutionIdentityStorage");
    expect(flow).toContain("env.gateway.restartAfterStateMutation");
  });

  it("keeps stored inbound audio proof on the real QA Channel and Gateway flow", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("inbound-media-store-audio-transcription"),
    );
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.coverage?.primary).toEqual(["media.inbound-media-store"]);
    expect(scenario.coverage?.secondary).toEqual(["channels.inbound-media-normalization"]);
    expect(scenario.plugins).toContain("openai");
    expect(scenario.execution.channel).toBe("qa-channel");
    expect(scenario.execution.providerMode).toBe("mock-openai");
    expect(flow).toContain('"sendInbound"');
    expect(flow).toContain('"contentBase64"');
    expect(flow).toContain('"mediaFactCarrier":"media-store-url"');
    expect(flow).toContain("String(candidate.text ?? '').trim() === config.expectedMarker");
    expect(flow).toContain("String(message.text ?? '').trim() === config.expectedMarker");
    expect(flow).toContain("conversationOutbound.length === 1");
    expect(flow).not.toContain(".includes(config.expectedMarker)");
    expect(scenario.gatewayConfigPatch).toMatchObject({
      tools: { media: { audio: { echoTranscript: false } } },
    });
    expect(flow).not.toContain('"call":"runAgentPrompt"');
  });

  it("preserves module flow identity without mutating the driver contract", () => {
    for (const scenarioId of [
      "matrix-approval-exec-metadata-single-event",
      "matrix-mxid-prefixed-command-block",
      "slack-codex-approval-exec-native",
      "slack-codex-approval-plugin-native",
      "slack-progress-commentary-verbose-full",
    ]) {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      expect(scenario.execution.flowKind, scenarioId).toBe("module");
      expect(
        readQaScenarioExecutionConfig(scenarioId)?.requiredChannelDriver,
        scenarioId,
      ).toBeUndefined();
    }
  });

  it("binds current-source thread receipt proof to the QA Gateway lane", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("thread-reply-current-source-delivery"),
    );
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution.channel).toBe("qa-channel");
    expect(scenario.gatewayConfigPatch).toMatchObject({
      messages: { groupChat: { visibleReplies: "automatic" } },
      tools: { alsoAllow: ["message"] },
      agents: { entries: { qa: { tools: { alsoAllow: ["message"] } } } },
    });
    expect(scenario.execution.config).toMatchObject({ duplicateWindowMs: 2000 });
    expect(flow).toContain("request.plannedToolArgs?.action === 'thread-reply'");
    expect(flow).toContain("readSessionTranscriptSummary");
    expect(flow).toContain("summary.currentSourceToolDeliveries?.find");
    expect(flow).toContain("turnOutbound.length === 1");
    expect(flow).toContain("divergentOutbound.length === 2");
    expect(flow).toContain("return messages.length === 2 ? messages : undefined");
    expect(flow).toContain("QA-THREAD-RECEIPT-TOOL-OK");
    expect(flow).toContain("QA-THREAD-RECEIPT-FINAL-OK");
  });

  it("keeps the Teams final-dedupe proof on the real Gateway transport", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("msteams-thread-message-tool-final-dedupe"),
    );
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution.channel).toBe("msteams");
    expect(scenario.execution.suiteIsolation).toBe("isolated");
    expect(scenario.gatewayConfigPatch).toMatchObject({
      messages: { groupChat: { visibleReplies: "automatic" } },
      tools: { alsoAllow: ["message"] },
      agents: { entries: { qa: { tools: { alsoAllow: ["message"] } } } },
    });
    expect(flow).toContain("QA-MSTEAMS-SAME-OK");
    expect(flow).toContain("QA-MSTEAMS-OTHER-THREAD-OK");
    expect(flow).toContain("QA-MSTEAMS-OTHER-CONVERSATION-OK");
    expect(flow).toContain("QA-MSTEAMS-DM-OK");
    expect(flow).toContain("QA-MSTEAMS-GROUP-OK");
  });

  it("proves ambiguous Teams delivery at the Gateway send boundary", () => {
    const scenario = requireFlowScenario(readQaScenarioById("msteams-ambiguous-gateway-timeout"));
    const flow = JSON.stringify(scenario.execution.flow);

    expect(flow).toContain("env.gateway.call('send'");
    expect(flow.match(/env\.gateway\.call\('send'/g)).toHaveLength(2);
    expect(flow).toContain("idempotencyKey: randomUUID(), message: config.seedMarker");
    expect(flow).toContain("sendError.includes('504')");
    expect(flow).toContain("matchingOutbound.length === 1");
    expect(flow).toContain("seed proactive conversation reference");
    expect(flow.match(/"resetTransport":true/g)).toHaveLength(1);
    expect(flow.match(/"waitForOutbound"/g)).toHaveLength(1);
    expect(flow).toContain("conversation:19:ambiguous-timeout@thread.tacv2");
    expect(scenario.execution.config).toMatchObject({
      seedMarker: "QA-MSTEAMS-CONVERSATION-READY",
    });
  });

  it("keeps Telegram semantic receipts and compaction previews order-independent", () => {
    const semantic = requireFlowScenario(
      readQaScenarioById("telegram-semantic-formatting-boundaries"),
    );
    const compaction = requireFlowScenario(
      readQaScenarioById("telegram-claude-cli-compaction-final-priority"),
    );
    const semanticFlow = JSON.stringify(semantic.execution.flow);
    const compactionFlow = JSON.stringify(compaction.execution.flow);

    expect(semanticFlow).toContain(
      "readTelegramMessages().slice(startIndex).some((message) => String(message.botApiMessageId) === String(receipt.messageId))",
    );
    expect(semanticFlow).not.toContain("received.at(-1)?.botApiMessageId");
    expect(semanticFlow).not.toContain('"set":"expectedNormalized"');
    expect(semanticFlow).toContain("actual.length === fixture.expectedChunks.length");
    expect(semanticFlow).toContain("entity.type['@type'] === expectedEntity.type['@type']");
    expect(semanticFlow).toContain("entity.type.url === expectedEntity.type.url");
    expect(semanticFlow).toContain("entity.type.language === expectedEntity.type.language");
    expect(semanticFlow).not.toContain("JSON.stringify(actual) === JSON.stringify");
    expect(compactionFlow).toContain('"minimumPreviewEvents":2');
    expect(compactionFlow).toContain("progress: { commentary: true, toolProgress: true }");
    expect(compactionFlow).toContain("config.commentaryOne");
    expect(compactionFlow).toContain("config.commentaryTwo");
    expect(compactionFlow).toContain("Compacting context");
  });

  it("isolates scenarios that own asynchronous transport state", () => {
    const channelBaseline = requireFlowScenario(readQaScenarioById("channel-chat-baseline"));
    const subagentFanout = requireFlowScenario(readQaScenarioById("subagent-fanout-synthesis"));
    const matrixProgress = requireFlowScenario(
      readQaScenarioById("matrix-room-tool-progress-mention-safety"),
    );

    expect(channelBaseline.execution.suiteIsolation).toBe("isolated");
    expect(subagentFanout.execution.suiteIsolation).toBe("isolated");
    expect(matrixProgress.execution.suiteIsolation).toBe("isolated");
    expect(matrixProgress.execution.isolationReason).toContain("streaming progress configuration");
  });

  it.each(["live-frontier", "mock-openai"] as const)(
    "accepts %s fanout after delete-cleanup retires native child rows",
    async (providerMode) => {
      await expect(runFanoutScenario({ providerMode })).resolves.toMatchObject({ status: "pass" });
    },
  );

  it("rejects beta completing with alpha's mock result", async () => {
    await expect(
      runFanoutScenario({ providerMode: "mock-openai", completion: "wrong-result" }),
    ).rejects.toThrow("child completion missing");
  });

  it.each([
    "missing",
    "failed",
    "unlinked",
    "same-child",
    "wrong-label",
    "missing-run",
    "same-run",
  ] as const)("rejects %s spawn evidence despite matching parent synthesis", async (receipt) => {
    await expect(runFanoutScenario({ receipt })).rejects.toThrow("test condition was not met");
  });

  it.each(["unfinished", "failed", "wrong-run", "yielded", "empty", "wrong-result"] as const)(
    "rejects %s child completion despite accepted spawns and matching parent synthesis",
    async (completion) => {
      await expect(runFanoutScenario({ completion })).rejects.toThrow("child completion missing");
    },
  );

  it.each(["subagent-1: ok", "still waiting: subagent-1: ok\nsubagent-2: ok"])(
    "rejects incomplete parent synthesis %j despite accepted spawns",
    async (reply) => {
      await expect(runFanoutScenario({ reply })).rejects.toThrow("parent synthesis missing");
    },
  );

  it("settles terminal-reply scenarios from native run facts instead of sleeps", () => {
    const scenario = requireFlowScenario(readQaScenarioById("subagent-completion-direct-fallback"));
    const flow = JSON.stringify(scenario.execution.flow);
    const config = scenario.execution.config as
      | {
          requiredProviderMode?: string;
          cases?: Array<{ name?: string; marker?: string; expectedSendCount?: number }>;
        }
      | undefined;

    expect(scenario.execution.providerMode).toBe("mock-openai");
    expect(config?.requiredProviderMode).toBe("mock-openai");
    expect(config?.cases).toEqual([
      {
        name: "visible",
        marker: "QA-SUBAGENT-TERMINAL-VISIBLE-OK",
        expectedSendCount: 1,
      },
      {
        name: "silent",
        marker: "QA-SUBAGENT-TERMINAL-SILENT-REPRESENTED",
        expectedSendCount: 1,
      },
      {
        name: "fallback",
        marker: "QA-SUBAGENT-TERMINAL-FALLBACK-OK",
        expectedSendCount: 1,
      },
    ]);
    expect(flow).toContain("readNativeQaSubagentRuns(env)");
    expect(flow).not.toContain("tasks.list");
    expect(flow).toContain("run.label === `qa-terminal-${caseName}`");
    expect(flow).toContain("terminalRun.execution.status === 'terminal'");
    expect(flow).toContain("run.delivery?.status === 'delivered'");
    expect(flow).toContain("readSettledTerminalRun('restart')");
    expect(flow).toContain("postRestartUnexpectedPayloads.length === 0");
    expect(flow).toContain("env.providerMode === config.requiredProviderMode");
    expect(flow).not.toContain("interrupted by a gateway restart");
    expect(flow).toContain("verdicts.length === 5");
    expect(flow).not.toContain('"call":"sleep"');
  });

  it("keeps channel streaming evidence portable across QA Channel and Crabline Telegram", () => {
    const scenario = requireFlowScenario(readQaScenarioById("channel-message-flows"));

    expect(scenario.execution.channel).toBeUndefined();
    expect(scenario.execution.channels).toEqual(["qa-channel", "telegram"]);
    expect(scenario.execution.retryCount).toBe(0);
    expect(scenario.coverage?.primary).toEqual(["channels.streaming-final-reply"]);
    expect(scenario.coverage?.secondary).toEqual([`${agentRuntime}.streaming-replies-delivery`]);
    expect(scenario.gatewayConfigPatch).toMatchObject({
      channels: { telegram: { streaming: { mode: "partial" } } },
    });
    expect(scenario.gatewayConfigPatch).not.toHaveProperty("channels.telegram.groups");
  });

  it.each(telegramStreamingFinalScenarios)(
    "counts only visible Telegram finals for $scenarioId after deleting its preview",
    async (scenario) => {
      await expect(runTelegramStreamingFinalScenario(scenario)).resolves.toMatchObject({
        status: "pass",
      });
    },
  );

  it("rejects a deleted Telegram preview standing in for a missing final chunk", async () => {
    await expect(
      runTelegramStreamingFinalScenario({
        scenarioId: "telegram-long-final-three-chunks",
        finalTexts: [
          "TELEGRAM-LONG-FINAL-3CHUNK-BEGIN first",
          "second TELEGRAM-LONG-FINAL-3CHUNK-END",
        ],
      }),
    ).rejects.toThrow("expected three complete final chunks; saw 2");
  });

  it("keeps the shared channel canary eligible for its supported channels", () => {
    const scenario = requireFlowScenario(readQaScenarioById("channel-canary"));

    expect(scenario.execution.channels).toEqual(["qa-channel", "telegram", "buzz", "msteams"]);
  });

  it.each([
    {
      label: "accepts only the authorized driver reply",
      observerReplies: false,
      driverReplies: true,
      expectedFailure: null,
    },
    {
      label: "rejects an observer reply when the authorized driver never replies",
      observerReplies: true,
      driverReplies: false,
      expectedFailure: "waiting for outbound marker",
    },
    {
      label: "rejects a late observer reply even when the authorized driver replies",
      observerReplies: true,
      driverReplies: true,
      expectedFailure: "blocked sender replied",
    },
  ])("$label", async ({ observerReplies, driverReplies, expectedFailure }) => {
    const state = createQaBusState();
    const result = runLoadedScenarioFlow("channel-sender-allowlist", {
      state,
      api: { recentOutboundSummary },
      onWaitForOutboundMessage: ({ state: currentState }) => {
        for (const [senderId, replies] of [
          ["observer", observerReplies],
          ["driver", driverReplies],
        ] as const) {
          if (!replies) {
            continue;
          }
          const inbound = currentState
            .getSnapshot()
            .messages.find(
              (message) => message.direction === "inbound" && message.senderId === senderId,
            );
          if (!inbound) {
            throw new Error(`missing ${senderId} inbound message`);
          }
          const marker = inbound.text.split("reply exactly: ")[1];
          if (!marker) {
            throw new Error(`missing ${senderId} requested reply marker`);
          }
          currentState.addOutboundMessage({
            accountId: "qa-channel",
            to: "group:qa-routing-allowlist",
            replyToId: inbound.id,
            text: marker,
          });
        }
      },
    });

    if (expectedFailure) {
      await expect(result).rejects.toThrow(expectedFailure);
    } else {
      await expect(result).resolves.toMatchObject({ status: "pass" });
    }

    const snapshot = state.getSnapshot();
    const senderIdsByInboundId = new Map(
      snapshot.messages
        .filter((message) => message.direction === "inbound")
        .map((message) => [message.id, message.senderId]),
    );
    expect(
      snapshot.messages
        .filter((message) => message.direction === "outbound")
        .map((message) => senderIdsByInboundId.get(message.replyToId ?? "")),
    ).toEqual([...(observerReplies ? ["observer"] : []), ...(driverReplies ? ["driver"] : [])]);
  });

  it("keeps transcript-role delivery on the Crabline driver", () => {
    const scenario = readQaScenarioById("telegram-assistant-transcript-role-boundary");
    const config = readQaScenarioExecutionConfig("telegram-assistant-transcript-role-boundary") as
      | {
          requiredChannelDriver?: string;
        }
      | undefined;

    expect(scenario.gatewayConfigPatch).toBeUndefined();
    expect(config?.requiredChannelDriver).toBe("crabline");
  });

  it("rejects malformed string matcher lists before running a flow", async () => {
    const filePath = path.join(tempDirs.make("qa-catalog-"), "scenario.yaml");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        title: "Malformed matcher",
        scenario: {
          id: "malformed-matcher",
          surface: "qa",
          execution: {
            kind: "flow",
            config: { gracefulFallbackAny: [{ confirmed: "the hidden fact is present" }] },
          },
        },
        flow: { steps: [{ name: "validate", actions: [{ assert: "true" }] }] },
      }),
    );
    expect(() => readQaScenarioFile(filePath)).toThrow(
      /gracefulFallbackAny entries must be strings/,
    );
  });

  it("returns undefined execution config for an unknown scenario id", () => {
    expect(readQaScenarioExecutionConfig("missing-scenario-id")).toBeUndefined();
  });
});
