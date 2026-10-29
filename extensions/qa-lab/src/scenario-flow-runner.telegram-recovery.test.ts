import { syncBuiltinESMExports } from "node:module";
import timersPromises from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

async function runRecoveryFlow(
  options: {
    initiallyRecovered?: boolean;
    duplicate?: boolean;
    replacement?: boolean;
    delayTerminal?: boolean;
  } = {},
) {
  const state = createQaBusState();
  const marker = "TELEGRAM-VISIBLE-PARTIAL-BEFORE-FAILURE";
  const terminal = `${marker}\n\nSynthetic provider request failed.`;
  let currentId = "";
  let nextId = 10;
  const messages = new Map<string, Array<{ chatId: number; messageId: number; text: string }>>();
  const polls = new Map<string, number>();
  const gatewayCall = vi.fn(async () => {
    const count = (polls.get(currentId) ?? 0) + 1;
    polls.set(currentId, count);
    if (options.delayTerminal && count < 3) {
      return { sessions: count === 1 ? [] : [{ key: "session-under-test", hasActiveRun: true }] };
    }
    const rows = messages.get(currentId)!;
    rows[0] = {
      ...rows[0]!,
      ...(options.replacement ? { messageId: 999 } : {}),
      text: rows[0]!.text.includes(marker) ? terminal : "Synthetic provider request failed.",
    };
    return { sessions: [{ key: "session-under-test", hasActiveRun: false }] };
  });
  const transport = {
    accountId: "sut",
    waitForOutbound: async () =>
      state.getSnapshot().messages.find((message) => message.direction === "outbound"),
    buildAgentDelivery: () => ({ channel: "telegram", replyTo: "-100123" }),
    reset: async () => {
      state.reset();
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
        : "Synthetic provider request failed.";
      const rows = [{ chatId: -100123, messageId: nextId++, text }];
      if (options.duplicate && partialCase) {
        rows.push({ ...rows[0]!, messageId: nextId++ });
      }
      messages.set(inbound.id, rows);
      for (const row of rows) {
        state.addOutboundMessage({
          to: "group:telegram-partial-failure-room",
          text: row.text,
          replyToId: inbound.id,
        });
      }
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
      readTelegramMessages: (id: string) => structuredClone(messages.get(id) ?? []),
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

  it("rejects two native replies even when both contain recovery text", async () => {
    await expect(runRecoveryFlow({ initiallyRecovered: true, duplicate: true })).rejects.toThrow(
      "expected one correlated native Telegram recovery",
    );
  });

  it("rejects recovery that replaces the partial with another native identity", async () => {
    await expect(runRecoveryFlow({ replacement: true })).rejects.toThrow(
      "correlated terminal observation was not met",
    );
  });
});
