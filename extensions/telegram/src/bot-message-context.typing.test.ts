// Telegram tests cover bot message context.typing plugin behavior.
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import type { TelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";

const transcribeFirstAudio = vi.hoisted(() => vi.fn(async () => "voice transcript"));

vi.mock("./media-understanding.runtime.js", () => ({
  transcribeFirstAudio,
}));

function createSendChatActionHandler(
  sendChatAction = vi.fn(async () => undefined),
): TelegramSendChatActionHandler & { sendChatAction: typeof sendChatAction } {
  return {
    sendChatAction,
    isSuspended: () => false,
    reset: () => undefined,
  };
}

async function waitForSendChatActionCall(sendChatAction: ReturnType<typeof vi.fn>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (sendChatAction.mock.calls.length > 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

describe("buildTelegramMessageContext typing", () => {
  it("sends direct typing after body resolution and before session context construction", async () => {
    const buildInboundContext = vi.fn(
      (params: Parameters<typeof buildChannelInboundEventContext>[0]) =>
        buildChannelInboundEventContext(params as never),
    );
    const sendChatActionHandler = createSendChatActionHandler();

    await expect(
      buildTelegramMessageContextForTest({
        message: {
          chat: { id: 42, type: "private", first_name: "Pat" },
          from: { id: 42, first_name: "Pat" },
          text: "hello",
        },
        sendChatActionHandler,
        sessionRuntime: {
          buildChannelInboundEventContext:
            buildInboundContext as unknown as typeof buildChannelInboundEventContext,
        },
      }),
    ).resolves.not.toBeNull();

    expect(sendChatActionHandler.sendChatAction).toHaveBeenCalledWith(42, "typing", undefined);
    expect(sendChatActionHandler.sendChatAction.mock.invocationCallOrder[0]).toBeLessThan(
      buildInboundContext.mock.invocationCallOrder[0],
    );
  });

  it("sends direct typing before voice transcription starts", async () => {
    transcribeFirstAudio.mockClear();
    let resolveSendChatAction!: () => void;
    const sendChatAction = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          resolveSendChatAction = () => resolve(undefined);
        }),
    );
    const sendChatActionHandler = createSendChatActionHandler(sendChatAction);

    const contextPromise = buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Pat" },
        from: { id: 42, first_name: "Pat" },
        text: undefined,
        voice: { file_id: "voice-1", duration: 1 },
      },
      allMedia: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }],
      sendChatActionHandler,
    });

    await waitForSendChatActionCall(sendChatActionHandler.sendChatAction);

    expect(sendChatActionHandler.sendChatAction).toHaveBeenCalledTimes(1);
    expect(sendChatActionHandler.sendChatAction).toHaveBeenCalledWith(42, "typing", undefined);
    expect(transcribeFirstAudio).not.toHaveBeenCalled();

    resolveSendChatAction();

    await expect(contextPromise).resolves.not.toBeNull();
    expect(transcribeFirstAudio).toHaveBeenCalledTimes(1);
    expect(sendChatActionHandler.sendChatAction.mock.invocationCallOrder[0]).toBeLessThan(
      transcribeFirstAudio.mock.invocationCallOrder[0],
    );
  });

  it("continues voice transcription when preflight typing does not settle", async () => {
    transcribeFirstAudio.mockClear();
    const sendChatAction = vi.fn(
      () =>
        new Promise<undefined>(() => {
          // Intentionally left pending to exercise the bounded preflight wait.
        }),
    );
    const sendChatActionHandler = createSendChatActionHandler(sendChatAction);

    const contextPromise = buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Pat" },
        from: { id: 42, first_name: "Pat" },
        text: undefined,
        voice: { file_id: "voice-1", duration: 1 },
      },
      allMedia: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }],
      sendChatActionHandler,
    });

    await waitForSendChatActionCall(sendChatActionHandler.sendChatAction);

    expect(sendChatActionHandler.sendChatAction).toHaveBeenCalledWith(42, "typing", undefined);
    expect(transcribeFirstAudio).not.toHaveBeenCalled();

    await expect(contextPromise).resolves.not.toBeNull();
    expect(transcribeFirstAudio).toHaveBeenCalledTimes(1);
    expect(sendChatActionHandler.sendChatAction.mock.invocationCallOrder[0]).toBeLessThan(
      transcribeFirstAudio.mock.invocationCallOrder[0],
    );
  });

  it("does not send direct typing when there is no replyable body", async () => {
    const sendChatActionHandler = createSendChatActionHandler();

    await expect(
      buildTelegramMessageContextForTest({
        message: {
          chat: { id: 42, type: "private", first_name: "Pat" },
          from: { id: 42, first_name: "Pat" },
          text: undefined,
        },
        sendChatActionHandler,
      }),
    ).resolves.toBeNull();

    expect(sendChatActionHandler.sendChatAction).not.toHaveBeenCalled();
  });

  it("does not send early direct typing before DM access passes", async () => {
    const sendChatActionHandler = createSendChatActionHandler();

    await expect(
      buildTelegramMessageContextForTest({
        message: {
          chat: { id: 42, type: "private", first_name: "Pat" },
          from: { id: 42, first_name: "Pat" },
          text: "hello",
        },
        cfg: {
          agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
          channels: { telegram: { dmPolicy: "disabled", allowFrom: [] } },
          messages: { groupChat: { mentionPatterns: [] } },
        },
        dmPolicy: "disabled",
        sendChatActionHandler,
      }),
    ).resolves.toBeNull();

    expect(sendChatActionHandler.sendChatAction).not.toHaveBeenCalled();
  });
});
