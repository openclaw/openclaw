import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./monitor.inbound-system-event.test-helper.js";
import {
  createRuntimeCore,
  emitMattermostChannelPost,
  emitMattermostEditedPost,
  getMattermostInboundTestState,
  mentionConfig,
  resetMattermostInboundTestState,
  testConfig,
  testRuntime,
} from "./monitor.inbound-system-event.test-support.js";
// Load the shared mocks before importing the monitor under test.
import { monitorMattermostProvider } from "./monitor.js";
import type { OpenClawConfig } from "./runtime-api.js";

const mockState = getMattermostInboundTestState();

describe("mattermost edited post debounce", () => {
  beforeEach(resetMattermostInboundTestState);

  it("serializes an immediate edit behind the original post snapshot", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.runtimeCore = createRuntimeCore(mentionConfig, undefined, {
      createInboundDebouncer,
    });

    let markFirstLookupEntered!: () => void;
    const firstLookupEntered = new Promise<void>((resolve) => {
      markFirstLookupEntered = resolve;
    });
    let releaseFirstLookup!: () => void;
    const firstLookupGate = new Promise<void>((resolve) => {
      releaseFirstLookup = resolve;
    });
    let lookupCount = 0;
    mockState.resolveChannelInfo.mockImplementation(async () => {
      lookupCount += 1;
      if (lookupCount === 1) {
        markFirstLookupEntered();
        await firstLookupGate;
      }
      return {
        id: "chan-1",
        name: "town-square",
        display_name: "Town Square",
        team_id: "team-1",
        type: "O",
      };
    });

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

    const originalPending = emitMattermostChannelPost(socket, {
      id: "post-immediate-edit",
      message: "not addressed to the bot",
    });
    await firstLookupEntered;

    const editPending = emitMattermostEditedPost(socket, {
      id: "post-immediate-edit",
      message: "@openclaw edited wake",
      editAt: 1_714_000_000_125,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const lookupsBeforeRelease = mockState.resolveChannelInfo.mock.calls.length;

    releaseFirstLookup();
    await Promise.all([originalPending, editPending]);
    socket.emitClose(1000);
    await monitor;

    expect(lookupsBeforeRelease).toBe(1);
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("edited wake");
    expect(ctx?.MessageSid).toBe("post-immediate-edit");
  });

  it("flushes a pending ordinary post before evaluating its edit", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const debounceConfig: OpenClawConfig = {
      ...testConfig,
      messages: { inbound: { debounceMs: 5 } },
    };
    const runtimeCore = createRuntimeCore(debounceConfig, undefined, {
      inboundDebounceMs: 5,
      createInboundDebouncer,
    });
    mockState.runtimeCore = runtimeCore;

    const monitor = monitorMattermostProvider({
      config: debounceConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-edited",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "stale pre-edit text",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    await socket.emitMessage({
      event: "post_edited",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-edited",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "latest edited text",
          create_at: 1_714_000_000_000,
          edit_at: 1_714_000_000_050,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });

    await vi.waitFor(() => {
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    });
    socket.emitClose(1000);
    await monitor;

    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("stale pre-edit text");
    expect(ctx?.Body).toContain("stale pre-edit text");
    expect(ctx?.Body).not.toContain("latest edited text");
    expect(ctx?.MessageSid).toBe("post-edited");
    expect(ctx?.MessageSids).toBeUndefined();
    expect(ctx?.MessageSidFirst).toBeUndefined();
    expect(ctx?.MessageSidLast).toBeUndefined();
  });

  it("does not merge a rejected edit into an ordinary debounce batch", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const debounceConfig: OpenClawConfig = {
      ...testConfig,
      messages: { inbound: { debounceMs: 5 } },
    };
    mockState.runtimeCore = createRuntimeCore(debounceConfig, undefined, {
      inboundDebounceMs: 5,
      createInboundDebouncer,
    });

    const monitor = monitorMattermostProvider({
      config: debounceConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-a",
      message: "@openclaw original post A",
    });
    await vi.waitFor(() => {
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    });

    await emitMattermostChannelPost(socket, { id: "post-b", message: "post B" });
    await emitMattermostEditedPost(socket, {
      id: "post-a",
      message: "@openclaw reformatted post A",
      editAt: 1_714_000_000_075,
    });

    await vi.waitFor(() => {
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(2);
    });
    socket.emitClose(1000);
    await monitor;

    const ctx = mockState.dispatchInboundMessage.mock.calls.at(1)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("post B");
    expect(ctx?.Body).not.toContain("reformatted post A");
    expect(ctx?.MessageSid).toBe("post-b");
    expect(ctx?.MessageSids).toBeUndefined();
  });

  it("retains the observed mention state for each debounced sender", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const debounceConfig: OpenClawConfig = {
      ...mentionConfig,
      messages: { inbound: { debounceMs: 5 } },
    };
    mockState.runtimeCore = createRuntimeCore(debounceConfig, undefined, {
      inboundDebounceMs: 5,
      createInboundDebouncer,
    });

    const monitor = monitorMattermostProvider({
      config: debounceConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-alice",
      message: "alice draft",
      userId: "user-1",
    });
    await emitMattermostChannelPost(socket, {
      id: "post-bob",
      message: "bob draft",
      userId: "user-2",
    });
    await emitMattermostEditedPost(socket, {
      id: "post-alice",
      message: "@openclaw alice edited wake",
      editAt: 1_714_000_000_075,
      userId: "user-1",
    });

    await vi.waitFor(() => {
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("alice edited wake");
    expect(ctx?.MessageSid).toBe("post-alice");
  });

  it("does not wake when an edit adds only an on-character prefix", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const oncharConfig: OpenClawConfig = {
      ...testConfig,
      channels: {
        mattermost: {
          ...testConfig.channels?.mattermost,
          chatmode: "onchar",
          oncharPrefixes: ["!"],
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(oncharConfig);

    const monitor = monitorMattermostProvider({
      config: oncharConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-onchar-edit",
      message: "ordinary draft",
    });
    await emitMattermostEditedPost(socket, {
      id: "post-onchar-edit",
      message: "! edited wake",
      editAt: 1_714_000_000_075,
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it("does not let bot edited draft posts consume debounced user posts", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const debounceConfig: OpenClawConfig = {
      ...testConfig,
      messages: { inbound: { debounceMs: 5 } },
    };
    const runtimeCore = createRuntimeCore(debounceConfig, undefined, {
      inboundDebounceMs: 5,
      createInboundDebouncer,
    });
    mockState.runtimeCore = runtimeCore;

    const monitor = monitorMattermostProvider({
      config: debounceConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-user",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "user question",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    await socket.emitMessage({
      event: "post_edited",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "openclaw",
        post: JSON.stringify({
          id: "preview-post",
          channel_id: "chan-1",
          user_id: "bot-user",
          message: "@openclaw bot draft preview",
          create_at: 1_714_000_000_025,
          edit_at: 1_714_000_000_050,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "bot-user",
      },
    });

    await vi.waitFor(() => {
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    });
    socket.emitClose(1000);
    await monitor;

    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("user question");
    expect(ctx?.Body).toContain("user question");
    expect(ctx?.Body).not.toContain("bot draft preview");
    expect(ctx?.MessageSid).toBe("post-user");
    expect(ctx?.MessageSids).toBeUndefined();
  });
});
