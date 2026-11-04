import { join } from "node:path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaTransportState } from "./qa-transport.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { selectQaFlowSuiteScenarios } from "./suite-planning.js";
import { waitForOutboundMessage } from "./suite-runtime-transport.js";

const scenarioId = "character-vibes-gollum";
const reply = "The build is green, and I am here.";
const outbound = (state: QaTransportState) =>
  state.getSnapshot().messages.filter((message) => message.direction === "outbound");
const classifiedFailureReplies = [
  {
    failureName: "provider failure",
    failureText: '⚠️ No API key found for provider "openai".',
    isError: true,
  },
  {
    failureName: "missing tool failure",
    failureText: "Read: AGENT.md\nEvidence snippet: Tool read not found\nStatus: blocked",
    isError: false,
  },
  {
    failureName: "internal coordination leak",
    failureText: "checking thread context; then post a tight progress reply here.",
    isError: false,
  },
] as const;

function createCharacterScenarioApi(onWaitForOutboundMessage?: () => void) {
  return {
    env: { providerMode: "live-frontier", gateway: { workspaceDir: "/qa-character-workspace" } },
    fs: { writeFile: async () => undefined },
    path: { join },
    normalizeLowercaseStringOrEmpty,
    resolveQaLiveTurnTimeoutMs: () => 10,
    waitForOutboundMessage: async (
      ...[state, predicate, timeoutMs, options]: Parameters<typeof waitForOutboundMessage>
    ) => {
      onWaitForOutboundMessage?.();
      return await waitForOutboundMessage(state, predicate, timeoutMs, {
        ...options,
        accountId: "qa-channel",
      });
    },
    formatConversationTranscript: (state: QaTransportState) =>
      state
        .getSnapshot()
        .messages.map((message) => `${message.direction}:${message.text}`)
        .join("\n"),
  };
}

describe("character scenario transcript safety", () => {
  it("requires a live provider", () => {
    const scenario = readQaScenarioById(scenarioId);
    const select = (explicit: boolean, live = false) =>
      selectQaFlowSuiteScenarios({
        scenarios: [scenario],
        ...(explicit ? { scenarioIds: [scenarioId] } : {}),
        providerMode: live ? "live-frontier" : "mock-openai",
        primaryModel: `${live ? "openai" : "mock-openai"}/gpt-5.6-luna`,
      });
    expect(scenario.execution.config?.requiredProviderMode).toBe("live-frontier");
    expect(() => select(true)).toThrow(`${scenarioId} (providerMode=live-frontier)`);
    expect(select(false)).toEqual([]);
    expect(select(true, true)).toEqual([scenario]);
  });

  it.each(classifiedFailureReplies)(
    "rejects a $failureName after an actual reply",
    async ({ failureText, isError }) => {
      const state = createQaBusState();
      let waitCount = 0;

      await expect(
        runLoadedScenarioFlow(scenarioId, {
          state,
          api: createCharacterScenarioApi(() => {
            state.addOutboundMessage({
              accountId: "qa-channel",
              to: "dm:alice",
              text: waitCount++ === 0 ? reply : failureText,
              ...(waitCount > 1 && isError ? { isError: true } : {}),
            });
          }),
        }),
      ).rejects.toThrow(failureText);

      expect(outbound(state).map((message) => message.text)).toEqual([reply, failureText]);
    },
  );

  it("keeps partially missing replies visible without aborting", async () => {
    const state = createQaBusState();
    const result = await runLoadedScenarioFlow(scenarioId, {
      state,
      api: createCharacterScenarioApi(() => {
        if (outbound(state).length) {
          return;
        }
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:alice",
          text: reply,
        });
      }),
    });

    expect(result.status).toBe("pass");
    expect(result.steps[0]?.details).toContain("inbound:");
    expect(result.steps[0]?.details).toContain(`outbound:${reply}`);
    const messages = state.getSnapshot().messages;
    expect(messages.filter((message) => message.direction === "inbound")).toHaveLength(4);
    expect(outbound(state)).toHaveLength(1);
  });
});
