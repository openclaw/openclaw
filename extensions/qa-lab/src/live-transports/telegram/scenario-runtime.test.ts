import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import type { QaTransportAdapter } from "../../qa-transport.js";
import type { TelegramQaScenarioEnvironment } from "./scenario-environment.js";
import { runTelegramHelpCommandScenario } from "./scenario-runtime.js";

function createContext(): TelegramQaScenarioEnvironment {
  return {
    accountId: "sut",
    createNativeCommandInput: (command) => ({
      command,
      conversation: { id: "-100123", kind: "group" },
      senderId: "1",
      senderName: "driver_bot",
    }),
    driverIdentity: {
      id: 1,
      is_bot: true,
      first_name: "Driver",
      username: "driver_bot",
    },
    groupId: "-100123",
    scenario: { id: "telegram-help-command", timeoutMs: 60_000, title: "Telegram help" },
    sutIdentity: {
      id: 2,
      is_bot: true,
      first_name: "SUT",
      username: "openclaw_qa_bot",
    },
  };
}

describe("Telegram module scenarios", () => {
  it("executes the native command through the active transport and verifies its reply", async () => {
    const state = createQaBusState();
    const reset = vi.fn(async () => state.reset());
    const sendNativeCommand = vi.fn(async () => {
      state.addOutboundMessage({
        accountId: "sut",
        senderId: "2",
        text: "Use /new to start fresh; use /commands for full list.",
        to: "group:-100123",
      });
    });
    const transport = {
      label: "Telegram live",
      reset,
      sendNativeCommand,
      state,
      waitForOutbound: async () => state.getSnapshot().messages.at(-1),
    } as unknown as QaTransportAdapter;

    await expect(
      runTelegramHelpCommandScenario(createContext(), transport, {
        command: "help",
        expectedAny: ["/new", "/commands for full list"],
      }),
    ).resolves.toEqual({ details: "Use /new to start fresh; use /commands for full list." });
    expect(reset).toHaveBeenCalledOnce();
    expect(sendNativeCommand).toHaveBeenCalledWith({
      command: "help",
      conversation: { id: "-100123", kind: "group" },
      senderId: "1",
      senderName: "driver_bot",
    });
  });

  it("fails honestly when the active transport has no native command operation", async () => {
    const state = createQaBusState();
    const transport = {
      label: "unsupported",
      reset: vi.fn(),
      state,
      waitForOutbound: vi.fn(),
    } as unknown as QaTransportAdapter;

    await expect(
      runTelegramHelpCommandScenario(createContext(), transport, {
        command: "help",
        expectedAny: ["/new"],
      }),
    ).rejects.toThrow("does not implement native Telegram commands");
  });
});
