import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";

type PreviewPolicySocket = { emitClose: (code: number) => void };

export function registerMattermostPreviewPolicyTests<Socket extends PreviewPolicySocket>(harness: {
  FakeWebSocket: new () => Socket;
  testConfig: OpenClawConfig;
  createRuntimeCore: (config: OpenClawConfig) => unknown;
  openMonitor: (
    socket: Socket,
    abortController: AbortController,
    config?: OpenClawConfig,
  ) => Promise<{ monitor: Promise<void> }>;
  emitMattermostChannelPost: (
    socket: Socket,
    post: { id: string; message: string },
  ) => Promise<void>;
  mockState: {
    runtimeCore: unknown;
    abortController: AbortController | undefined;
    createMattermostDraftStream: Mock;
    dispatchInboundMessage: Mock;
    getGlobalHookRunner: Mock;
  };
}) {
  const {
    FakeWebSocket,
    testConfig,
    createRuntimeCore,
    openMonitor,
    emitMattermostChannelPost,
    mockState,
  } = harness;
  it("keeps core block streaming enabled when preview streaming is off", async () => {
    const offConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          ...testConfig.channels?.mattermost,
          streaming: { mode: "off", block: { enabled: true } },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(offConfig);
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;

    const { monitor } = await openMonitor(socket, abortController, offConfig);

    await emitMattermostChannelPost(socket, {
      id: "post-streaming-off",
      message: "stream this in blocks",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(mockState.createMattermostDraftStream).not.toHaveBeenCalled();
    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBe(false);
    expect(replyOptions?.preserveProgressCallbackStartOrder).toBeUndefined();
    expect(replyOptions?.suppressDefaultToolProgressMessages).toBeUndefined();
  });

  it("preserves provider previews for observer-only hooks", async () => {
    mockState.getGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => hookName === "message_sent"),
    });
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;

    const { monitor } = await openMonitor(socket, abortController);

    await emitMattermostChannelPost(socket, {
      id: "post-observer-hook-preview",
      message: "show a preview",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.createMattermostDraftStream).toHaveBeenCalledTimes(1);
    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBe(true);
    expect(replyOptions?.preserveProgressCallbackStartOrder).toBe(true);
    expect(replyOptions?.suppressDefaultToolProgressMessages).toBe(true);
  });

  it.each([
    { label: "reply_payload_sending", hooks: ["reply_payload_sending"] },
    { label: "message_sending", hooks: ["message_sending"] },
  ])("suppresses provider previews when $label is registered", async ({ hooks }) => {
    const registeredHooks = new Set(hooks);
    mockState.getGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => registeredHooks.has(hookName)),
    });
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;

    const { monitor } = await openMonitor(socket, abortController);

    await emitMattermostChannelPost(socket, {
      id: `post-${hooks.join("-")}-preview`,
      message: "do not expose this preview",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.createMattermostDraftStream).not.toHaveBeenCalled();
    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBeUndefined();
    expect(replyOptions?.preserveProgressCallbackStartOrder).toBeUndefined();
    expect(replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBeUndefined();
    expect(replyOptions?.onObservedReplyDelivery).toBeUndefined();
    expect(replyOptions?.suppressDefaultToolProgressMessages).toBeUndefined();
  });
}
