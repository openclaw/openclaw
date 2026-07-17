// Mattermost tests cover monitor.inbound system event plugin behavior.
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./monitor.inbound-system-event.test-helper.js";
import {
  createRuntimeCore,
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

describe("mattermost inbound user posts", () => {
  beforeEach(resetMattermostInboundTestState);

  it("does not enqueue regular user posts as system events", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;

    const monitor = monitorMattermostProvider({
      config: testConfig,
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
          id: "post-inbound-system-event-regular",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "hello from mattermost",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("hello from mattermost");
    expect(ctx?.ConversationLabel).toBe("Town Square id:chan-1");
    expect(ctx?.MessageSid).toBe("post-inbound-system-event-regular");
    expect(ctx?.OriginatingChannel).toBe("mattermost");
    expect(ctx?.Provider).toBe("mattermost");
  });

  it("keeps verbose inbound previews on complete UTF-16 boundaries", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    const verboseDebug = vi.fn();
    mockState.abortController = abortController;
    mockState.runtimeCore = createRuntimeCore(testConfig, undefined, { verboseDebug });

    const monitor = monitorMattermostProvider({
      config: testConfig,
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
          id: "post-verbose-preview",
          channel_id: "chan-1",
          user_id: "user-1",
          message: `${"a".repeat(199)}😀tail`,
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(verboseDebug).toHaveBeenCalledWith(
      `mattermost inbound: from=mattermost:channel:chan-1 len=205 preview="${"a".repeat(199)}"`,
    );
  });

  it("dispatches a bare bot mention whose body is empty after normalization as a wake event", async () => {
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
      event: "posted",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-bare-mention",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "@openclaw",
          create_at: 1_714_000_000_001,
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
    expect(ctx?.BodyForAgent).toBe("@openclaw");
    expect(ctx?.MessageSid).toBe("post-bare-mention");
    expect(ctx?.OriginatingChannel).toBe("mattermost");
    expect(ctx?.Provider).toBe("mattermost");
  });

  it("does not drop inline command-looking group text from non-command-authorized senders", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const inlineCommandConfig: OpenClawConfig = {
      commands: { useAccessGroups: true },
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
        },
      },
    };
    const isControlCommandMessage = vi.fn(() => false);
    const shouldComputeCommandAuthorized = vi.fn(() => true);
    mockState.runtimeCore = createRuntimeCore(inlineCommandConfig, undefined, {
      isControlCommandMessage,
      shouldComputeCommandAuthorized,
      shouldHandleTextCommands: () => true,
    });

    const monitor = monitorMattermostProvider({
      config: inlineCommandConfig,
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
          id: "post-inline-command",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "hello /status",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(isControlCommandMessage).toHaveBeenCalledWith("hello /status", inlineCommandConfig);
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("hello /status");
    expect(ctx?.CommandAuthorized).toBe(false);
    // Inline non-control text must not be tagged as an explicit text-slash command turn —
    // only authorized control commands take the source-reply suppression bypass.
    expect(ctx?.CommandSource).toBeUndefined();
  });

  // Regression for issue #86664: typed `/reset` (and `/new`) on a Mattermost DM under
  // message_tool_only source delivery (e.g. Codex harness default) silently dropped the
  // acknowledgement because the inbound context was not tagged as an explicit text-slash
  // command turn. The explicit-command exception in source-reply-delivery-mode.ts only
  // fires when CommandSource is "text" (or "native") AND CommandAuthorized is true. Mirrors
  // the iMessage fix from #82642.
  it("tags authorized typed text-slash control commands with CommandSource: text", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const directConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["user-1"],
        },
      },
    };
    const isControlCommandMessage = vi.fn((text?: string) =>
      ["/reset", "/new"].includes(text?.trim() ?? ""),
    );
    const shouldComputeCommandAuthorized = vi.fn(() => true);
    mockState.runtimeCore = createRuntimeCore(directConfig, undefined, {
      isControlCommandMessage,
      shouldComputeCommandAuthorized,
      shouldHandleTextCommands: () => true,
    });
    mockState.resolveChannelInfo.mockResolvedValue({
      id: "dm-1",
      name: "",
      display_name: "",
      team_id: "team-1",
      type: "D",
    });

    const monitor = monitorMattermostProvider({
      config: directConfig,
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
        channel_id: "dm-1",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-reset",
          channel_id: "dm-1",
          user_id: "user-1",
          message: " /reset",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "dm-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("/reset");
    expect(ctx?.CommandBody).toBe("/reset");
    expect(ctx?.CommandAuthorized).toBe(true);
    expect(ctx?.CommandSource).toBe("text");
  });

  it("uses websocket channel type when REST channel lookup fails", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const runtimeCore = createRuntimeCore(testConfig);
    mockState.runtimeCore = runtimeCore;
    mockState.resolveChannelInfo.mockResolvedValue(null);

    const monitor = monitorMattermostProvider({
      config: testConfig,
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
        channel_type: "O",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-ws-kind",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "hello with websocket kind",
          create_at: 1_714_000_000_000,
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
    expect(ctx?.BodyForAgent).toBe("hello with websocket kind");
    expect(ctx?.ChatType).toBe("channel");
    expect(ctx?.ConversationLabel).toBe("Town Square id:chan-1");
    expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
  });

  it("drops posts when neither REST nor websocket channel type can be resolved", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const channelTypeConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["trusted-user"],
        },
      },
    };
    const runtimeCore = createRuntimeCore(channelTypeConfig);
    mockState.runtimeCore = runtimeCore;
    mockState.resolveChannelInfo.mockResolvedValue(null);

    const monitor = monitorMattermostProvider({
      config: channelTypeConfig,
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
        channel_id: "dm-1",
        sender_name: "mallory",
        post: JSON.stringify({
          id: "post-missing-kind",
          channel_id: "dm-1",
          user_id: "new-user",
          message: "hello",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "dm-1",
        user_id: "new-user",
      },
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
    expect(runtimeCore.channel.session.recordInboundSession).not.toHaveBeenCalled();
  });

  it("flushes pending group text before authorizing a bare abort without a mention", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const abortMentionConfig: OpenClawConfig = {
      commands: { useAccessGroups: false },
      messages: { inbound: { debounceMs: 60_000 } },
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "oncall",
          dmPolicy: "open",
          groupPolicy: "open",
        },
      },
    };
    const isBareAbort = (text?: string) => ["abort", "stop"].includes(text?.trim() ?? "");
    const runtimeCore = createRuntimeCore(abortMentionConfig, undefined, {
      inboundDebounceMs: 60_000,
      createInboundDebouncer,
      isControlCommandMessage: isBareAbort,
      shouldComputeCommandAuthorized: isBareAbort,
      shouldHandleTextCommands: () => true,
      textHasControlCommand: () => false,
    });
    mockState.runtimeCore = runtimeCore;

    const monitor = monitorMattermostProvider({
      config: abortMentionConfig,
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
          id: "post-pending",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "pending text",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-abort",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "abort",
          create_at: 1_714_000_000_100,
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
    expect(ctx?.BodyForAgent).toBe("abort");
    expect(ctx?.CommandAuthorized).toBe(true);
  });

  it("pins direct-message main route updates to the configured owner", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const directConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["user-1"],
        },
      },
    };
    const runtimeCore = createRuntimeCore(directConfig);
    mockState.runtimeCore = runtimeCore;
    mockState.resolveChannelInfo.mockResolvedValue({
      id: "dm-1",
      name: "",
      display_name: "",
      team_id: "team-1",
      type: "D",
    });
    const monitor = monitorMattermostProvider({
      config: directConfig,
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
        channel_id: "dm-1",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-dm-1",
          channel_id: "dm-1",
          user_id: "user-1",
          message: "direct hello",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "dm-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
    const [recordCall] = runtimeCore.channel.session.recordInboundSession.mock.calls.at(0) ?? [];
    expect(recordCall?.storePath).toBe("/tmp/openclaw-test-sessions.json");
    expect(recordCall?.sessionKey).toBe("mattermost:default:channel:chan-1");
    const updateLastRoute = recordCall?.updateLastRoute;
    expect(updateLastRoute?.sessionKey).toBe("mattermost:default:channel:chan-1");
    expect(updateLastRoute?.channel).toBe("mattermost");
    expect(updateLastRoute?.to).toBe("user:user-1");
    expect(updateLastRoute?.accountId).toBe("default");
    expect(updateLastRoute?.mainDmOwnerPin?.ownerRecipient).toBe("user-1");
    expect(updateLastRoute?.mainDmOwnerPin?.senderRecipient).toBe("user-1");
    expect(typeof updateLastRoute?.mainDmOwnerPin?.onSkip).toBe("function");
    expect(recordCall?.createIfMissing).toBeUndefined();
    expect(recordCall?.groupResolution).toBeUndefined();
    expect(recordCall?.onRecordError).toBeInstanceOf(Function);
  });

  it("keeps per-channel direct-message route updates on the isolated session", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const directConfig: OpenClawConfig = {
      session: { dmScope: "per-channel-peer" },
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["user-1"],
        },
      },
    };
    const runtimeCore = createRuntimeCore(directConfig, {
      lastRoutePolicy: "session",
      mainSessionKey: "agent:main:main",
      sessionKey: "agent:main:mattermost:direct:user-1",
    });
    mockState.runtimeCore = runtimeCore;
    mockState.resolveChannelInfo.mockResolvedValue({
      id: "dm-1",
      name: "",
      display_name: "",
      team_id: "team-1",
      type: "D",
    });
    const { monitorMattermostProvider: monitorMattermostProviderLocal } =
      await import("./monitor.js");

    const monitor = monitorMattermostProviderLocal({
      config: directConfig,
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
        channel_id: "dm-1",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-dm-2",
          channel_id: "dm-1",
          user_id: "user-1",
          message: "isolated direct hello",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "dm-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
    const [recordCall] = runtimeCore.channel.session.recordInboundSession.mock.calls.at(0) ?? [];
    expect(recordCall?.sessionKey).toBe("agent:main:mattermost:direct:user-1");
    const updateLastRoute = recordCall?.updateLastRoute;
    expect(updateLastRoute?.sessionKey).toBe("agent:main:mattermost:direct:user-1");
    expect(updateLastRoute?.sessionKey).not.toBe("agent:main:main");
    expect(updateLastRoute?.channel).toBe("mattermost");
    expect(updateLastRoute?.to).toBe("user:user-1");
    expect(updateLastRoute?.accountId).toBe("default");
    expect(updateLastRoute?.mainDmOwnerPin).toBeUndefined();
  });
});
