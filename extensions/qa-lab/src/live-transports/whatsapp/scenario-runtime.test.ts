import { expectDefined } from "@openclaw/normalization-core";
import type { WhatsAppQaDriverObservedMessage } from "@openclaw/whatsapp/api.js";
import { WhatsAppChannelConfigSchema } from "@openclaw/whatsapp/channel-config-api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { createDriver, observedMessage, runtimeEnv, groupJid } from "./runtime.test-support.js";
import { runWhatsAppScenario } from "./scenario-runtime.js";
import {
  environment,
  gateway as makeGateway,
  scenario as getScenario,
} from "./scenario.test-support.js";

const readyAccount = (accountId: string, lastConnectedAt = Date.now() - 30_000) => ({
  accountId,
  lastConnectedAt,
  connected: true,
  running: true,
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("targets group approval reactions at the approval prompt participant", async () => {
  const implementation = getScenario("whatsapp-approval-exec-group-reaction-native");
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
          ? `Exec approval required\nID: ${approvalId}\n${run.token}\nReact with: 👍`
          : `✅ Exec approval allow-once. ID: ${approvalId}`,
      });
      expect(match(message)).toBe(true);
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
    scenario: implementation,
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
  "observes the complete $scenarioId quiet window (fault: $fault)",
  async ({ scenarioId, quietMs, fault }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const startedAt = Date.now();
    const implementation = getScenario(scenarioId);
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
        if (scenarioId === "whatsapp-mention-gating" && sends.length === 2) {
          expect(text).toMatch(/^openclawqa\b/);
        }
        inputText = text;
        targetJid = target;
        if (scenarioId.endsWith("action-react")) {
          messages.push(
            observedMessage("reaction", {
              kind: "reaction",
              fromJid: target,
              observedAt: new Date(Date.now() + 1).toISOString(),
              text: "",
              reaction: { emoji: "👍", messageId: "qa-inbound" },
            }),
          );
        }
        return { messageId: "qa-inbound" };
      },
      waitForMessage: async ({ match }) => {
        const reply =
          messages.find(match) ??
          observedMessage("reply", {
            fromJid: targetJid,
            observedAt: new Date(Date.now() + 1).toISOString(),
            text: inputText,
          });
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
    const result = runWhatsAppScenario({
      preparedScenario: { implementation, run: implementation.buildRun() },
      getDriver: () => driver,
      driverAuthDir: "/qa/driver",
      replaceDriver: async () => {},
      runtimeEnv,
      sutAccountId: "sut",
      scenario: implementation,
      gateway: makeGateway(async (method) => {
        if (method === "channels.status") {
          return { channelAccounts: { whatsapp: [readyAccount("sut", startedAt - 30_000)] } };
        }
        throw new Error(`unexpected Gateway method: ${method}`);
      }),
    });
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void result.then(markSettled, markSettled);
    const outcome =
      fault === "none"
        ? expect(result).resolves.toHaveProperty("details")
        : expect(result).rejects.toThrow("unexpected WhatsApp reply observed in quiet scenario");
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
    await outcome;
    expect(observations).toEqual([quietMs]);
    expect(sends).toEqual(
      scenarioId === "whatsapp-mention-gating" && fault === "none" ? [0, 5_000] : [0],
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
  vi.useFakeTimers();
  const connectedAt = Date.now();
  const baseMessages = reactionMessages(false);
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
      return { channelAccounts: { whatsapp: [readyAccount("work", connectedAt)] } };
    }
    throw new Error(`unexpected gateway method: ${method}`);
  });
  const prepared = prepareConfig(id, gatewayCall);
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(20_000);
  await prepared;

  expect(gatewayCall.mock.calls.map(([method]) => method)).toContain("config.patch");
});

it("leaves generic declarative flows to their own config preparation", async () => {
  const gatewayCall = vi.fn();
  const id = "whatsapp-access-control-dm-disabled";
  const prepared = await prepareConfig(id, gatewayCall);
  expect(prepared.whatsappScenarioContext.scenario.id).toBe(id);
  expect(gatewayCall).not.toHaveBeenCalled();
});
