import { createHash } from "node:crypto";
import {
  AccessToken,
  WebhookEvent,
  WebhookReceiver,
  Room,
  ParticipantInfo,
  SIPParticipantInfo,
  ServerError,
} from "livekit-server-sdk";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateProviderConfig, normalizeVoiceCallConfig } from "../config.js";
import { CallManager } from "../manager.js";
import {
  createTestStorePath,
  installVoiceCallStateRuntimeForTests,
  registerTestManagerCleanup,
  FakeProvider,
} from "../manager.test-harness.js";
import { resolveVoiceCallRealtimeTools } from "../realtime-call-control.js";
import { DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS } from "../realtime-defaults.js";
import type { CallRecord, WebhookContext } from "../types.js";
import { RealtimeCallHandler } from "../webhook/realtime-handler.js";
import {
  createBridge,
  makeRealtimeProvider,
} from "../webhook/realtime-handler.lifecycle.test-helpers.js";
import { StreamDisconnectGrace } from "../webhook/stream-disconnect-grace.js";
import { LiveKitProvider, type LiveKitDependencies } from "./livekit.js";

// mock-isolation: The offline manager/identity fixture must not open the host SQLite broker.
vi.mock("../manager/store.js", () => {
  const records = new Map<string, Map<string, CallRecord>>();
  const store = (path: string) => {
    let values = records.get(path);
    if (!values) {
      values = new Map();
      records.set(path, values);
    }
    return values;
  };
  return {
    persistCallRecord: async (path: string, call: CallRecord) => {
      store(path).set(call.callId, structuredClone(call));
    },
    findCallInStore: async (path: string, id: string) =>
      [...store(path).values()].find((call) => call.callId === id || call.providerCallId === id),
    loadActiveCallsFromStore: async () => ({
      activeCalls: new Map(),
      processedEventIds: new Set(),
      interruptedDeliveries: [],
    }),
    getCallHistoryFromStore: async (path: string) => [...store(path).values()],
  };
});

const livekit = {
  url: "wss://livekit.example.test",
  allowInsecureWs: false,
  apiKey: "test-key",
  apiSecret: "synthetic-livekit-secret-for-offline-tests",
  outboundTrunkId: "ST_out",
  inboundTrunkIds: ["ST_in"],
  roomPrefix: "openclaw-call-",
};
const from = "+15550000001";
const to = "+15550000002";

function webhook(
  room: string,
  event = "participant_joined",
  id = "event-1",
  overrides: Record<string, unknown> = {},
) {
  return WebhookEvent.fromJsonString(
    JSON.stringify({
      id,
      event,
      createdAt: String(Math.floor(Date.now() / 1000)),
      room: { name: room },
      participant: {
        identity: "sip-inbound",
        sid: "PA_in",
        kind: "SIP",
        attributes: { "sip.trunkID": "ST_in", "sip.phoneNumber": from, "sip.trunkPhoneNumber": to },
        ...overrides,
      },
    }),
  );
}
function context(event: WebhookEvent): WebhookContext {
  return {
    headers: { authorization: "synthetic-authorization" },
    rawBody: event.toJsonString(),
    method: "POST",
    url: "https://voice.example.test/webhook",
  };
}

async function harness(
  policy: "open" | "allowlist" = "open",
  server = livekit,
  handlesAgentConsult = true,
  fromNumber = from,
) {
  let participants: Array<{ identity: string; sid: string; kind: number }> = [
    { identity: "sip-inbound", sid: "PA_in", kind: 3 },
  ];
  const close = vi.fn(async () => {});
  const connectAudio = vi.fn<LiveKitDependencies["connectAudio"]>(async () => ({ close }));
  const rooms = {
    createRoom: vi.fn<LiveKitDependencies["rooms"]["createRoom"]>(async () => new Room()),
    deleteRoom: vi.fn<LiveKitDependencies["rooms"]["deleteRoom"]>(async () => {}),
    listRooms: vi.fn<LiveKitDependencies["rooms"]["listRooms"]>(async (names) =>
      names!.map((name) => new Room({ name, maxParticipants: 2 })),
    ),
    listParticipants: vi.fn<LiveKitDependencies["rooms"]["listParticipants"]>(async () =>
      participants.map((participant) => new ParticipantInfo(participant)),
    ),
  };
  const sip = {
    createSipParticipant: vi.fn<LiveKitDependencies["sip"]["createSipParticipant"]>(
      async (_trunk, _number, _room, opts) => {
        participants = [{ identity: opts!.participantIdentity!, sid: "PA_out", kind: 3 }];
        return new SIPParticipantInfo({ participantId: "PA_out" });
      },
    ),
  };
  const receiver = {
    receive: vi.fn<LiveKitDependencies["receiver"]["receive"]>(async (body) =>
      WebhookEvent.fromJsonString(body),
    ),
  };
  const provider = new LiveKitProvider(server, { rooms, sip, receiver, connectAudio });
  const config = normalizeVoiceCallConfig({
    enabled: true,
    agentId: "main",
    provider: "livekit",
    livekit: server,
    fromNumber,
    inboundPolicy: policy,
    allowFrom: [],
    realtime: { enabled: true },
    outbound: { defaultMode: "conversation" },
  });
  installVoiceCallStateRuntimeForTests();
  const manager = registerTestManagerCleanup(new CallManager(config, createTestStorePath()));
  await manager.initialize(provider, "https://voice.example.test/webhook");
  const bridgeSendAudio = vi.fn();
  const bridgeClose = vi.fn(async () => {});
  const bridge = createBridge(bridgeClose, { sendAudio: bridgeSendAudio });
  const createModelBridge = vi.fn<RealtimeVoiceProviderPlugin["createBridge"]>(() => bridge);
  const realtime = makeRealtimeProvider(createModelBridge);
  const handler = new RealtimeCallHandler(
    {
      ...config.realtime,
      tools: resolveVoiceCallRealtimeTools(config.realtime.toolPolicy, config.realtime.tools),
    },
    manager,
    () => ({
      agentId: "main",
      provider: realtime,
      providerConfig: {},
      instructions: config.realtime.instructions,
      capabilities: {
        transports: ["gateway-relay"],
        inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ],
        outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ],
        handlesAgentConsult,
      },
    }),
    config.serve.path,
    new StreamDisconnectGrace(() => {}),
  );
  provider.bind(manager, handler);
  const receive = async (event: WebhookEvent) => {
    const ctx = context(event);
    expect((await provider.verifyWebhook(ctx)).ok).toBe(true);
    const result = await provider.parseWebhookEvent(ctx);
    for (const normalized of result.events) {
      await manager.processEvent(normalized);
    }
    const call = manager.getCallByProviderCallId(event.room!.name);
    if (call && result.events.some((item) => item.type === "call.initiated")) {
      await provider.answerCall({ callId: call.callId, providerCallId: event.room!.name });
    }
    return result;
  };
  return {
    bridge,
    bridgeSendAudio,
    bridgeClose,
    createModelBridge,
    provider,
    manager,
    handler,
    rooms,
    sip,
    connectAudio,
    close,
    receiver,
    receive,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("LiveKit telephony lifecycle", () => {
  it("preserves the opted-in WS URL for native RTC while retaining call cleanup", async () => {
    const h = await harness("open", {
      ...livekit,
      url: "ws://10.0.0.1:7880",
      allowInsecureWs: true,
    });
    const started = await h.manager.initiateCall(to, undefined, { mode: "conversation" });
    expect(started.success).toBe(true);
    expect(h.connectAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://10.0.0.1:7880",
        callId: started.callId,
        token: expect.any(String),
      }),
    );
    await h.manager.endCall(started.callId);
    await h.handler.close();
    await h.provider.stop();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("attaches RTC to the existing realtime owner with call-bound native agent delegation", async () => {
    const h = await harness();
    const started = await h.manager.initiateCall(to, undefined, { mode: "conversation" });
    const call = h.manager.getCall(started.callId)!;
    const consult = vi.fn(async () => ({ text: "Call-owned agent answer" }));
    h.handler.registerToolHandler(REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, consult);
    let open = true;
    const transport = {
      get readyState() {
        return open ? 1 : 3;
      },
      bufferedAmount: 0,
      send: vi.fn(),
      close: () => {
        open = false;
      },
    };
    const binding = await h.handler.attachRoomTransport({
      callId: call.callId,
      providerCallId: call.providerCallId!,
      streamId: "rtc-test",
      transport,
    });
    expect(binding).not.toBeNull();
    binding!.sendAudio(Buffer.from([255, 255, 255]));
    expect(h.bridgeSendAudio).toHaveBeenCalledWith(Buffer.from([255, 255, 255]));
    const options = h.createModelBridge.mock.calls[0]![0];
    expect(options.instructions).toBe(
      `${DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS}\n\nUse native agent delegation for OpenClaw work. To end the current call, say out loud that you are hanging up and delegate; the OpenClaw agent acts on the transcript. Other custom realtime function tools are unavailable in this session.`,
    );
    expect(options.tools).toEqual([]);
    expect(options.runAgentConsult).toBeTypeOf("function");
    await expect(
      options.runAgentConsult!({ prompt: "Check the caller's request" }),
    ).resolves.toEqual({ text: "Call-owned agent answer" });
    expect(consult).toHaveBeenCalledWith(expect.anything(), call.callId, expect.anything());
    await h.manager.endCall(call.callId);
    await binding!.endCall();
    await h.handler.close();
    await h.provider.stop();
    expect(h.bridgeClose).toHaveBeenCalled();
  });

  it("preserves the default prompt and built-in function tools over RTC", async () => {
    const h = await harness("open", livekit, false);
    const started = await h.manager.initiateCall(to, undefined, { mode: "conversation" });
    const call = h.manager.getCall(started.callId)!;
    const binding = await h.handler.attachRoomTransport({
      callId: call.callId,
      providerCallId: call.providerCallId!,
      streamId: "rtc-function-tools",
      transport: { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() },
    });
    expect(binding).not.toBeNull();
    const options = h.createModelBridge.mock.calls[0]![0];
    expect(options.instructions).toBe(DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS);
    expect(options.tools?.map((tool) => tool.name)).toEqual([
      "openclaw_end_call",
      REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    ]);
    expect(options.runAgentConsult).toBeUndefined();
    options.onToolCall?.({
      name: "openclaw_end_call",
      args: {},
      callId: "end-current",
      itemId: "end-item",
    });
    await vi.waitFor(() => {
      expect(h.rooms.deleteRoom).toHaveBeenCalledWith(call.providerCallId);
      expect(call.state).toBe("hangup-bot");
      expect(h.manager.getCall(call.callId)).toBeUndefined();
    });
    await binding!.endCall();
    await h.handler.close();
    await h.provider.stop();
  });

  it("distinguishes missing rooms from transient status failures and shuts down active calls", async () => {
    const h = await harness();
    await expect(
      h.provider.hangupCall({
        callId: "foreign",
        providerCallId: "shared-room",
        reason: "completed",
      }),
    ).rejects.toThrow("outside the configured room prefix");
    expect(h.rooms.deleteRoom).not.toHaveBeenCalled();
    h.rooms.listParticipants.mockRejectedValueOnce(
      new ServerError("not_found", "synthetic missing room", 404, "not_found"),
    );
    await expect(
      h.provider.getCallStatus({ providerCallId: "openclaw-call-missing" }),
    ).resolves.toEqual({ status: "completed", isTerminal: true });
    h.rooms.listParticipants.mockRejectedValueOnce(new Error("synthetic transient"));
    expect(
      (await h.provider.getCallStatus({ providerCallId: "openclaw-call-transient" })).isUnknown,
    ).toBe(true);
    const started = await h.manager.initiateCall(to, undefined, { mode: "conversation" });
    expect(started.success).toBe(true);
    const stopping = h.provider.stop();
    expect(h.provider.stop()).toBe(stopping);
    await stopping;
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    expect(h.close).toHaveBeenCalledOnce();
    await h.handler.close();
  });

  it("preserves an extension From through normalization, manager state and the SIP SDK", async () => {
    const h = await harness("open", livekit, true, "6018");
    const result = await h.manager.initiateCall(to, undefined, { mode: "conversation" });
    expect(result.success).toBe(true);
    const call = h.manager.getCall(result.callId)!;
    expect(call.from).toBe("6018");
    expect(call.to).toBe(to);
    expect(h.sip.createSipParticipant).toHaveBeenCalledWith(
      "ST_out",
      to,
      call.providerCallId,
      expect.objectContaining({ fromNumber: "6018", waitUntilAnswered: true }),
    );
    await h.manager.endCall(result.callId);
    await h.provider.stop();
    await h.handler.close();
  });

  it("selects the outbound trunk and correlates an isolated room before RTC join", async () => {
    const h = await harness();
    const result = await h.manager.initiateCall(to, undefined, {
      mode: "conversation",
      message: "Hello",
    });
    expect(result.success).toBe(true);
    const call = h.manager.getCall(result.callId)!;
    expect(call.providerCallId).toMatch(/^openclaw-call-/);
    expect(h.sip.createSipParticipant).toHaveBeenCalledWith(
      "ST_out",
      to,
      call.providerCallId,
      expect.objectContaining({ fromNumber: from, waitUntilAnswered: true }),
    );
    expect(h.connectAudio).toHaveBeenCalledOnce();
    expect(h.connectAudio.mock.calls[0]![0]).toMatchObject({
      room: call.providerCallId,
      callId: result.callId,
      participantSid: "PA_out",
    });
    await h.manager.endCall(result.callId);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.rooms.deleteRoom).toHaveBeenCalledWith(call.providerCallId);
    await h.provider.stop();
    await h.handler.close();
  });

  it("admits a signed selected inbound trunk once and ignores duplicate/foreign participants", async () => {
    const h = await harness();
    const room = "openclaw-call-inbound";
    await h.receive(webhook(room));
    expect(h.connectAudio).toHaveBeenCalledOnce();
    await h.receive(webhook(room));
    await h.receive(
      webhook(room, "participant_left", "other-left", { identity: "foreign", sid: "PA_other" }),
    );
    expect(h.connectAudio).toHaveBeenCalledOnce();
    expect(h.manager.getActiveCalls()).toHaveLength(1);
    await h.receive(webhook(room, "participant_left", "caller-left"));
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    await h.receive(webhook(room, "participant_joined", "late-join"));
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    expect(h.connectAudio).toHaveBeenCalledOnce();
    await h.provider.stop();
    await h.handler.close();
  });

  it("enforces existing caller allowlist before any token or RTC session", async () => {
    const h = await harness("allowlist");
    await h.receive(webhook("openclaw-call-rejected"));
    expect(h.connectAudio).not.toHaveBeenCalled();
    expect(h.rooms.deleteRoom).toHaveBeenCalledWith("openclaw-call-rejected");
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    await h.provider.stop();
    await h.handler.close();
  });

  it("ignores unselected trunks, non-SIP callers, and unverified bodies", async () => {
    const h = await harness();
    const event = webhook("openclaw-call-foreign", "participant_joined", "foreign", {
      attributes: {
        "sip.trunkID": "ST_wrong",
        "sip.phoneNumber": from,
        "sip.trunkPhoneNumber": to,
      },
    });
    expect((await h.provider.parseWebhookEvent(context(event))).events).toEqual([]);
    await h.receive(event);
    await h.receive(
      webhook("openclaw-call-human", "participant_joined", "human", { kind: "STANDARD" }),
    );
    expect(h.connectAudio).not.toHaveBeenCalled();
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    await h.provider.stop();
    await h.handler.close();
  });

  it("requires a server-enforced two-participant room cap before publishing speech", async () => {
    const h = await harness();
    h.rooms.listRooms.mockResolvedValue([
      new Room({ name: "openclaw-call-unbounded", maxParticipants: 0 }),
    ]);
    await h.receive(webhook("openclaw-call-unbounded"));
    expect(h.connectAudio).not.toHaveBeenCalled();
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    await h.provider.stop();
    await h.handler.close();
  });

  it("fails closed when another participant is present and cleans up setup failures", async () => {
    const h = await harness();
    h.rooms.listParticipants.mockResolvedValue([
      new ParticipantInfo({ identity: "sip-inbound", sid: "PA_in" }),
      new ParticipantInfo({ identity: "foreign" }),
    ]);
    await h.receive(webhook("openclaw-call-shared"));
    expect(h.connectAudio).not.toHaveBeenCalled();
    expect(h.rooms.deleteRoom).toHaveBeenCalledWith("openclaw-call-shared");
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    await h.provider.stop();
    await h.handler.close();
  });

  it("cancels a pending dial without joining and removes a late-created SIP participant", async () => {
    const h = await harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const dialing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.sip.createSipParticipant.mockImplementation(async () => {
      entered();
      await held;
      return new SIPParticipantInfo({ participantId: "PA_late" });
    });
    const initiated = h.manager.initiateCall(to, undefined, { mode: "conversation" });
    await dialing;
    const call = h.manager.getActiveCalls()[0]!;
    await h.manager.endCall(call.callId);
    release();
    expect((await initiated).success).toBe(false);
    expect(h.connectAudio).not.toHaveBeenCalled();
    expect(h.rooms.deleteRoom.mock.calls.length).toBeGreaterThanOrEqual(2);
    await h.provider.stop();
    await h.handler.close();
  });
});

it("uses SDK signature and body digest verification, expiring room-scoped microphone-only grants", async () => {
  const provider = new LiveKitProvider(livekit);
  const room = "openclaw-call-security";
  const jwt = await provider.roomToken(room);
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
  expect(claims.video).toMatchObject({
    room,
    roomJoin: true,
    canPublishData: false,
    canPublishSources: ["microphone"],
  });
  expect(claims.video.roomAdmin).toBeUndefined();
  expect(claims.sip).toBeUndefined();
  expect(claims.exp - claims.nbf).toBeLessThanOrEqual(60);
  const event = webhook(room);
  const ctx = context(event);
  const token = new AccessToken(livekit.apiKey, livekit.apiSecret, { ttl: 60 });
  token.sha256 = createHash("sha256").update(ctx.rawBody).digest("base64");
  ctx.headers.authorization = await token.toJwt();
  expect((await provider.verifyWebhook(ctx)).ok).toBe(true);
  expect((await provider.verifyWebhook({ ...ctx, rawBody: `${ctx.rawBody} ` })).ok).toBe(false);
  expect(
    (await provider.verifyWebhook({ ...ctx, headers: { authorization: "bad-token-secret" } }))
      .reason,
  ).not.toContain("bad-token-secret");
  const expired = new AccessToken(livekit.apiKey, livekit.apiSecret, { ttl: -60 });
  expired.sha256 = createHash("sha256").update(ctx.rawBody).digest("base64");
  expect(
    (await provider.verifyWebhook({ ...ctx, headers: { authorization: await expired.toJwt() } }))
      .ok,
  ).toBe(false);
  const foreign = new AccessToken("foreign-key", livekit.apiSecret, { ttl: 60 });
  foreign.sha256 = expired.sha256;
  expect(
    (await provider.verifyWebhook({ ...ctx, headers: { authorization: await foreign.toJwt() } }))
      .ok,
  ).toBe(false);
  const receiver = new WebhookReceiver(livekit.apiKey, livekit.apiSecret);
  expect((await receiver.receive(ctx.rawBody, ctx.headers.authorization as string)).id).toBe(
    event.id,
  );
});

it("requires signed webhooks, valid server URL, and realtime audio", () => {
  const config = normalizeVoiceCallConfig({
    enabled: true,
    provider: "livekit",
    livekit,
    fromNumber: from,
    inboundPolicy: "open",
  });
  expect(validateProviderConfig(config).errors).toContain("LiveKit requires realtime.enabled");
  expect(() =>
    normalizeVoiceCallConfig({
      provider: "livekit",
      livekit: { ...livekit, url: "http://insecure.test" },
    }),
  ).toThrow();
});

it("keeps inbound admission available after more than 4096 retired rooms", async () => {
  const h = await harness();
  for (let i = 0; i < 4100; i++) {
    await h.receive(webhook(`openclaw-call-churn-${i}`, "room_finished", `finished-${i}`));
  }
  await h.receive(webhook("openclaw-call-after-churn", "participant_joined", "new-inbound"));
  expect(h.connectAudio).toHaveBeenCalledOnce();
  await h.provider.stop();
  await h.handler.close();
});

it.each(["wrong", "withheld"])(
  "deletes rejected %s SIP rooms and tombstones late joins",
  async (kind) => {
    const h = await harness();
    const room = `openclaw-call-reject-${kind}`;
    const attributes = {
      "sip.trunkID": kind === "wrong" ? "ST_wrong" : "ST_in",
      "sip.phoneNumber": kind === "withheld" ? "anonymous" : from,
      "sip.trunkPhoneNumber": to,
    };
    await h.receive(webhook(room, "participant_joined", "rejected", { attributes }));
    await h.receive(webhook(room, "participant_joined", "late-valid"));
    expect(h.rooms.deleteRoom).toHaveBeenCalledWith(room);
    expect(h.connectAudio).not.toHaveBeenCalled();
    await h.provider.stop();
    await h.handler.close();
  },
);

it("fails closed on startup webhooks before binding rather than stranding the caller", async () => {
  const h = await harness();
  const provider = new LiveKitProvider(livekit, {
    rooms: h.rooms,
    sip: h.sip,
    receiver: h.receiver,
    connectAudio: h.connectAudio,
  });
  const ctx = context(webhook("openclaw-call-before-bind"));
  await provider.verifyWebhook(ctx);
  expect((await provider.parseWebhookEvent(ctx)).events).toEqual([]);
  await provider.stop();
  expect(h.rooms.deleteRoom).toHaveBeenCalledWith("openclaw-call-before-bind");
  expect(h.connectAudio).not.toHaveBeenCalled();
  await h.provider.stop();
  await h.handler.close();
});

it("surfaces failed dial cleanup and retries it without vendor secret leakage", async () => {
  const h = await harness();
  h.sip.createSipParticipant.mockRejectedValueOnce(new Error("secret vendor failure"));
  h.rooms.deleteRoom.mockRejectedValueOnce(new Error("secret cleanup failure"));
  const result = await h.manager.initiateCall(to, undefined, { mode: "conversation" });
  expect(result.success).toBe(false);
  expect(result.error).toContain("cleanup pending retry");
  expect(result.error).not.toContain("secret");
  await h.provider.retryPendingCleanup();
  expect(h.rooms.deleteRoom).toHaveBeenCalledTimes(2);
  await h.provider.stop();
  await h.handler.close();
});

it("continues startup after transient restored cleanup failure and retries safely", async () => {
  const h = await harness();
  const started = await h.manager.initiateCall(to, undefined, { mode: "conversation" });
  const replacement = new LiveKitProvider(livekit, {
    rooms: h.rooms,
    sip: h.sip,
    receiver: h.receiver,
    connectAudio: h.connectAudio,
  });
  replacement.bind(h.manager, h.handler);
  h.rooms.deleteRoom.mockRejectedValueOnce(new Error("transient"));
  const end = vi.spyOn(h.manager, "endCall");
  end.mockResolvedValueOnce({ success: false, error: "transient" });
  await expect(replacement.retireRestoredCalls()).resolves.toBeUndefined();
  await replacement.retryPendingCleanup();
  await replacement.retryPendingCleanup();
  expect(h.manager.getCall(started.callId)).toBeUndefined();
  await replacement.stop();
  await h.provider.stop();
  await h.handler.close();
});

it("uses current time for signed events lacking createdAt", async () => {
  const h = await harness();
  const event = webhook("openclaw-call-no-time");
  event.createdAt = 0n;
  const ctx = context(event);
  await h.provider.verifyWebhook(ctx);
  expect((await h.provider.parseWebhookEvent(ctx)).events[0]!.timestamp).toBeGreaterThan(0);
  await h.provider.stop();
  await h.handler.close();
});

it("enforces manager-owned inbound concurrency cap before another RTC join", async () => {
  const h = await harness();
  await h.receive(webhook("openclaw-call-first", "participant_joined", "first"));
  await h.receive(webhook("openclaw-call-over-cap", "participant_joined", "second"));
  expect(h.manager.getActiveCalls()).toHaveLength(1);
  expect(h.connectAudio).toHaveBeenCalledOnce();
  expect(h.rooms.deleteRoom).toHaveBeenCalledWith("openclaw-call-over-cap");
  await h.provider.stop();
  await h.handler.close();
});

it("runs service-owned cleanup retry without real waits", async () => {
  const h = await harness();
  vi.useFakeTimers();
  try {
    h.rooms.deleteRoom.mockRejectedValueOnce(new Error("transient"));
    await h.receive(
      webhook("openclaw-call-retry-timer", "participant_joined", "reject-timer", {
        attributes: { "sip.trunkID": "wrong" },
      }),
    );
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.rooms.deleteRoom).toHaveBeenCalledTimes(2);
    await h.provider.stop();
    await h.handler.close();
  } finally {
    vi.useRealTimers();
  }
});

it("ignores invalid inactive LiveKit partial config at normalization boundary", () => {
  expect(normalizeVoiceCallConfig({ provider: "mock", livekit: { url: "invalid" } }).provider).toBe(
    "mock",
  );
  expect(() =>
    normalizeVoiceCallConfig({ provider: "livekit", livekit: { url: "invalid" } }),
  ).toThrow();
});

it.each(["twilio", "telnyx", "plivo"] as const)(
  "preserves %s inbound admission beyond outbound-only cap",
  async (name) => {
    const h = await harness();
    const provider = new FakeProvider(name);
    await h.manager.initialize(provider, "https://voice.example.test/webhook");
    for (let i = 0; i < 2; i++) {
      await h.manager.processEvent({
        id: `${name}-${i}`,
        type: "call.initiated",
        callId: `${name}-${i}`,
        providerCallId: `${name}-${i}`,
        timestamp: Date.now(),
        direction: "inbound",
        from,
        to,
      });
    }
    expect(h.manager.getActiveCalls()).toHaveLength(2);
    expect(provider.hangupCalls).toHaveLength(0);
    await h.provider.stop();
    await h.handler.close();
  },
);

it("reports pending restored cleanup at shutdown even when endCall fails before deleteRoom", async () => {
  const h = await harness();
  await h.manager.initiateCall(to, undefined, { mode: "conversation" });
  const replacement = new LiveKitProvider(livekit, {
    rooms: h.rooms,
    sip: h.sip,
    receiver: h.receiver,
    connectAudio: h.connectAudio,
  });
  replacement.bind(h.manager, h.handler);
  const end = vi
    .spyOn(h.manager, "endCall")
    .mockResolvedValue({ success: false, error: "pre-delete failure" });
  await replacement.retireRestoredCalls();
  await expect(replacement.stop()).rejects.toThrow("cleanup failed during shutdown");
  end.mockRestore();
  await h.provider.stop();
  await h.handler.close();
});

it.each([false, true])(
  "deletes room despite RTC close failure and preserves shutdown failure (delete fails: %s)",
  async (deleteFails) => {
    const h = await harness();
    const room = "openclaw-call-disconnect-failure";
    await h.receive(webhook(room));
    h.close.mockRejectedValue(new Error("secret disconnect failure"));
    if (deleteFails) {
      h.rooms.deleteRoom.mockRejectedValueOnce(new Error("secret delete failure"));
    }
    await expect(h.receive(webhook(room, "participant_left", "left"))).rejects.toThrow(
      deleteFails ? "LiveKit room cleanup failed" : "LiveKit RTC disconnect failed",
    );
    await h.provider.retryPendingCleanup();
    expect(h.rooms.deleteRoom).toHaveBeenCalledWith(room);
    if (deleteFails) {
      expect(h.rooms.deleteRoom.mock.calls.filter(([name]) => name === room)).toHaveLength(2);
    }
    // Successful unrelated cleanup must not clear the RTC failure.
    await h.provider.hangupCall({
      providerCallId: "openclaw-call-unrelated",
      callId: "unrelated",
      reason: "completed",
    });
    await expect(h.provider.stop()).rejects.toThrow("cleanup failed during shutdown");
    await h.handler.close();
  },
);

it("retains a failed drain from a connection returned after admission cancellation", async () => {
  const h = await harness();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const close = vi.fn(async () => {
    throw new Error("Synthetic unpublished final persistence failure");
  });
  h.connectAudio.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return { close };
  });
  const placement = h.manager.initiateCall(to, undefined, { mode: "conversation" });
  let hangup: ReturnType<CallManager["endCall"]> | undefined;
  try {
    await entered.promise;
    const call = h.manager.getActiveCalls()[0]!;
    hangup = h.manager.endCall(call.callId, { reason: "completed" });
    release.resolve();
    expect(await hangup).toMatchObject({ success: false, error: "LiveKit RTC disconnect failed" });
    expect((await placement).success).toBe(false);
    expect(close).toHaveBeenCalled();
    expect(h.rooms.deleteRoom).toHaveBeenCalledOnce();
    await expect(h.provider.stop()).rejects.toThrow("cleanup failed during shutdown");
  } finally {
    release.resolve();
    await placement;
    await hangup;
    await h.handler.close();
  }
});

it.each([
  { mode: "notify" as const, message: "Synthetic notification" },
  { mode: "conversation" as const, dtmfSequence: "123" },
])("rejects unsupported carrier playback before creating SIP resources (%j)", async (options) => {
  const h = await harness();
  try {
    const placement = await h.manager.initiateCall(to, undefined, options);
    expect(placement.success).toBe(false);
    expect(placement.error).toContain("not carrier XML notify or pre-connect DTMF");
    expect(h.rooms.createRoom).not.toHaveBeenCalled();
    expect(h.sip.createSipParticipant).not.toHaveBeenCalled();
  } finally {
    await h.handler.close();
    await h.provider.stop();
  }
});
