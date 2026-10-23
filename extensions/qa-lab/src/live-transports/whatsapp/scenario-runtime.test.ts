import { expectDefined } from "@openclaw/normalization-core";
import type { WhatsAppQaDriverObservedMessage } from "@openclaw/whatsapp/api.js";
import { WhatsAppChannelConfigSchema } from "@openclaw/whatsapp/channel-config-api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import { createQaStateBackedTransportAdapter } from "../../qa-transport.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { runQaSuiteScenarioDefinition } from "../../suite-runtime-flow.js";
import { createDriver, observedMessage, runtimeEnv, groupJid } from "./runtime.test-support.js";
import { runWhatsAppScenario } from "./scenario-runtime.js";
import {
  environment,
  gateway as makeGateway,
  scenario as getScenario,
} from "./scenario.test-support.js";

vi.mock("../../suite-runtime-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../suite-runtime-gateway.js")>()),
  waitForConfigRestartSettle: async () => {},
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("targets group approval reactions at the approval prompt participant", async () => {
  const definition = getScenario("whatsapp-approval-exec-group-reaction-native");
  const implementation = definition;
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
  const gateway = makeGateway(async (method, payload) => {
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
  });

  await runWhatsAppScenario({
    preparedScenario: { implementation, run },
    driverAuthDir: "/qa/driver",
    getDriver: () => driver,
    replaceDriver: async () => {},
    gateway,
    runtimeEnv: { ...runtimeEnv, groupJid: "12345@g.us" },
    scenario: { id: definition.id, timeoutMs: definition.timeoutMs },
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
        expect(target).toBe(
          scenarioId.startsWith("whatsapp-group-") || scenarioId === "whatsapp-mention-gating"
            ? groupJid
            : runtimeEnv.sutPhoneE164,
        );
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
        const reply: WhatsAppQaDriverObservedMessage = messages.find(match) ?? {
          kind: "text" as const,
          fromPhoneE164: runtimeEnv.sutPhoneE164,
          fromJid: targetJid,
          observedAt: new Date(Date.now() + 1).toISOString(),
          text: inputText,
        };
        if (reply.kind === "reaction") {
          const reaction = expectDefined(reply.reaction, "native reaction");
          for (const rejected of [
            {
              ...reply,
              ...(scenarioId.startsWith("whatsapp-group-")
                ? { fromJid: "other@g.us" }
                : { fromPhoneE164: "+15550000003" }),
            },
            { ...reply, reaction: { ...reaction, emoji: "👎" } },
            { ...reply, reaction: { ...reaction, messageId: "other-message" } },
          ]) {
            expect(match(rejected)).toBe(false);
          }
        }
        expect(match(reply)).toBe(true);
        return reply;
      },
    });
    const gateway = makeGateway(async (method) => {
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
    });
    const { prepareFlow } = environment(() => driver);
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
    const finished = await result;
    expect(finished).toMatchObject(
      fault === "none"
        ? { status: "pass" }
        : { status: "fail", details: "unexpected WhatsApp reply observed in quiet scenario" },
    );
    if (scenarioId.endsWith("action-react") && fault === "none") {
      expect(finished.steps.map((step) => step.details).join("\n")).toMatch(
        scenarioId.startsWith("whatsapp-group-")
          ? /group agent message reaction/i
          : /\breaction\b/i,
      );
    }
    expect(observations).toEqual([20_000 + quietMs]);
    expect(sends).toEqual(
      scenarioId === "whatsapp-mention-gating" && fault === "none" ? [20_000, 25_000] : [20_000],
    );
    expect(vi.getTimerCount()).toBe(0);
  },
);

function prepareConfig(scenarioId: string, call: Parameters<typeof makeGateway>[0]) {
  const definition = readQaScenarioById(scenarioId);
  return environment(
    () => {
      throw new Error("Preparation must not use driver");
    },
    "work",
    { ...runtimeEnv, groupJid: undefined },
  ).prepareFlow({
    config: definition.execution.config ?? {},
    gateway: makeGateway(call),
    outputDir: "/qa/output",
    scenarioId,
    scenarioTitle: definition.title,
    timeoutMs: 60_000,
    waitForConfigRestartSettle: vi.fn(),
  });
}

function reactionMessages(enabled: boolean) {
  return {
    ackReaction: enabled ? "👀" : "💬",
    ackReactionScope: enabled ? "direct" : "group-mentions",
    statusReactions: { enabled },
  } satisfies OpenClawConfig["messages"];
}

it.each([
  { id: "whatsapp-agent-message-action-react", statusReactions: false },
  { id: "whatsapp-status-reaction-lifecycle", statusReactions: true },
])("configures $id through the current WhatsApp schema", async ({ id, statusReactions }) => {
  const baseMessages = reactionMessages(false);
  const account = {
    accountId: "work",
    busy: false,
    connected: true,
    lastConnectedAt: Date.now() - 30_000,
    restartPending: false,
    running: true,
  };
  const gatewayCall = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "config.get") {
      return { config: { messages: baseMessages }, hash: "config-hash" };
    }
    if (method === "config.patch") {
      const { raw, replacePaths } = _params as { raw: string; replacePaths: string[] };
      const cfg = JSON.parse(raw) as OpenClawConfig;
      const validation = validateJsonSchemaValue({
        schema: WhatsAppChannelConfigSchema.schema,
        value: cfg.channels?.whatsapp,
        applyDefaults: true,
      });
      expect(validation.ok, JSON.stringify(validation)).toBe(true);
      expect(cfg.messages).toEqual(reactionMessages(statusReactions));
      expect(replacePaths).toContain("channels.whatsapp.accounts.work.allowFrom");
      expect(replacePaths).not.toContain("channels.whatsapp.accounts.sut.allowFrom");
      return { noop: true };
    }
    if (method === "channels.status") {
      return { channelAccounts: { whatsapp: [account] } };
    }
    throw new Error(`unexpected gateway method: ${method}`);
  });
  await prepareConfig(id, gatewayCall);

  expect(gatewayCall.mock.calls.map(([method]) => method)).toContain("config.patch");
});

it("leaves generic declarative flows to their own config preparation", async () => {
  const gatewayCall = vi.fn();
  const id = "whatsapp-access-control-dm-disabled";
  const prepared = await prepareConfig(id, gatewayCall);
  expect(prepared.whatsappScenarioContext.scenario.id).toBe(id);
  expect(gatewayCall).not.toHaveBeenCalled();
});
