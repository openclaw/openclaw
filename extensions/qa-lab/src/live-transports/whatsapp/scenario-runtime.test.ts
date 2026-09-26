import type {
  WhatsAppQaDriverObservedMessage,
  WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import { createQaStateBackedTransportAdapter } from "../../qa-transport.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { runQaSuiteScenarioDefinition, runQaSuiteScenarioSteps } from "../../suite-runtime-flow.js";
import { createWhatsAppQaScenarioEnvironment } from "./scenario-environment.js";

vi.mock("../../suite-runtime-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../suite-runtime-gateway.js")>()),
  waitForConfigRestartSettle: async () => {},
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("WhatsApp negative scenario deadline", () => {
  it.each([
    { scenarioId: "whatsapp-group-allowlist-block", quietMs: 8_000, fault: "none" },
    { scenarioId: "whatsapp-group-allowlist-block", quietMs: 8_000, fault: "reply" },
    { scenarioId: "whatsapp-group-allowlist-block", quietMs: 8_000, fault: "unknown sender" },
    { scenarioId: "whatsapp-mention-gating", quietMs: 5_000, fault: "none" },
    { scenarioId: "whatsapp-mention-gating", quietMs: 5_000, fault: "reply" },
    { scenarioId: "whatsapp-agent-message-action-react", quietMs: 8_000, fault: "none" },
    { scenarioId: "whatsapp-agent-message-action-react", quietMs: 8_000, fault: "reply" },
    { scenarioId: "whatsapp-group-agent-message-action-react", quietMs: 8_000, fault: "none" },
  ])(
    "observes $scenarioId after preparation (fault: $fault)",
    async ({ scenarioId, quietMs, fault }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const startedAt = Date.now();
      let connectedAt = startedAt;
      const sends: number[] = [];
      const observations: number[] = [];
      const messages: WhatsAppQaDriverObservedMessage[] = [];
      let inputText = "";
      let targetJid = "";
      const driver: WhatsAppQaDriverSession = {
        close: async () => {},
        getObservedMessages: () => {
          observations.push(Date.now() - startedAt);
          return messages;
        },
        sendContact: async () => ({}),
        sendLocation: async () => ({}),
        sendMedia: async () => ({}),
        sendPoll: async () => ({}),
        sendReaction: async () => ({}),
        sendSticker: async () => ({}),
        sendText: async (target, text) => {
          sends.push(Date.now() - startedAt);
          inputText = text;
          targetJid = target;
          if (scenarioId.endsWith("action-react")) {
            messages.push({
              kind: "reaction",
              fromPhoneE164: "+15550000002",
              fromJid: target,
              observedAt: new Date(Date.now() + 1).toISOString(),
              text: "",
              reaction: { emoji: "👍", messageId: "qa-inbound" },
            });
          }
          return { messageId: "qa-inbound" };
        },
        waitForMessage: async ({ match }) => {
          const reply = messages.find(match) ?? {
            kind: "text" as const,
            fromPhoneE164: "+15550000002",
            fromJid: targetJid,
            observedAt: new Date(Date.now() + 1).toISOString(),
            text: inputText,
          };
          if (!match(reply)) {
            throw new Error("no matching driver observation");
          }
          return reply;
        },
      };
      const gateway = {
        baseUrl: "http://127.0.0.1:1",
        tempRoot: "/qa",
        workspaceDir: "/qa/workspace",
        runtimeEnv: {},
        call: async (method: string) => {
          if (method === "config.get") {
            return {
              config: {},
              hash: "config",
              appliedConfigHash: "runtime",
              configRevisionHash: "runtime",
            };
          }
          if (method === "config.patch") {
            connectedAt = Date.now();
            return { hash: "config" };
          }
          if (method === "channels.status") {
            return {
              channelAccounts: {
                whatsapp: [
                  {
                    accountId: "sut",
                    connected: true,
                    running: true,
                    lastConnectedAt: connectedAt,
                  },
                ],
              },
            };
          }
          throw new Error(`unexpected Gateway method: ${method}`);
        },
      };
      const { prepareFlow } = createWhatsAppQaScenarioEnvironment({
        accountId: "sut",
        driverAuthDir: "/qa/driver",
        explicitScenarioSelection: true,
        getDriver: () => driver,
        replaceDriver: async () => {},
        runtimeEnv: {
          driverAuthArchiveBase64: "unused",
          driverPhoneE164: "+15550000001",
          sutAuthArchiveBase64: "unused",
          sutPhoneE164: "+15550000002",
          groupJid: "120363000000000000@g.us",
        },
        sutAuthDir: "/qa/sut",
      });
      const state = createQaBusState();
      const transport = createQaStateBackedTransportAdapter(state, {
        id: "whatsapp",
        label: "WhatsApp",
        accountId: "sut",
        requiredPluginIds: [],
        supportedActions: [],
        prepareFlow,
        sendInbound: async (input) => state.addInboundMessage(input),
        createGatewayConfig: () => ({}),
        waitReady: async () => {},
        buildAgentDelivery: () => ({
          channel: "whatsapp",
          replyChannel: "whatsapp",
          replyTo: "+15550000001",
        }),
        handleAction: async () => {},
        createReportNotes: () => [],
      });
      const result = runQaSuiteScenarioDefinition({
        env: {
          lab: {},
          webSessionIds: new Set(),
          gateway,
          transport,
          outputDir: "/qa/output",
          repoRoot: process.cwd(),
          providerMode: "mock-openai",
          primaryModel: "mock/model",
          alternateModel: "mock/model",
          mock: null,
          cfg: {},
        },
        scenario: readQaScenarioById(scenarioId),
        runScenario: runQaSuiteScenarioSteps,
        splitModelRef: () => null,
        formatErrorMessage: String,
        liveTurnTimeoutMs: () => 60_000,
        resolveQaLiveTurnTimeoutMs: () => 60_000,
        constants: {
          imageUnderstandingPngBase64: "",
          imageUnderstandingLargePngBase64: "",
          imageUnderstandingValidPngBase64: "",
        },
      });
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(13_000);
      expect(settled, "preparation must not consume the scenario deadline").toBe(false);
      expect(sends).toEqual([]);
      await vi.advanceTimersByTimeAsync(7_000);
      await vi.dynamicImportSettled();
      expect(sends).toEqual([20_000]);
      await vi.advanceTimersByTimeAsync(quietMs - 1);
      expect(settled, "must observe the complete quiet window").toBe(false);
      if (fault !== "none") {
        messages.push({
          kind: "text",
          fromJid: targetJid,
          ...(fault === "unknown sender" ? {} : { fromPhoneE164: "+15550000002" }),
          observedAt: new Date().toISOString(),
          // WA4 must reject even an unrelated reply; mention gating keeps its marker filter.
          text: scenarioId === "whatsapp-mention-gating" ? inputText : "unexpected reply",
        });
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject(
        fault === "none"
          ? { status: "pass" }
          : { status: "fail", details: "unexpected WhatsApp reply observed in quiet scenario" },
      );
      expect(observations).toEqual([20_000 + quietMs]);
      expect(sends).toEqual(
        scenarioId === "whatsapp-mention-gating" && fault === "none" ? [20_000, 25_000] : [20_000],
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
