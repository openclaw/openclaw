import { startOpenClawCrablineAdapter } from "@openclaw/crabline";
import type { QaBusInboundMessageInput } from "openclaw/plugin-sdk/qa-channel-protocol";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createCrablineProviderInboundInput } from "./crabline-provider-targets.js";
import { sendQaTransportNativeCommand } from "./qa-transport.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

it("admits the native stop fixture's delayed, command, and recovery messages as Telegram DMs", async () => {
  const scenarioId = "native-command-session-target";
  const flow = readQaScenarioById(scenarioId).execution.flow;
  if (!flow) {
    throw new Error("expected a native stop flow");
  }
  const actions = flow.steps
    .flatMap((step) => step.actions)
    .filter(
      (action) => isRecord(action) && ("sendInbound" in action || "sendNativeCommand" in action),
    );
  const state = createQaBusState();
  const adapter = await startOpenClawCrablineAdapter({ channel: "telegram" });
  const requests: ReturnType<typeof adapter.createInbound>[] = [];
  const sendInbound = async (input: QaBusInboundMessageInput) => {
    requests.push(
      adapter.createInbound({ input: createCrablineProviderInboundInput(adapter, input) }),
    );
    return state.addInboundMessage(input);
  };
  try {
    await runLoadedScenarioFlow(scenarioId, {
      flow: { steps: [{ name: "native fixture admission", actions }] },
      api: {
        transport: {
          sendInbound,
          sendNativeCommand: (input: Parameters<typeof sendQaTransportNativeCommand>[1]) =>
            sendQaTransportNativeCommand({ sendInbound }, input),
        },
      },
    });

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.stateConversation.kind).toBe("direct");
      expect(String(request.providerBody.fromId)).toBe(request.providerBody.chatId);
    }
    expect(requests.map((request) => request.providerBody.text)).toEqual([
      "Subagent recovery worker native command target proof. Wait until stopped.",
      "/stop",
      "Reply exactly: QA-NATIVE-STOP-RECOVERY-OK",
    ]);
    expect(requests[1]?.providerBody.entities).toEqual([
      { type: "bot_command", offset: 0, length: 5 },
    ]);
  } finally {
    await adapter.close();
  }
});
