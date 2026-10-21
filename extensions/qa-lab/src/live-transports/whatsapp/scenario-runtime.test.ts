import type { WhatsAppQaDriverObservedMessage } from "@openclaw/whatsapp/api.js";
import { afterEach, expect, it, vi } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import { createQaStateBackedTransportAdapter } from "../../qa-transport.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { requireFlowScenario } from "../../scenario-catalog.test-utils.js";
import { runQaSuiteScenarioDefinition } from "../../suite-runtime-flow.js";
import { createDriver, observedMessage, runtimeEnv } from "./runtime.test-support.js";
import { createWhatsAppQaScenarioEnvironment } from "./scenario-environment.js";
import { whatsappScenarioImplementations } from "./scenario-implementations.js";
import { runWhatsAppScenario } from "./scenario-runtime.js";

vi.mock("../../suite-runtime-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../suite-runtime-gateway.js")>()),
  waitForConfigRestartSettle: async () => {},
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("targets group approval reactions at the approval prompt participant", async () => {
  const scenario = requireFlowScenario(
    readQaScenarioById("whatsapp-approval-exec-group-reaction-native"),
  );
  const name = scenario.execution.config?.whatsappScenario;
  const implementation =
    typeof name === "string" ? whatsappScenarioImplementations[name] : undefined;
  if (!implementation) {
    throw new Error(`missing WhatsApp test implementation for ${scenario.id}`);
  }
  const run = implementation.buildRun();
  if (run.kind !== "approval") {
    throw new Error("expected approval scenario run");
  }
  const sendReaction = vi.fn(async () => ({ messageId: "reaction-1" }));
  let approvalId = "";
  let waitCount = 0;
  const driver = createDriver({
    sendReaction,
    waitForMessage: async ({ match }) => {
      waitCount += 1;
      const isPending = waitCount === 1;
      const message = observedMessage(isPending ? "approval-message-1" : "approval-resolved-1", {
        fromJid: "12345@g.us",
        observedAt: isPending ? "2026-06-28T02:00:00.000Z" : "2026-06-28T02:00:01.000Z",
        participantJid: "999@lid",
        text: isPending
          ? `Exec approval required\nID: ${approvalId}\n` +
            `Pending command:\nprintf '%s\\n' '${run.token}'\n\n` +
            "React with:\n\n👍 Allow Once\n👎 Deny"
          : `✅ Exec approval allow-once. ID: ${approvalId}`,
      });
      if (!match(message)) {
        throw new Error(`approval test message ${waitCount} did not match`);
      }
      return message;
    },
  });
  const gateway: Parameters<typeof runWhatsAppScenario>[0]["gateway"] = {
    baseUrl: "http://127.0.0.1:1",
    tempRoot: "/qa",
    workspaceDir: "/qa/workspace",
    runtimeEnv: {},
    call: async (method, payload) => {
      if (method === "exec.approval.request") {
        if (
          !payload ||
          typeof payload !== "object" ||
          !("id" in payload) ||
          typeof payload.id !== "string"
        ) {
          throw new Error("expected approval request id");
        }
        approvalId = payload.id;
        return { id: approvalId, status: "accepted" };
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "allow-once" };
      }
      throw new Error(`unexpected gateway call ${method}`);
    },
  };

  await runWhatsAppScenario({
    preparedScenario: { implementation, run },
    driverAuthDir: "/qa/driver",
    getDriver: () => driver,
    replaceDriver: async () => {},
    gateway,
    runtimeEnv: { ...runtimeEnv, groupJid: "12345@g.us" },
    scenario: { id: scenario.id, timeoutMs: scenario.execution.timeoutMs ?? 60_000 },
    sutAccountId: "work",
  });

  expect(sendReaction).toHaveBeenCalledWith("12345@g.us", "approval-message-1", "👍", {
    fromMe: false,
    participant: "999@lid",
  });
});

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
    const account = {
      accountId: "sut",
      connected: true,
      running: true,
      lastConnectedAt: startedAt,
    };
    const sends: number[] = [];
    const observations: number[] = [];
    const messages: WhatsAppQaDriverObservedMessage[] = [];
    let inputText = "";
    let targetJid = "";
    const driver = createDriver({
      getObservedMessages: () => {
        observations.push(Date.now() - startedAt);
        return messages;
      },
      sendText: async (target, text) => {
        sends.push(Date.now() - startedAt);
        inputText = text;
        targetJid = target;
        if (scenarioId.endsWith("action-react")) {
          messages.push({
            kind: "reaction",
            fromPhoneE164: runtimeEnv.sutPhoneE164,
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
          fromPhoneE164: runtimeEnv.sutPhoneE164,
          fromJid: targetJid,
          observedAt: new Date(Date.now() + 1).toISOString(),
          text: inputText,
        };
        if (!match(reply)) {
          throw new Error("no matching driver observation");
        }
        return reply;
      },
    });
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
          account.lastConnectedAt = Date.now();
          return { hash: "config" };
        }
        if (method === "channels.status") {
          return { channelAccounts: { whatsapp: [account] } };
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
      runtimeEnv,
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
      // WA4 rejects even unrelated replies; mention gating retains its marker filter.
      messages.push({
        kind: "text",
        fromJid: targetJid,
        ...(fault === "unknown sender" ? {} : { fromPhoneE164: runtimeEnv.sutPhoneE164 }),
        observedAt: new Date().toISOString(),
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
