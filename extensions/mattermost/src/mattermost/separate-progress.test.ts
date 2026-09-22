import { createLivePreviewLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { createMattermostDraftStream } from "./draft-stream.js";
import { deliverMattermostReplyWithDraftPreview } from "./monitor-draft-delivery.js";
import type { ReplyPayload } from "./runtime-api.js";
import {
  createMattermostSeparateProgressController,
  discardMattermostSeparateProgressPending,
} from "./separate-progress.js";

function createController(params?: {
  enabled?: boolean;
  acceptedFinal?: boolean;
  retainTerminalText?: (text: string) => Promise<boolean>;
}) {
  let acceptedFinal = params?.acceptedFinal ?? false;
  const retainTerminalText = vi.fn(params?.retainTerminalText ?? (async () => true));
  const logVerboseMessage = vi.fn();
  const controller = createMattermostSeparateProgressController({
    enabled: params?.enabled ?? true,
    pinnedLabel: "Progress",
    draftStream: { retainTerminalText },
    hasAcceptedFinal: () => acceptedFinal,
    logVerboseMessage,
  });
  return {
    controller,
    retainTerminalText,
    logVerboseMessage,
    markAccepted: () => {
      acceptedFinal = true;
    },
  };
}

describe("createMattermostSeparateProgressController", () => {
  it("owns one sanitized terminal failure update across final and turn settlement", async () => {
    const { controller, retainTerminalText } = createController();

    await controller.prepareFinal(true);
    await controller.settleFinal({ outcome: "text", visibleReplySent: true }, true);
    await controller.settleTurnError();

    expect(retainTerminalText).toHaveBeenCalledExactlyOnceWith("Progress\n\nFailed.");
  });

  it("defers accepted-final truth to the core lifecycle", async () => {
    const { controller, retainTerminalText, markAccepted } = createController();

    markAccepted();
    await controller.settleFinal({ outcome: "text", visibleReplySent: true }, false);
    await controller.settleTurnError();

    expect(retainTerminalText).not.toHaveBeenCalled();
  });

  it("surfaces a missing terminal status when no visible final exists", async () => {
    const { controller } = createController({ retainTerminalText: async () => false });

    await expect(
      controller.settleFinal({ outcome: "empty", visibleReplySent: false }, false),
    ).rejects.toThrow("terminal progress was not retained");
  });

  it("retains failed progress when the real dispatcher settles a rejected final", async () => {
    const { controller, retainTerminalText } = createController();
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw new Error("final send failed");
      },
      onError: (_error, info) => {
        if (info.kind === "final") {
          controller.observeDeliveryError();
        }
      },
    });

    dispatcher.sendFinalReply({ text: "Final answer" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    await controller.settlePendingDeliveryError();

    expect(retainTerminalText).toHaveBeenCalledExactlyOnceWith("Progress\n\nFailed.");
  });

  it("leaves progress untouched when the delivery boundary suppresses a reasoning-only final", async () => {
    const { controller, retainTerminalText } = createController();
    const draft = {
      flush: vi.fn(async () => {}),
      id: vi.fn(() => "progress-post-1"),
      seal: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    const deliverPayload = vi.fn();
    const previewLifecycle = createLivePreviewLifecycle<ReplyPayload, string>({
      draft,
      retainOnError: true,
    });

    const result = await deliverMattermostReplyWithDraftPreview({
      payload: { text: "> Reasoning:\n> hidden" } as never,
      info: { kind: "final" },
      kind: "channel",
      client: {} as MattermostClient,
      previewLifecycle,
      separateProgressFinalDelivery: true,
      resolvePreviewFinalText: () => undefined,
      logVerboseMessage: vi.fn(),
      deliverPayload,
    });
    await controller.settleFinal(result, false);

    expect(result).toMatchObject({ outcome: "reasoning_skipped", visibleReplySent: false });
    expect(deliverPayload).not.toHaveBeenCalled();
    expect(draft.flush).not.toHaveBeenCalled();
    expect(draft.seal).not.toHaveBeenCalled();
    expect(draft.discardPending).not.toHaveBeenCalled();
    expect(draft.clear).not.toHaveBeenCalled();
    expect(retainTerminalText).not.toHaveBeenCalled();
  });
});

function createIncompleteReceiptDraftStream() {
  const request: MattermostClient["request"] = async <T>(path: string): Promise<T> => {
    if (path === "/posts") {
      return { message: "Working" } as T;
    }
    return {} as T;
  };
  const client: MattermostClient = {
    baseUrl: "https://mattermost.example.com",
    apiBaseUrl: "https://mattermost.example.com/api/v4",
    token: "bot-token",
    request,
    fetchImpl: vi.fn(),
  };
  return createMattermostDraftStream({ client, channelId: "channel-1", throttleMs: 0 });
}

describe("discardMattermostSeparateProgressPending", () => {
  it("isolates an accepted progress receipt failure before a separate final", async () => {
    const stream = createIncompleteReceiptDraftStream();
    const logVerboseMessage = vi.fn();
    const deliverNormally = vi.fn(async () => ({ visibleReplySent: true }));
    stream.update("Working");
    await expect(stream.flush()).rejects.toMatchObject({ code: "CHANNEL_PARTIAL_DELIVERY" });
    const lifecycle = createLivePreviewLifecycle<{ text: string }, string>({
      draft: {
        flush: stream.flush,
        id: stream.postId,
        seal: stream.seal,
        discardPending: () =>
          discardMattermostSeparateProgressPending({
            enabled: true,
            discardPending: stream.discardPending,
            logVerboseMessage,
          }),
        clear: stream.clear,
      },
      onCleanupFailure: vi.fn(),
    });

    await expect(
      lifecycle.deliver({
        kind: "final",
        payload: { text: "Final answer" },
        deliverNormally,
      }),
    ).resolves.toMatchObject({ kind: "normal-delivered" });

    expect(deliverNormally).toHaveBeenCalledExactlyOnceWith({ text: "Final answer" });
    expect(lifecycle.finalSucceeded).toBe(true);
    expect(logVerboseMessage).toHaveBeenCalledWith(
      expect.stringContaining("progress receipt incomplete before final delivery"),
    );
  });

  it("keeps the default in-place path strict", async () => {
    const stream = createIncompleteReceiptDraftStream();
    const deliverNormally = vi.fn(async () => ({ visibleReplySent: true }));
    stream.update("Working");
    await expect(stream.flush()).rejects.toMatchObject({ code: "CHANNEL_PARTIAL_DELIVERY" });
    const lifecycle = createLivePreviewLifecycle<{ text: string }, string>({
      draft: {
        flush: stream.flush,
        id: stream.postId,
        seal: stream.seal,
        discardPending: () =>
          discardMattermostSeparateProgressPending({
            enabled: false,
            discardPending: stream.discardPending,
            logVerboseMessage: vi.fn(),
          }),
        clear: stream.clear,
      },
    });

    await expect(
      lifecycle.deliver({
        kind: "final",
        payload: { text: "Final answer" },
        deliverNormally,
      }),
    ).rejects.toMatchObject({ code: "CHANNEL_PARTIAL_DELIVERY" });

    expect(deliverNormally).not.toHaveBeenCalled();
  });
});
