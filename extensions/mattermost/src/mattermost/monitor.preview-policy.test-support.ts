import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";

export function registerMattermostPreviewPolicyTests(harness: {
  testConfig: OpenClawConfig;
  createRuntimeCore: (config: OpenClawConfig) => unknown;
  receivePost: (post: { id: string; message: string }, config?: OpenClawConfig) => Promise<unknown>;
  mockState: {
    runtimeCore: unknown;
    abortController: AbortController | undefined;
    createMattermostDraftStream: Mock;
    dispatchInboundMessage: Mock;
    createReplyDispatcherWithTyping: Mock;
    sendMessageMattermost: Mock;
    getGlobalHookRunner: Mock;
  };
}) {
  const { testConfig, createRuntimeCore, receivePost, mockState } = harness;
  it("keeps core block streaming enabled when preview streaming is off", async () => {
    const config: OpenClawConfig = {
      channels: {
        mattermost: {
          ...testConfig.channels?.mattermost,
          streaming: { mode: "off", block: { enabled: true } },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(config);
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      await params.replyOptions?.onPartialReply?.({ text: "Partial answer" });
      await params.replyOptions?.onReasoningEnd?.();
      await params.replyOptions?.onReasoningStream?.({ text: "Private reasoning" });
      const dispatcherOptions =
        mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
      await dispatcherOptions?.deliver({ text: "Complete answer" }, { kind: "final" });
      mockState.abortController?.abort();
    });
    await receivePost({ id: "post-streaming-off", message: "stream this in blocks" }, config);
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(mockState.createMattermostDraftStream).not.toHaveBeenCalled();
    expect(mockState.sendMessageMattermost).toHaveBeenCalledExactlyOnceWith(
      "channel:chan-1",
      "Complete answer",
      expect.objectContaining({ accountId: "default" }),
    );
    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBe(false);
    expect(replyOptions?.preserveProgressCallbackStartOrder).toBeUndefined();
    expect(replyOptions?.suppressDefaultToolProgressMessages).toBeUndefined();
  });

  it.each(["message_sent", "reply_payload_sending", "message_sending"])(
    "only allows provider previews for observer-only hooks: %s",
    async (hook) => {
      mockState.getGlobalHookRunner.mockReturnValue({
        hasHooks: vi.fn((name: string) => name === hook),
      });
      await receivePost({ id: `post-${hook}`, message: "show only authorized previews" });
      const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
      if (hook === "message_sent") {
        expect(mockState.createMattermostDraftStream).toHaveBeenCalledTimes(1);
        expect(replyOptions?.disableBlockStreaming).toBe(true);
        expect(replyOptions?.preserveProgressCallbackStartOrder).toBe(true);
        expect(replyOptions?.suppressDefaultToolProgressMessages).toBe(true);
      } else {
        expect(mockState.createMattermostDraftStream).not.toHaveBeenCalled();
        expect(replyOptions?.disableBlockStreaming).toBeUndefined();
        expect(replyOptions?.preserveProgressCallbackStartOrder).toBeUndefined();
        expect(replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBeUndefined();
        expect(replyOptions?.onObservedReplyDelivery).toBeUndefined();
        expect(replyOptions?.suppressDefaultToolProgressMessages).toBeUndefined();
      }
    },
  );
}
