import { syncBuiltinESMExports } from "node:module";
import timersPromises from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createTelegramNativeMessageLedger } from "./live-transports/telegram/native-message-ledger.js";
import type { TelegramUserbotUpdate } from "./live-transports/telegram/userbot-driver.runtime.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

async function runRecoveryFlow(
  options: {
    initiallyRecovered?: boolean;
    duplicate?: boolean;
    duplicateFallback?: boolean;
    /** Live Telegram sends the no-partial failure fallback without a reply target. */
    threadedFallback?: boolean;
    replacement?: boolean;
    delayTerminal?: boolean;
    /** Crabline-style drivers expose bus outbound messages without a native reader. */
    busOnly?: boolean;
  } = {},
) {
  const state = createQaBusState();
  const marker = "TELEGRAM-VISIBLE-PARTIAL-BEFORE-FAILURE";
  const terminal = `${marker}\n\n⚠️ Synthetic provider request failed.`;
  let currentId = "";
  let nextId = 10;
  const chatId = -100123;
  // The real native ledger owns current-inbound correlation for the live reader.
  const ledger = createTelegramNativeMessageLedger();
  const messages = new Map<string, Array<{ update: TelegramUserbotUpdate; busId: string }>>();
  const polls = new Map<string, number>();
  const gatewayCall = vi.fn(async () => {
    const count = (polls.get(currentId) ?? 0) + 1;
    polls.set(currentId, count);
    if (options.delayTerminal && count < 3) {
      return { sessions: count === 1 ? [] : [{ key: "session-under-test", hasActiveRun: true }] };
    }
    const rows = messages.get(currentId)!;
    const row = rows[0]!;
    const text = row.update.text.includes(marker)
      ? terminal
      : "⚠️ Synthetic provider request failed.";
    if (options.replacement) {
      const update = { ...row.update, messageId: 999, text };
      const busId = state.addOutboundMessage({
        to: "group:telegram-partial-failure-room",
        text,
      }).id;
      ledger.record(busId, { observer: 0, chatId, messageId: 999 }, update);
      rows[0] = { update, busId };
    } else {
      const update = { ...row.update, kind: "edit" as const, text };
      state.editMessage({ messageId: row.busId, text });
      ledger.edit(ledger.bus(0, chatId, row.update.messageId)!, update);
      rows[0] = { ...row, update };
    }
    return { sessions: [{ key: "session-under-test", hasActiveRun: false }] };
  });
  const transport = {
    accountId: "sut",
    waitForOutbound: async () =>
      state.getSnapshot().messages.find((message) => message.direction === "outbound"),
    buildAgentDelivery: () => ({ channel: "telegram", replyTo: "-100123" }),
    reset: async () => {
      state.reset();
      ledger.reset();
      messages.clear();
    },
    sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) => {
      const inbound = state.addInboundMessage(input);
      currentId = inbound.id;
      const partialCase = input.text.includes("visible partial");
      const text = partialCase
        ? options.initiallyRecovered
          ? terminal
          : marker
        : "⚠️ Synthetic provider request failed.";
      const inboundMessageId = nextId++;
      ledger.record(inbound.id, { observer: 0, chatId, messageId: inboundMessageId });
      const threaded = partialCase || options.threadedFallback === true;
      const count = (partialCase ? options.duplicate : options.duplicateFallback) ? 2 : 1;
      const rows = Array.from({ length: count }, () => {
        const update: TelegramUserbotUpdate = {
          kind: "message",
          chatId,
          messageId: nextId++,
          senderId: 200,
          timestamp: 0,
          text,
          entities: [],
          ...(threaded ? { replyToMessageId: inboundMessageId } : {}),
        };
        const busId = state.addOutboundMessage({
          to: "group:telegram-partial-failure-room",
          text,
          ...(threaded ? { replyToId: inbound.id } : {}),
        }).id;
        ledger.record(busId, { observer: 0, chatId, messageId: update.messageId }, update);
        return { update, busId };
      });
      messages.set(inbound.id, rows);
      return inbound;
    },
  };
  const pending = runLoadedScenarioFlow("telegram-partial-failure-recovery", {
    state,
    api: {
      transport,
      env: { providerMode: "mock-openai", cfg: {}, gateway: { call: gatewayCall } },
      getTransportSnapshot: () => state.getSnapshot(),
      buildAgentSessionKey: () => "session-under-test",
      ...(options.busOnly
        ? {}
        : {
            readTelegramMessages: (id: string) => ledger.readUpdates(id),
          }),
      waitForCondition: (check: () => unknown) =>
        waitForQaTransportCondition(
          check,
          1_000,
          100,
          () => "correlated terminal observation was not met",
        ),
    },
  });
  // Poll sleeps and the deadline run on the fake clock, so worker pauses cannot exhaust it.
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  await vi.runAllTimersAsync();
  await settled;
  return { result: await pending, gatewayCall };
}

describe("Telegram recovery scenario native observations", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.spyOn(timersPromises, "setTimeout").mockImplementation(promisify(setTimeout));
    syncBuiltinESMExports();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    syncBuiltinESMExports();
  });

  it("accepts an initially recovered message without requiring a second edit", async () => {
    const { result, gatewayCall } = await runRecoveryFlow({ initiallyRecovered: true });
    expect(result.status).toBe("pass");
    expect(gatewayCall).toHaveBeenCalledTimes(2);
  });

  it("awaits terminal recovery on the original native message", async () => {
    const { result } = await runRecoveryFlow();
    expect(result.status).toBe("pass");
  });

  it.each([false, true])(
    "waits for a missing then active session to settle (already recovered: %s)",
    async (initiallyRecovered) => {
      const { result, gatewayCall } = await runRecoveryFlow({
        initiallyRecovered,
        delayTerminal: true,
      });
      expect(result.status).toBe("pass");
      expect(gatewayCall).toHaveBeenCalledTimes(6);
    },
  );

  it.each([false, true])(
    "accepts one fallback for the current inbound (threaded by Telegram: %s)",
    async (threadedFallback) => {
      const { result } = await runRecoveryFlow({ threadedFallback });
      expect(result.status).toBe("pass");
    },
  );

  it("rejects two unthreaded fallbacks for the current inbound", async () => {
    await expect(runRecoveryFlow({ duplicateFallback: true })).rejects.toThrow(
      "expected one correlated Telegram fallback",
    );
  });

  it("rejects two native replies even when both contain recovery text", async () => {
    await expect(runRecoveryFlow({ initiallyRecovered: true, duplicate: true })).rejects.toThrow(
      "expected one correlated Telegram recovery",
    );
  });

  it("rejects recovery that replaces the partial with another native identity", async () => {
    await expect(runRecoveryFlow({ replacement: true })).rejects.toThrow(
      "correlated terminal observation was not met",
    );
  });

  it.each([false, true])(
    "qualifies bus-only drivers without a native reader (already recovered: %s)",
    async (initiallyRecovered) => {
      const { result } = await runRecoveryFlow({ busOnly: true, initiallyRecovered });
      expect(result.status).toBe("pass");
    },
  );

  it("rejects duplicate and replaced recoveries on bus-only drivers", async () => {
    await expect(
      runRecoveryFlow({ busOnly: true, initiallyRecovered: true, duplicate: true }),
    ).rejects.toThrow("expected one correlated Telegram recovery");
    await expect(runRecoveryFlow({ busOnly: true, replacement: true })).rejects.toThrow(
      "correlated terminal observation was not met",
    );
  });
});
