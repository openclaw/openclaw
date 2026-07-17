import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./monitor.inbound-system-event.test-helper.js";
import {
  createRuntimeCore,
  emitMattermostChannelPost,
  emitMattermostEditedPost,
  getMattermostInboundTestState,
  mentionConfig,
  resetMattermostInboundTestState,
  testRuntime,
} from "./monitor.inbound-system-event.test-support.js";
// Load the shared mocks before importing the monitor under test.
import { monitorMattermostProvider } from "./monitor.js";

const mockState = getMattermostInboundTestState();

describe("mattermost edited mention transitions", () => {
  beforeEach(resetMattermostInboundTestState);

  it("dispatches an edit that adds a bot mention while keeping the canonical message id", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.runtimeCore = createRuntimeCore(mentionConfig);

    const monitor = monitorMattermostProvider({
      config: mentionConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-lone-edit",
      message: "not addressed to the bot",
    });
    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();

    await socket.emitMessage({
      event: "post_edited",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-lone-edit",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "@openclaw edited wake",
          create_at: 1_714_000_000_000,
          edit_at: 1_714_000_000_125,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("edited wake");
    expect(ctx?.MessageSid).toBe("post-lone-edit");
    expect(ctx?.MessageSids).toBeUndefined();
  });

  it("does not dispatch an edited post without a bot mention", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.runtimeCore = createRuntimeCore(mentionConfig);

    const monitor = monitorMattermostProvider({
      config: mentionConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "post_edited",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-edit-no-mention",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "still not addressed to the bot",
          create_at: 1_714_000_000_000,
          edit_at: 1_714_000_000_125,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it("does not wake again when an edited post already mentioned the bot", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.runtimeCore = createRuntimeCore(mentionConfig);

    const monitor = monitorMattermostProvider({
      config: mentionConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-existing-mention",
      message: "@openclaw original wake",
    });
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);

    await emitMattermostEditedPost(socket, {
      id: "post-existing-mention",
      message: "@openclaw reformatted original wake",
      editAt: 1_714_000_000_125,
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("does not wake for an attachment or metadata-only edit", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.runtimeCore = createRuntimeCore(mentionConfig);

    const monitor = monitorMattermostProvider({
      config: mentionConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-metadata-edit",
      message: "@openclaw original wake",
    });
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);

    await emitMattermostEditedPost(socket, {
      id: "post-metadata-edit",
      message: "@openclaw original wake",
      editAt: 1_714_000_000_125,
      fileIds: ["file-1"],
      props: { attachments: [{ text: "updated" }] },
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("does not wake for an edit that adds a different bot mention", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.runtimeCore = createRuntimeCore(mentionConfig);

    const monitor = monitorMattermostProvider({
      config: mentionConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-other-bot",
      message: "not addressed to a bot",
    });
    await emitMattermostEditedPost(socket, {
      id: "post-other-bot",
      message: "@otherbot edited wake",
      editAt: 1_714_000_000_125,
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it("fails closed when an edited mention changes the observed sender identity", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.runtimeCore = createRuntimeCore(mentionConfig);

    const monitor = monitorMattermostProvider({
      config: mentionConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-sender-change",
      message: "not addressed to the bot",
    });
    await emitMattermostEditedPost(socket, {
      id: "post-sender-change",
      message: "@openclaw forged edit",
      editAt: 1_714_000_000_125,
      userId: "user-2",
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it("ignores malformed and partial edited-post events", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.runtimeCore = createRuntimeCore(mentionConfig);

    const monitor = monitorMattermostProvider({
      config: mentionConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({ event: "post_edited", data: {} });
    await socket.emitMessage({
      event: "post_edited",
      data: {
        channel_id: "chan-1",
        post: JSON.stringify({
          channel_id: "chan-1",
          user_id: "user-1",
          message: "@openclaw missing post id",
        }),
      },
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it("deduplicates repeated edited-post events", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.runtimeCore = createRuntimeCore(mentionConfig);
    mockState.dispatchInboundMessage.mockResolvedValue(undefined);

    const monitor = monitorMattermostProvider({
      config: mentionConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-edit-duplicate",
      message: "not addressed to the bot",
    });
    const editedEvent = {
      event: "post_edited",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-edit-duplicate",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "@openclaw edited wake",
          create_at: 1_714_000_000_000,
          edit_at: 1_714_000_000_125,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    };
    await socket.emitMessage(editedEvent);
    await socket.emitMessage(editedEvent);
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });
});
