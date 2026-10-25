import { EventEmitter } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import {
  GatewayCloseCodes,
  GatewayDispatchEvents,
  GatewayOpcodes,
  PresenceUpdateStatus,
  type GatewaySendPayload,
} from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordVoiceStateUpdateListener } from "../voice/listeners.js";
import { Client } from "./client.js";
import { sharedGatewayIdentifyLimiter } from "./gateway-identify-limiter.js";
import { GatewayPlugin } from "./gateway.js";
import { VoicePlugin } from "./voice.js";

function attachOpenSocket(gateway: GatewayPlugin) {
  const send = vi.fn();
  (gateway as unknown as { ws: unknown }).ws = { readyState: 1, send };
  return send;
}

function sentGatewayOpcodes(send: ReturnType<typeof attachOpenSocket>) {
  return send.mock.calls.map(([raw]) => (JSON.parse(String(raw)) as { op?: unknown }).op);
}

function presenceUpdate(
  status: PresenceUpdateStatus.Online | PresenceUpdateStatus.Idle = PresenceUpdateStatus.Online,
  since: number | null = null,
): GatewaySendPayload {
  return { op: GatewayOpcodes.PresenceUpdate, d: { since, activities: [], status, afk: false } };
}

class FakeSocket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  close = vi.fn();

  payload(op: GatewayOpcodes, d: unknown, extra = {}) {
    this.emit("message", JSON.stringify({ op, d, ...extra }));
  }

  dispatch(t: GatewayDispatchEvents, d: unknown, s = 1) {
    this.payload(GatewayOpcodes.Dispatch, d, { t, s });
  }

  hello(interval = 45_000) {
    this.payload(GatewayOpcodes.Hello, { heartbeat_interval: interval }, { s: null });
  }
}

class TestGatewayPlugin extends GatewayPlugin {
  sockets: FakeSocket[] = [];
  connectCalls: boolean[] = [];
  urls: string[] = [];

  constructor(options: ConstructorParameters<typeof GatewayPlugin>[0] = {}) {
    super({ url: "wss://gateway.example.test", ...options });
  }

  override connect(resume = false): void {
    this.connectCalls.push(resume);
    super.connect(resume);
  }

  openSocket() {
    this.connect(false);
    const socket = expectDefined(this.sockets.at(-1), "Discord gateway socket");
    socket.emit("open");
    return socket;
  }

  protected override createWebSocket(url: string): never {
    const socket = new FakeSocket();
    this.urls.push(url);
    this.sockets.push(socket);
    return socket as never;
  }
}

function timedGateway(random?: number) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  if (random !== undefined) {
    vi.spyOn(Math, "random").mockReturnValue(random);
  }
  return new TestGatewayPlugin();
}

function outboundGateway() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const gateway = new GatewayPlugin({});
  return { gateway, send: attachOpenSocket(gateway) };
}

function fillOutboundQueue(gateway: GatewayPlugin, count: number) {
  for (let index = 0; index < count; index += 1) {
    gateway.send(presenceUpdate(PresenceUpdateStatus.Online, index));
  }
}

function expectConnections(gateway: TestGatewayPlugin, calls: boolean[]) {
  expect(gateway.connectCalls).toEqual(calls);
  expect(gateway.sockets).toHaveLength(calls.length);
}

type GatewayInternals = {
  handlePayload(payload: { op: number; t?: string; s?: number; d: unknown }, resume: boolean): void;
  sessionId: string | null;
  resumeGatewayUrl: string | null;
  sequence: number | null;
};

function gatewayInternals(gateway: GatewayPlugin): GatewayInternals {
  return gateway as unknown as GatewayInternals;
}

function createDispatchGateway(withGateway = false) {
  const gateway = new GatewayPlugin({});
  const client = {
    dispatchGatewayEvent: vi.fn(async () => {}),
    getPlugin: vi.fn((id: string) => (withGateway && id === "gateway" ? gateway : undefined)),
  };
  const internal = gateway as unknown as {
    client: unknown;
    handleDispatch(payload: { t: string; d: unknown }): Promise<void>;
  };
  internal.client = client;
  return {
    gateway,
    client,
    dispatch: (t: string, d: unknown) => internal.handleDispatch({ t, d }),
  };
}

function expectClearedSession(gateway: GatewayPlugin) {
  expect(gatewayInternals(gateway)).toMatchObject({
    sessionId: null,
    resumeGatewayUrl: null,
    sequence: null,
  });
}

const ready = {
  user: { id: "bot-user" },
  session_id: "session-1",
  resume_gateway_url: "wss://resume.example.test",
};
const voiceState = (user_id: string, channel_id: string | null) => ({
  guild_id: "g1",
  user_id,
  channel_id,
});

describe("GatewayPlugin", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sharedGatewayIdentifyLimiter.reset();
  });

  it("emits async dispatch failures as gateway errors", async () => {
    const gateway = new GatewayPlugin({});
    const error = new Error("listener failed");
    (gateway as unknown as { client: unknown }).client = {
      dispatchGatewayEvent: async () => {
        throw error;
      },
    };
    const errorSpy = vi.fn();
    gateway.emitter.on("error", errorSpy);

    gatewayInternals(gateway).handlePayload(
      {
        op: GatewayOpcodes.Dispatch,
        t: GatewayDispatchEvents.MessageCreate,
        s: 1,
        d: { id: "m1", channel_id: "c1", author: { id: "u1", username: "user" } },
      },
      false,
    );

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(error));
  });

  it("reconnects when the socket closes while waiting for identify concurrency", async () => {
    const gateway = timedGateway();
    await sharedGatewayIdentifyLimiter.wait();
    const errorSpy = vi.fn();
    gateway.emitter.on("error", errorSpy);

    const socket = gateway.openSocket();
    socket.hello();
    socket.readyState = 3;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(errorSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);

    expectConnections(gateway, [false, false]);
  });

  it("does not identify a replacement socket from a stale HELLO", async () => {
    const gateway = timedGateway();
    await sharedGatewayIdentifyLimiter.wait();

    const originalSocket = gateway.openSocket();
    originalSocket.hello();
    originalSocket.emit("close", 1006);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(gateway.connectCalls).toEqual([false, false]);
    const replacementSocket = gateway.sockets[1];
    replacementSocket?.emit("open");

    await vi.advanceTimersByTimeAsync(3_000);
    expect(replacementSocket?.send).not.toHaveBeenCalledWith(
      expect.stringContaining(`"op":${GatewayOpcodes.Identify}`),
    );

    replacementSocket?.hello();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(replacementSocket?.send).toHaveBeenCalledWith(
      expect.stringContaining(`"op":${GatewayOpcodes.Identify}`),
    );
  });

  it("routes only the bot's own guild voice updates to its adapter while preserving other members' events", () => {
    const gateway = new TestGatewayPlugin();
    const onVoiceStateUpdate = vi.fn();
    const onVoiceServerUpdate = vi.fn();
    const handleVoiceState = vi.fn();
    const client = new Client(
      { clientId: "application-id", token: "test-token" },
      { listeners: [{ type: GatewayDispatchEvents.VoiceStateUpdate, handle: handleVoiceState }] },
      [gateway, new VoicePlugin()],
    );
    const voice = expectDefined(client.getPlugin("voice"), "registered voice plugin");
    const adapter = voice.getGatewayAdapterCreator("g1")({
      onVoiceStateUpdate,
      onVoiceServerUpdate,
      destroy: vi.fn(),
    });
    const socket = expectDefined(gateway.sockets[0], "Discord gateway socket");
    const dispatch = socket.dispatch.bind(socket);
    const ownState = {
      guild_id: "g1",
      user_id: "bot-user",
      session_id: "bot-session",
      channel_id: "c1",
      self_mute: false,
      self_deaf: false,
    };
    try {
      dispatch(GatewayDispatchEvents.VoiceStateUpdate, ownState);
      expect(onVoiceStateUpdate).not.toHaveBeenCalled();
      dispatch(GatewayDispatchEvents.Ready, ready);
      dispatch(GatewayDispatchEvents.VoiceStateUpdate, ownState);
      expect(onVoiceStateUpdate).toHaveBeenCalledExactlyOnceWith(ownState);

      for (const channelId of ["c1", "c2", null]) {
        const foreignState = {
          ...ownState,
          user_id: "other-member",
          session_id: "other-session",
          channel_id: channelId,
          self_mute: true,
          self_deaf: true,
        };
        dispatch(GatewayDispatchEvents.VoiceStateUpdate, foreignState);
        expect(onVoiceStateUpdate).toHaveBeenCalledExactlyOnceWith(ownState);
        expect(handleVoiceState).toHaveBeenLastCalledWith(foreignState, client);
        if (channelId) {
          expect(gateway.listVoiceChannelStates("g1", channelId)).toContainEqual(foreignState);
        }
      }
      expect(gateway.listVoiceChannelStates("g1", "c1")).toEqual([ownState]);
      expect(gateway.listVoiceChannelStates("g1", "c2")).toEqual([]);

      dispatch(GatewayDispatchEvents.VoiceStateUpdate, { ...ownState, guild_id: "g2" });
      const server = { guild_id: "g1", token: "voice-token", endpoint: "voice.example.test" };
      dispatch(GatewayDispatchEvents.VoiceServerUpdate, { ...server, guild_id: "g2" });
      expect(onVoiceServerUpdate).not.toHaveBeenCalled();
      dispatch(GatewayDispatchEvents.VoiceServerUpdate, server);
      expect(onVoiceServerUpdate).toHaveBeenCalledExactlyOnceWith(server);
      expect(onVoiceStateUpdate).toHaveBeenCalledExactlyOnceWith(ownState);

      const ownLeave = { ...ownState, channel_id: null };
      dispatch(GatewayDispatchEvents.VoiceStateUpdate, ownLeave);
      expect(onVoiceStateUpdate).toHaveBeenCalledTimes(2);
      expect(onVoiceStateUpdate).toHaveBeenLastCalledWith(ownLeave);
    } finally {
      adapter.destroy();
      gateway.disconnect();
    }
  });

  it("tracks the live voice roster across guild snapshots and voice updates", async () => {
    const { gateway, dispatch } = createDispatchGateway();

    await dispatch(GatewayDispatchEvents.GuildCreate, {
      id: "g1",
      voice_states: [
        { user_id: "u1", channel_id: "c1" },
        { user_id: "u2", channel_id: "c1" },
        { user_id: "u3", channel_id: "c2" },
      ],
      members: [
        { user: { id: "u1", username: "owner", bot: false } },
        { user: { id: "u2", username: "friend", bot: false } },
        { user: { id: "u3", username: "helper", bot: true } },
      ],
    });

    expect(gateway.listVoiceChannelStates("g1", "c1")).toMatchObject([
      { user_id: "u1", member: { user: { username: "owner" } } },
      { user_id: "u2", member: { user: { username: "friend" } } },
    ]);

    const moveState = voiceState("u1", "c2");
    await dispatch(GatewayDispatchEvents.VoiceStateUpdate, moveState);
    const leaveState = voiceState("u2", null);
    await dispatch(GatewayDispatchEvents.VoiceStateUpdate, leaveState);
    const memberState = (user: string, channel: string | null, username: string) =>
      expect.objectContaining({
        ...voiceState(user, channel),
        member: expect.objectContaining({ user: expect.objectContaining({ username }) }),
      });
    expect(gateway.takeVoiceStateTransition(moveState as never)).toEqual({
      previous: memberState("u1", "c1", "owner"),
      current: memberState("u1", "c2", "owner"),
    });
    expect(gateway.takeVoiceStateTransition(moveState as never)).toBeNull();
    expect(gateway.takeVoiceStateTransition(leaveState as never)).toEqual({
      previous: memberState("u2", "c1", "friend"),
      current: memberState("u2", null, "friend"),
    });

    expect(gateway.listVoiceChannelStates("g1", "c1")).toEqual([]);
    expect(gateway.listVoiceChannelStates("g1", "c2")).toMatchObject([
      { user_id: "u1" },
      { user_id: "u3" },
    ]);

    await dispatch(GatewayDispatchEvents.GuildDelete, { id: "g1" });
    expect(gateway.listVoiceChannelStates("g1", "c2")).toBeNull();
  });

  it("keeps newly memberless voice updates unknown through the voice listener", async () => {
    const { gateway, client, dispatch } = createDispatchGateway(true);
    await dispatch(GatewayDispatchEvents.GuildCreate, { id: "g1", voice_states: [], members: [] });
    const memberlessState = voiceState("unknown-user", "c1");
    await dispatch(GatewayDispatchEvents.VoiceStateUpdate, memberlessState);
    const handleVoiceStateUpdate = vi.fn(async () => {});
    const listener = new DiscordVoiceStateUpdateListener({
      handleVoiceStateUpdate,
    } as unknown as ConstructorParameters<typeof DiscordVoiceStateUpdateListener>[0]);

    await listener.handle(memberlessState as never, client as never);

    expect(handleVoiceStateUpdate).toHaveBeenCalledWith(memberlessState, null);
    expect(gateway.listVoiceChannelStates("g1", "c1")).toEqual([
      expect.not.objectContaining({ member: expect.anything() }),
    ]);
  });

  it("clears cached voice states when a fresh gateway session becomes ready", async () => {
    const { gateway, dispatch } = createDispatchGateway();

    await dispatch(GatewayDispatchEvents.GuildCreate, {
      id: "g1",
      voice_states: [{ user_id: "u1", channel_id: "c1" }],
    });
    await dispatch(GatewayDispatchEvents.Ready, { ...ready, session_id: "session-2" });

    expect(gateway.listVoiceChannelStates("g1", "c1")).toBeNull();
  });

  it("drops the oldest queued events and warns once per saturation episode", () => {
    const { gateway, send } = outboundGateway();
    const warningSpy = vi.fn();
    gateway.emitter.on("warning", warningSpy);

    fillOutboundQueue(gateway, 242);

    expect(send).toHaveBeenCalledTimes(120);
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(
      "Gateway outbound queue overflow policy=drop-oldest droppedEvents=1 queuedEvents=120 maxQueuedEvents=120",
    );

    vi.advanceTimersByTime(60_000);

    const flushedSinceValues = send.mock.calls.slice(120).map(([serialized]) => {
      const payload = JSON.parse(String(serialized)) as { d?: { since?: number } };
      return payload.d?.since;
    });
    expect(flushedSinceValues).toEqual(Array.from({ length: 120 }, (_, index) => index + 122));
  });

  it("sends critical gateway events immediately even when regular sends are queued", () => {
    const { gateway, send } = outboundGateway();
    fillOutboundQueue(gateway, 120);
    gateway.send(presenceUpdate(PresenceUpdateStatus.Idle));
    gateway.send({ op: GatewayOpcodes.Heartbeat, d: 1 }, true);

    expect(send).toHaveBeenCalledTimes(121);
    expect(JSON.parse(send.mock.calls.at(-1)?.[0] as string)).toEqual({
      op: GatewayOpcodes.Heartbeat,
      d: 1,
    });
    vi.advanceTimersByTime(60_000);
    expect(send).toHaveBeenCalledTimes(122);
    expect(JSON.parse(send.mock.calls.at(-1)?.[0] as string)).toEqual(
      presenceUpdate(PresenceUpdateStatus.Idle),
    );
  });

  it("rejects gateway payloads that exceed Discord's size limit", () => {
    const { gateway, send } = outboundGateway();

    expect(() =>
      gateway.send({
        op: GatewayOpcodes.PresenceUpdate,
        d: {
          since: null,
          activities: [{ name: "x".repeat(4_100), type: 0 }],
          status: PresenceUpdateStatus.Online,
          afk: false,
        },
      } as GatewaySendPayload),
    ).toThrow(/4096-byte limit/);
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores stale socket close events after reconnecting", async () => {
    const gateway = timedGateway(0.5);

    const oldSocket = gateway.openSocket();
    gateway.connect(false);
    const socket = expectDefined(gateway.sockets[1], "replacement Discord gateway socket");
    socket.emit("open");
    socket.hello(100);
    await vi.advanceTimersByTimeAsync(0);
    gateway.isConnected = true;

    oldSocket.emit("close", 1006);

    expect(gateway.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(sentGatewayOpcodes(socket.send)).toContain(GatewayOpcodes.Heartbeat);
    gateway.disconnect();
  });

  it("falls back to a fresh IDENTIFY after three failed resume attempts", async () => {
    const gateway = timedGateway();
    const debugSpy = vi.fn();
    gateway.emitter.on("debug", debugSpy);
    (gateway as unknown as { client: unknown }).client = {
      options: { token: "token" },
      dispatchGatewayEvent: vi.fn(async () => {}),
    };

    const initialSocket = gateway.openSocket();
    initialSocket.hello();
    await vi.advanceTimersByTimeAsync(0);
    expect(sentGatewayOpcodes(initialSocket.send)).toContain(GatewayOpcodes.Identify);
    initialSocket.dispatch(GatewayDispatchEvents.Ready, ready, 42);
    await vi.advanceTimersByTimeAsync(0);

    for (const delayMs of [2_000, 4_000, 8_000]) {
      gateway.sockets.at(-1)?.emit("close", 1006);
      await vi.advanceTimersByTimeAsync(delayMs);
      const resumeSocket = gateway.sockets.at(-1);
      expect(gateway.urls.at(-1)).toMatch(/^wss:\/\/resume\.example\.test\//);
      resumeSocket?.emit("open");
      resumeSocket?.hello();
      expect(sentGatewayOpcodes(resumeSocket?.send ?? vi.fn())).toContain(GatewayOpcodes.Resume);
      expect(debugSpy).toHaveBeenCalledWith(
        `Gateway reconnect scheduled in ${delayMs}ms (close, resume=true)`,
      );
    }

    gateway.sockets.at(-1)?.emit("close", 1006);
    expect(debugSpy).toHaveBeenCalledWith(
      "Gateway forcing fresh IDENTIFY after 3 failed resume attempts",
    );
    expect(debugSpy).toHaveBeenCalledWith(
      "Gateway reconnect scheduled in 16000ms (close, resume=false)",
    );

    await vi.advanceTimersByTimeAsync(16_000);
    const freshSocket = gateway.sockets.at(-1);
    expect(gateway.urls.at(-1)).toMatch(/^wss:\/\/gateway\.example\.test\//);
    freshSocket?.emit("open");
    freshSocket?.hello();
    await vi.advanceTimersByTimeAsync(0);

    expect(sentGatewayOpcodes(freshSocket?.send ?? vi.fn())).toContain(GatewayOpcodes.Identify);
    expect(sentGatewayOpcodes(freshSocket?.send ?? vi.fn())).not.toContain(GatewayOpcodes.Resume);
    expectClearedSession(gateway);
  });

  it.each([
    { code: GatewayCloseCodes.InvalidSeq, delay: 2_000, fatal: false },
    { code: GatewayCloseCodes.InvalidIntents, delay: 30_000, fatal: true },
  ])("handles gateway close $code (fatal=$fatal)", async ({ code, delay, fatal }) => {
    const gateway = timedGateway();
    const errorSpy = vi.fn();
    gateway.emitter.on("error", errorSpy);
    gateway.openSocket().emit("close", code);
    await vi.advanceTimersByTimeAsync(delay);
    expectConnections(gateway, fatal ? [false] : [false, false]);
    if (fatal) {
      expect(errorSpy).toHaveBeenCalledWith(new Error("Fatal gateway close code: 4013"));
    }
  });

  it("clears resume state after invalid session false", async () => {
    const gateway = timedGateway(0);
    const sessionState = gatewayInternals(gateway);
    sessionState.sessionId = "session1";
    sessionState.resumeGatewayUrl = "wss://resume.example.test";
    sessionState.sequence = 123;

    gateway.openSocket();
    gatewayInternals(gateway).handlePayload({ op: GatewayOpcodes.InvalidSession, d: false }, true);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(gateway.connectCalls).toEqual([false, false]);
    expectClearedSession(gateway);
  });

  it("includes close code details when reconnect attempts are exhausted", async () => {
    const gateway = timedGateway();
    const errorSpy = vi.fn();
    gateway.emitter.on("error", errorSpy);

    gateway.openSocket();
    for (let attempt = 0; attempt <= 50; attempt += 1) {
      gateway.sockets.at(-1)?.emit("close", 1006);
      await vi.advanceTimersByTimeAsync(30_000);
      gateway.sockets.at(-1)?.emit("open");
    }

    expect(errorSpy).toHaveBeenCalledWith(
      new Error("Max reconnect attempts (50) reached after close code 1006"),
    );
    expect(gateway.connectCalls).toHaveLength(51);
    expect(gateway.sockets).toHaveLength(51);
  });

  it("bounds an oversized HELLO interval before scheduling the first heartbeat", async () => {
    // Pin the start jitter to the top of its window so the scheduled delay is
    // exactly the resolved interval; a storm shows up as a heartbeat at t=0.
    const gateway = timedGateway(1);
    gateway.emitter.on("error", () => {});
    const socket = gateway.openSocket();

    expect(() => socket.hello(Number.MAX_SAFE_INTEGER)).not.toThrow();

    let firstHeartbeatMs: number | undefined;
    for (let tick = 0; tick < 4 && firstHeartbeatMs === undefined; tick += 1) {
      await vi.advanceTimersToNextTimerAsync();
      if (sentGatewayOpcodes(socket.send).includes(GatewayOpcodes.Heartbeat)) {
        firstHeartbeatMs = Date.now();
      }
    }

    expect(firstHeartbeatMs).toBe(45_000);
  });

  it.each([0, 50])(
    "clears heartbeat timers before delayed reconnects at %sms",
    async (elapsedMs) => {
      const gateway = timedGateway(0.5);
      const socket = gateway.openSocket();
      socket.hello(100);
      await vi.advanceTimersByTimeAsync(elapsedMs);
      socket.send.mockClear();

      socket.payload(GatewayOpcodes.Reconnect, null);

      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(gateway.ws).toBeNull();
      // Only the reconnect deadline remains, before or after the first heartbeat.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(socket.send).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      gateway.disconnect();
    },
  );

  it("clears stale heartbeat timers before early reconnect exits", async () => {
    const gateway = timedGateway(0.5);
    gateway.connect(false);
    const socket = expectDefined(gateway.sockets[0], "Discord gateway socket");
    socket.hello(100);
    await vi.advanceTimersByTimeAsync(0);
    socket.send.mockClear();

    gateway.connect(true);

    expect(gateway.sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.send).not.toHaveBeenCalled();
    gateway.disconnect();
  });

  it("spaces identify sends across gateway connections", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const info = {
      url: "wss://gateway.discord.gg/",
      shards: 2,
      session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
    };
    const first = new GatewayPlugin({}, info);
    const second = new GatewayPlugin({}, info);
    (first as unknown as { client: unknown }).client = { options: { token: "token" } };
    (second as unknown as { client: unknown }).client = { options: { token: "token" } };
    const firstSend = attachOpenSocket(first);
    const secondSend = attachOpenSocket(second);

    for (const gateway of [first, second]) {
      gatewayInternals(gateway).handlePayload(
        { op: GatewayOpcodes.Hello, d: { heartbeat_interval: 45_000 } },
        false,
      );
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(sentGatewayOpcodes(firstSend)).toContain(GatewayOpcodes.Identify);
    expect(sentGatewayOpcodes(secondSend)).not.toContain(GatewayOpcodes.Identify);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sentGatewayOpcodes(secondSend)).toContain(GatewayOpcodes.Identify);
  });
});
