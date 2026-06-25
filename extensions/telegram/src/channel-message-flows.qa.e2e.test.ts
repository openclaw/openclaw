// Channel Message Flows tests cover QA Lab channel delivery evidence.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  resolveTelegramFlowThreadSpec,
  runTelegramThinkingFinalFlow,
  runTelegramWorkingFinalFlow,
} from "./test-support/channel-message-flows.js";

describe("channel message flows QA e2e", () => {
  function createTestDraftStream(params?: {
    update?: (text: string) => void;
    flush?: () => Promise<void>;
    clear?: () => Promise<void>;
  }) {
    return {
      update: vi.fn(params?.update ?? (() => {})),
      updatePreview: vi.fn(),
      flush: vi.fn(params?.flush ?? (async () => {})),
      clear: vi.fn(params?.clear ?? (async () => {})),
      stop: vi.fn(async () => {}),
      messageId: vi.fn(() => 17),
      forceNewMessage: vi.fn(),
    };
  }

  it("streams thinking updates, clears the preview, then sends the final answer", async () => {
    const events: string[] = [];
    const stream = {
      update: vi.fn((text: string) => {
        events.push(`update:${text}`);
      }),
      flush: vi.fn(async () => {
        events.push("flush");
      }),
      clear: vi.fn(async () => {
        events.push("clear");
      }),
      updatePreview: vi.fn(),
      stop: vi.fn(async () => {}),
      messageId: vi.fn(() => 17),
      forceNewMessage: vi.fn(),
    };
    const sendFinal = vi.fn(async () => {
      events.push("final");
      return { messageId: "99", chatId: "123" };
    });

    const result = await runTelegramThinkingFinalFlow(
      {
        accountId: "sut",
        cfg: {} as OpenClawConfig,
        delayMs: 0,
        target: "123",
        threadId: 42,
        thinkingUpdates: ["Checking the request.", "Reading the Telegram code.", "Ready."],
      },
      {
        createDraftStream: vi.fn(() => stream),
        sendFinal,
        sleep: vi.fn(async () => {}),
      },
    );

    expect(stream.update).toHaveBeenCalledTimes(3);
    expect(stream.update.mock.calls[0]?.[0]).toContain("Thinking");
    expect(stream.update.mock.calls[0]?.[0]).toContain("_Checking the request._");
    expect(events.at(-2)).toBe("clear");
    expect(events.at(-1)).toBe("final");
    expect(sendFinal).toHaveBeenCalledWith({
      accountId: "sut",
      cfg: {},
      target: "123",
      text: "Final answer: the Telegram thinking preview cleared and this durable reply landed.",
      threadId: 42,
    });
    expect(result).toEqual({ finalMessageId: "99", previewUpdates: 3 });
  });

  it("clears thinking previews when streaming fails before the final answer", async () => {
    const stream = {
      update: vi.fn(() => {}),
      flush: vi.fn(async () => {
        throw new Error("flush failed");
      }),
      clear: vi.fn(async () => {}),
      updatePreview: vi.fn(),
      stop: vi.fn(async () => {}),
      messageId: vi.fn(() => 17),
      forceNewMessage: vi.fn(),
    };
    const sendFinal = vi.fn(async () => ({ messageId: "99", chatId: "123" }));

    await expect(
      runTelegramThinkingFinalFlow(
        {
          cfg: {} as OpenClawConfig,
          delayMs: 0,
          target: "123",
          thinkingUpdates: ["Checking the request."],
        },
        {
          createDraftStream: vi.fn(() => stream),
          sendFinal,
          sleep: vi.fn(async () => {}),
        },
      ),
    ).rejects.toThrow("flush failed");

    expect(stream.clear).toHaveBeenCalledOnce();
    expect(sendFinal).not.toHaveBeenCalled();
  });

  it("fails thinking-final when the final send does not return a message id", async () => {
    const stream = {
      update: vi.fn(() => {}),
      flush: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      updatePreview: vi.fn(),
      stop: vi.fn(async () => {}),
      messageId: vi.fn(() => 17),
      forceNewMessage: vi.fn(),
    };

    await expect(
      runTelegramThinkingFinalFlow(
        {
          cfg: {} as OpenClawConfig,
          delayMs: 0,
          target: "123",
          thinkingUpdates: ["Checking the request."],
        },
        {
          createDraftStream: vi.fn(() => stream),
          sendFinal: vi.fn(async () => ({})),
          sleep: vi.fn(async () => {}),
        },
      ),
    ).rejects.toThrow("thinking-final final send did not return a durable Telegram message id");
  });

  it("streams working updates through rich message drafts before the final answer", async () => {
    const stream = createTestDraftStream();
    const sendFinal = vi.fn(async () => ({ messageId: "100", chatId: "123" }));

    const result = await runTelegramWorkingFinalFlow(
      {
        cfg: {} as OpenClawConfig,
        delayMs: 0,
        durationMs: 12_000,
        target: "123",
      },
      {
        createDraftStream: vi.fn(() => stream),
        sendFinal,
        sleep: vi.fn(async () => {}),
      },
    );

    expect(stream.update).toHaveBeenNthCalledWith(1, "Working");
    expect(stream.update.mock.calls[2]?.[0]).toContain("🛠️ pgrep -fl Discord || true (agent)");
    expect(stream.update.mock.calls[2]?.[0]).toContain(
      "🛠️ list files in /Applications/Discord.app -> run true (agent)",
    );
    expect(stream.update.mock.calls[4]?.[0]).toContain(
      "• Discord is installed as a normal '/Applications/Discord.app'",
    );
    expect(stream.update).toHaveBeenCalledWith(
      expect.stringContaining("Working\n\n🛠️ pgrep -fl Discord || true (agent)"),
    );
    expect(stream.clear).toHaveBeenCalledBefore(sendFinal);
    expect(sendFinal).toHaveBeenCalledWith({
      accountId: undefined,
      cfg: {},
      target: "123",
      text: "Final answer: the Telegram working preview cleared and this durable reply landed.",
      threadId: undefined,
    });
    expect(stream.update).not.toHaveBeenCalledWith(expect.stringContaining("Working for"));
    expect(result).toEqual({ finalMessageId: "100", previewUpdates: 6 });
  });

  it("clears rich working drafts when progress updates fail before the final answer", async () => {
    const stream = createTestDraftStream({
      update: () => {
        throw new Error("draft update failed");
      },
    });
    const sendFinal = vi.fn(async () => ({ messageId: "100", chatId: "123" }));

    await expect(
      runTelegramWorkingFinalFlow(
        {
          cfg: {} as OpenClawConfig,
          delayMs: 0,
          durationMs: 12_000,
          target: "123",
        },
        {
          createDraftStream: vi.fn(() => stream),
          sendFinal,
          sleep: vi.fn(async () => {}),
        },
      ),
    ).rejects.toThrow("draft update failed");

    expect(stream.clear).toHaveBeenCalledOnce();
    expect(sendFinal).not.toHaveBeenCalled();
  });

  it("fails working-final when the final send does not return a message id", async () => {
    const stream = createTestDraftStream();

    await expect(
      runTelegramWorkingFinalFlow(
        {
          cfg: {} as OpenClawConfig,
          delayMs: 0,
          durationMs: 12_000,
          target: "123",
        },
        {
          createDraftStream: vi.fn(() => stream),
          sendFinal: vi.fn(async () => ({})),
          sleep: vi.fn(async () => {}),
        },
      ),
    ).rejects.toThrow("working-final final send did not return a durable Telegram message id");
  });

  it("uses two second progress update cadence by default", async () => {
    const stream = createTestDraftStream();
    const sleep = vi.fn(async () => {});

    const result = await runTelegramWorkingFinalFlow(
      {
        cfg: {} as OpenClawConfig,
        durationMs: 20_000,
        target: "123",
      },
      {
        createDraftStream: vi.fn(() => stream),
        sendFinal: vi.fn(async () => ({ messageId: "101", chatId: "123" })),
        sleep,
      },
    );

    expect(sleep).toHaveBeenCalledTimes(9);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(result.previewUpdates).toBe(7);
  });

  it("maps flow thread ids to Telegram forum topic specs", () => {
    expect(resolveTelegramFlowThreadSpec(42)).toEqual({ id: 42, scope: "forum" });
    expect(resolveTelegramFlowThreadSpec()).toBeUndefined();
  });
});
