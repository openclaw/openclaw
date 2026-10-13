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

  it.each(["unlinked"] as const)(
    "rejects %s spawn evidence despite matching parent synthesis",
    async (receipt) => {
      await expect(runFanoutScenario({ receipt })).rejects.toThrow("test condition was not met");
    },
  );

  it.each(telegramStreamingFinalScenarios)(
    "counts only visible Telegram finals for $scenarioId after deleting its preview",
    async (scenario) => {
      await expect(runTelegramStreamingFinalScenario(scenario)).resolves.toMatchObject({
        status: "pass",
      });
    },
  );

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
});
