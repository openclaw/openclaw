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

function runTelegramStreamingFinalScenario() {
  return runLoadedScenarioFlow("telegram-stream-final-single-message", {
    state: createQaBusState(),
    onWaitForOutboundMessage: ({ state }) => {
      const preview = state.addOutboundMessage({
        accountId: "qa-channel",
        to: "channel:telegram-stream-room",
        text: "deleted streaming preview",
      });
      state.deleteMessage({ accountId: "qa-channel", messageId: preview.id });
      state.addOutboundMessage({
        accountId: "qa-channel",
        to: "channel:telegram-stream-room",
        text: "QA-TELEGRAM-STREAM-SINGLE-OK",
      });
    },
  });
}

function runUnlinkedFanoutScenario() {
  return runLoadedScenarioFlow("subagent-fanout-synthesis", {
    api: {
      env: { providerMode: "live-frontier" },
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
                  label: `qa-fanout-${worker}-${attempt}`,
                  cleanup: "delete",
                },
              },
            ],
          };
          const result = {
            role: "toolResult",
            toolName: "sessions_spawn",
            toolCallId: isBeta ? "unrelated" : callId,
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "accepted",
                  childSessionKey: `agent:qa:subagent:${worker}`,
                  runId: `run-${worker}`,
                }),
              },
            ],
          };
          return [call, result];
        });
        return projectQaToolActivity(messages);
      },
      waitForAgentRun: async (_env: unknown, runId: string) => ({
        runId,
        status: "ok",
        endedAt: 200,
        terminalReply: { disposition: "visible", text: "ok" },
      }),
      startAgentRun: async () => ({ runId: "parent-run" }),
      waitForAgentHistoryReply: async (
        _env: unknown,
        _sessionKey: string,
        matches: (text: string) => boolean,
      ) => {
        const text = "subagent-1: ok\nsubagent-2: ok";
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
    const { channel, channels } = scenario.execution;
    expect({ channel, channels }).toEqual({ channel: "telegram", channels: ["telegram"] });
    expect(readQaScenarioExecutionConfig("native-command-session-target")).toMatchObject({
      requiredProviderMode: "mock-openai",
      requiredChannelDriver: "crabline",
    });
    const flow = JSON.stringify(requireFlowScenario(scenario).execution.flow);
    expect(flow).toContain("transport.buildAgentDelivery");
    expect(flow).toContain("peer: { kind: 'group', id: delivery.replyTo }");
  });

  it("rejects unlinked spawn evidence despite matching parent synthesis", async () => {
    await expect(runUnlinkedFanoutScenario()).rejects.toThrow("test condition was not met");
  });

  it("counts only visible Telegram finals after deleting its preview", async () => {
    await expect(runTelegramStreamingFinalScenario()).resolves.toMatchObject({ status: "pass" });
  });

  it.each([
    [false, true, null],
    [true, false, "waiting for outbound marker"],
    [true, true, "blocked sender replied"],
  ] as const)(
    "observer=%s driver=%s failure=%s",
    async (observerReplies, driverReplies, expectedFailure) => {
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
    },
  );

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
