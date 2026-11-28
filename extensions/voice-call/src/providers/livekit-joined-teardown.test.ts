import type { EventEmitter } from "node:events";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { ParticipantInfo, Room, SIPParticipantInfo, WebhookEvent } from "livekit-server-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { expect, it, vi } from "vitest";
import { normalizeVoiceCallConfig } from "../config.js";
import { CallManager } from "../manager.js";
import {
  createTestStorePath,
  installVoiceCallStateRuntimeForTests,
  registerTestManagerCleanup,
} from "../manager.test-harness.js";
import * as callStore from "../manager/store.js";
import type { CallRecord, WebhookContext } from "../types.js";
import { RealtimeCallHandler } from "../webhook/realtime-handler.js";
import {
  createBridge,
  makeRealtimeProvider,
} from "../webhook/realtime-handler.lifecycle.test-helpers.js";
import { StreamDisconnectGrace } from "../webhook/stream-disconnect-grace.js";
import { connectLiveKitAudio } from "./livekit-audio.js";
import { LiveKitProvider, type LiveKitDependencies } from "./livekit.js";

// mock-isolation: Synthetic SQLite snapshots exercise durable reopen without a host broker.
vi.mock("../manager/store.js", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { join } = await import("node:path");
  function withDatabase<T>(
    directory: string,
    work: (db: InstanceType<typeof DatabaseSync>) => T,
  ): T {
    const db = new DatabaseSync(join(directory, "synthetic-calls.sqlite"));
    try {
      db.exec("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, record TEXT NOT NULL)");
      return work(db);
    } finally {
      db.close();
    }
  }
  return {
    persistCallRecord: async (directory: string, call: CallRecord) =>
      withDatabase(directory, (db) => {
        db.prepare("INSERT OR REPLACE INTO calls VALUES (?, ?)").run(
          call.callId,
          JSON.stringify(call),
        );
      }),
    findCallInStore: async (directory: string, id: string) =>
      withDatabase(directory, (db) => {
        const row = db.prepare("SELECT record FROM calls WHERE id = ?").get(id);
        return row ? (JSON.parse(String(row.record)) as CallRecord) : undefined;
      }),
    loadActiveCallsFromStore: async () => ({
      activeCalls: new Map(),
      processedEventIds: new Set(),
      interruptedDeliveries: [],
    }),
    getCallHistoryFromStore: async () => [],
  };
});

const rtc = vi.hoisted(() => ({
  room: undefined as EventEmitter | undefined,
  roomName: "",
  identity: "",
  disconnect: vi.fn(async () => {}),
  sourceClose: vi.fn(async () => {}),
}));
// mock-isolation: Native media/network is controlled; manager and handler are real, persistence is synthetic.
vi.mock("@livekit/rtc-node", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Room: class extends EventEmitter {
      name = rtc.roomName;
      remoteParticipants = new Map([
        [rtc.identity, { identity: rtc.identity, sid: "PA_test", trackPublications: new Map() }],
      ]);
      localParticipant = { publishTrack: async () => {} };
      constructor() {
        super();
        rtc.room = this;
      }
      async connect() {}
      disconnect = rtc.disconnect;
    },
    AudioSource: class {
      clearQueue() {}
      close = rtc.sourceClose;
    },
    LocalAudioTrack: { createAudioTrack: () => ({}) },
    TrackPublishOptions: class {
      source = 2;
    },
    TrackSource: { SOURCE_MICROPHONE: 2 },
    TrackKind: { KIND_AUDIO: 1 },
    RoomEvent: {
      ParticipantConnected: "participantConnected",
      TrackPublished: "trackPublished",
      ParticipantDisconnected: "participantDisconnected",
      Disconnected: "disconnected",
      TrackSubscribed: "trackSubscribed",
      TrackUnsubscribed: "trackUnsubscribed",
    },
  };
});

async function fixture(
  options: {
    synchronousErrorClose?: boolean;
    provisionalCloseFailure?: boolean;
    shutdownDuringAdmission?: "before-bridge" | "after-bridge";
    holdAttachedAdmission?: boolean;
  } = {},
) {
  rtc.disconnect.mockClear();
  rtc.sourceClose.mockClear();
  const config = normalizeVoiceCallConfig({
    enabled: true,
    provider: "livekit",
    fromNumber: "+15550000001",
    livekit: {
      url: "wss://livekit.example.test",
      apiKey: "synthetic-key",
      apiSecret: "synthetic-offline-secret",
      outboundTrunkId: "ST_out",
      inboundTrunkIds: ["ST_in"],
      roomPrefix: "openclaw-call-",
    },
    realtime: { enabled: true },
    outbound: { defaultMode: "conversation" },
  });
  const rooms: LiveKitDependencies["rooms"] = {
    createRoom: vi.fn(async ({ name }) => {
      rtc.roomName = name!;
      return new Room({ name });
    }),
    deleteRoom: vi.fn(async () => {}),
    listRooms: vi.fn<LiveKitDependencies["rooms"]["listRooms"]>(async (names) =>
      names!.map((name) => new Room({ name, maxParticipants: 2 })),
    ),
    listParticipants: vi.fn(async () => [
      new ParticipantInfo({ identity: rtc.identity, sid: "PA_test", kind: 3 }),
    ]),
  };
  const provider = new LiveKitProvider(config.livekit!, {
    rooms,
    sip: {
      createSipParticipant: vi.fn(async (_trunk, _number, _room, sipOptions) => {
        rtc.identity = sipOptions!.participantIdentity!;
        return new SIPParticipantInfo({ participantId: "PA_test" });
      }),
    },
    receiver: { receive: async (body) => WebhookEvent.fromJsonString(body) },
    connectAudio: connectLiveKitAudio,
  });
  installVoiceCallStateRuntimeForTests();
  const storePath = createTestStorePath();
  const manager = registerTestManagerCleanup(new CallManager(config, storePath));
  await manager.initialize(provider, "https://fixture.invalid/webhook");
  const closeEntered = createDeferred<void>();
  const finishClose = createDeferred<void>();
  let callbacks!: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];
  const bridgeClose = vi.fn(async () => {
    if (options.synchronousErrorClose) {
      callbacks.onClose?.("error");
    }
    closeEntered.resolve();
    await finishClose.promise;
    callbacks.onTranscript?.("user", "Late caller final", true);
    callbacks.onTranscript?.("assistant", "Late assistant final", true);
    callbacks.onClose?.("completed");
    if (options.provisionalCloseFailure) {
      throw new Error("Synthetic provisional cleanup failure");
    }
  });
  const bridge = createBridge(bridgeClose);
  let shutdown: Promise<void> | undefined;
  const handler = new RealtimeCallHandler(
    config.realtime,
    manager,
    () => ({
      agentId: "main",
      instructions: "Synthetic unchanged registration.",
      providerConfig: {},
      provider: makeRealtimeProvider((params) => {
        callbacks = params;
        if (options.provisionalCloseFailure) {
          callbacks.onClose?.("error");
          finishClose.resolve();
        }
        if (options.shutdownDuringAdmission === "after-bridge") {
          shutdown = handler.close();
          finishClose.resolve();
        }
        return bridge;
      }),
      capabilities: {
        transports: ["gateway-relay"],
        inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ],
        outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ],
        handlesAgentConsult: true,
      },
    }),
    config.serve.path,
    new StreamDisconnectGrace(() => {}),
  );
  provider.bind(manager, handler);
  const attachEntered = createDeferred<void>();
  const releaseAttach = createDeferred<void>();
  if (options.holdAttachedAdmission) {
    // Hold the already-attached binding before the carrier publishes its connection.
    const attach = handler.attachRoomTransport.bind(handler);
    vi.spyOn(handler, "attachRoomTransport").mockImplementation(async (...args) => {
      const binding = await attach(...args);
      attachEntered.resolve();
      await releaseAttach.promise;
      return binding;
    });
  }
  if (options.shutdownDuringAdmission === "before-bridge") {
    const lookup = manager.getCallForStream.bind(manager);
    let lookupCount = 0;
    vi.spyOn(manager, "getCallForStream").mockImplementation(async (...args) => {
      const call = await lookup(...args);
      if (++lookupCount === 2) {
        shutdown = handler.close();
        finishClose.resolve();
      }
      return call;
    });
  }
  const terminal = createDeferred<void>();
  const termination = createDeferred<Awaited<ReturnType<CallManager["endCall"]>>>();
  vi.spyOn(manager, "endCall").mockImplementation(async (...args) => {
    const result = await CallManager.prototype.endCall.apply(manager, args);
    termination.resolve(result);
    if (result.success) {
      terminal.resolve();
    }
    return result;
  });
  const placementWork = manager.initiateCall("+15550000002", undefined, { mode: "conversation" });
  if (options.holdAttachedAdmission) {
    await attachEntered.promise;
  }
  const placement = options.holdAttachedAdmission
    ? { callId: manager.getActiveCalls()[0]!.callId, success: false, error: undefined }
    : await placementWork;
  if (!options.holdAttachedAdmission) {
    expect(placement.success).toBe(
      !options.shutdownDuringAdmission && !options.provisionalCloseFailure,
    );
  }
  const callId = placement.callId;
  const room = manager.getCall(callId)?.providerCallId ?? rtc.roomName;
  const webhook = async (event: string, eventRoom = room) => {
    const body = WebhookEvent.fromJsonString(
      JSON.stringify({
        id: `terminal-${event}`,
        event,
        room: { name: eventRoom },
        participant: { identity: rtc.identity, sid: "PA_test", kind: "SIP" },
      }),
    ).toJsonString();
    const ctx: WebhookContext = {
      method: "POST",
      headers: { authorization: "synthetic-auth" },
      rawBody: body,
      url: "https://fixture.invalid/webhook",
    };
    expect((await provider.verifyWebhook(ctx)).ok).toBe(true);
    const parsed = await provider.parseWebhookEvent(ctx);
    for (const normalized of parsed.events) {
      await manager.processEvent(normalized);
    }
    return parsed;
  };
  return {
    manager,
    provider,
    handler,
    rooms,
    callId,
    storePath,
    closeEntered,
    finishClose,
    bridgeClose,
    webhook,
    terminal,
    termination,
    callbacks: () => callbacks,
    shutdown,
    placement,
    placementWork,
    releaseAttach,
  };
}

it.each([
  "manager",
  "rtc",
  "participant",
  "provider-error",
  "provider-completed",
  "room_finished",
  "participant_left",
  "shutdown",
  "simultaneous",
] as const)(
  "joins late user and assistant finals before terminal publication and durable reopen (%s)",
  async (exit) => {
    const h = await fixture();
    let work: Promise<unknown> | undefined;
    try {
      if (exit === "rtc" || exit === "participant" || exit === "simultaneous") {
        rtc.room!.emit(exit === "participant" ? "participantDisconnected" : "disconnected", {
          identity: rtc.identity,
        });
      }
      if (exit === "room_finished" || exit === "participant_left" || exit === "simultaneous") {
        work = h.webhook(exit === "simultaneous" ? "room_finished" : exit);
      }
      if (exit === "provider-error" || exit === "provider-completed") {
        h.callbacks().onClose?.(exit === "provider-error" ? "error" : "completed");
        work = h.terminal.promise;
      }
      if (exit === "shutdown") {
        work = h.handler.close();
      }
      if (exit === "manager" || exit === "simultaneous") {
        const hangup = h.manager.endCall(h.callId, { reason: "completed" });
        work = work ? Promise.all([work, hangup]) : hangup;
      }
      work ??= h.terminal.promise;
      await h.closeEntered.promise;
      // Let already-admitted carrier/manager microtasks settle while provider disposal is held.
      await nextEventLoopTurn();
      expect(h.manager.getCall(h.callId)).toBeDefined();
      expect(h.manager.getCall(h.callId)!.endedAt).toBeUndefined();
      expect(h.rooms.deleteRoom).not.toHaveBeenCalled();
      h.finishClose.resolve();
      await work;
      expect(h.manager.getCall(h.callId)).toBeUndefined();
      expect(h.bridgeClose).toHaveBeenCalledOnce();
      expect(h.rooms.deleteRoom).toHaveBeenCalledOnce();
      expect(rtc.disconnect).toHaveBeenCalledOnce();
      await h.manager.stop();
      const retained = await callStore.findCallInStore(h.storePath, h.callId);
      expect(retained?.state).toBe(exit === "provider-error" ? "error" : "completed");
      expect(
        retained?.transcript.map((entry) => ({ speaker: entry.speaker, text: entry.text })),
      ).toEqual([
        { speaker: "user", text: "Late caller final" },
        { speaker: "bot", text: "Late assistant final" },
      ]);
    } finally {
      h.finishClose.resolve();
      await work;
      await h.handler.close();
      await h.provider.stop();
    }
  },
);

it.each(["manager", "room_finished", "rtc"] as const)(
  "holds terminal publication for deferred final persistence (%s)",
  async (exit) => {
    const h = await fixture();
    const entered = createDeferred<void>();
    const persisted = createDeferred<void>();
    const original = callStore.persistCallRecord;
    let held = false;
    const write = vi.spyOn(callStore, "persistCallRecord").mockImplementation(async (...args) => {
      if (!held && args[1].transcript.some((entry) => entry.text === "Late assistant final")) {
        held = true;
        entered.resolve();
        await persisted.promise;
      }
      await original(...args);
    });
    let work: Promise<unknown> | undefined;
    try {
      if (exit === "rtc") {
        rtc.room!.emit("disconnected");
        work = h.terminal.promise;
      } else {
        work = exit === "manager" ? h.manager.endCall(h.callId) : h.webhook(exit);
      }
      await h.closeEntered.promise;
      h.finishClose.resolve();
      await entered.promise;
      await nextEventLoopTurn();
      expect(h.manager.getCall(h.callId)).toBeDefined();
      expect(h.manager.getCall(h.callId)!.endedAt).toBeUndefined();
      expect(h.rooms.deleteRoom).not.toHaveBeenCalled();
      persisted.resolve();
      await work;
      expect((await callStore.findCallInStore(h.storePath, h.callId))?.transcript).toHaveLength(2);
      expect(h.manager.getCall(h.callId)).toBeUndefined();
    } finally {
      h.finishClose.resolve();
      persisted.resolve();
      await work;
      write.mockRestore();
      await h.handler.close();
      await h.provider.stop();
    }
  },
);

it.each(["manager", "room_finished", "rtc"] as const)(
  "surfaces final persistence failure, cleans the carrier, and never reports successful hangup (%s)",
  async (exit) => {
    const h = await fixture();
    const original = callStore.persistCallRecord;
    const write = vi.spyOn(callStore, "persistCallRecord").mockImplementation(async (...args) => {
      if (args[1].transcript.some((entry) => entry.text === "Late assistant final")) {
        throw new Error("Synthetic final persistence failure");
      }
      await original(...args);
    });
    let work: Promise<unknown> | undefined;
    try {
      if (exit === "rtc") {
        rtc.room!.emit("disconnected");
        work = h.termination.promise;
      } else {
        work = exit === "manager" ? h.manager.endCall(h.callId) : h.webhook(exit);
      }
      const outcome = work.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await h.closeEntered.promise;
      h.finishClose.resolve();
      if (exit === "room_finished") {
        expect(await outcome).toEqual({
          error: expect.objectContaining({ message: "LiveKit RTC disconnect failed" }),
        });
      } else {
        expect(await outcome).toEqual({
          result: { success: false, error: "LiveKit RTC disconnect failed" },
        });
      }
      expect(h.rooms.deleteRoom).toHaveBeenCalledOnce();
      expect(rtc.disconnect).toHaveBeenCalledOnce();
      expect(rtc.sourceClose).toHaveBeenCalledOnce();
      expect(h.manager.getCall(h.callId)).toBeDefined();
      expect((await callStore.findCallInStore(h.storePath, h.callId))?.endedAt).toBeUndefined();
      await expect(h.manager.endCall(h.callId)).resolves.toMatchObject({ success: false });
      expect(h.rooms.deleteRoom).toHaveBeenCalledOnce();
      await expect(h.provider.stop()).rejects.toThrow("cleanup failed during shutdown");
    } finally {
      h.finishClose.resolve();
      await work?.catch(() => {});
      write.mockRestore();
      await h.handler.close().catch(() => {});
      await h.provider.stop().catch(() => {});
    }
  },
);

it("joins synchronous provider error-close reentrancy without bypassing late-final disposal", async () => {
  const h = await fixture({ synchronousErrorClose: true });
  const hangup = h.manager.endCall(h.callId, { reason: "completed" });
  try {
    await h.closeEntered.promise;
    await nextEventLoopTurn();
    expect(h.manager.getCall(h.callId)).toBeDefined();
    expect(h.rooms.deleteRoom).not.toHaveBeenCalled();
    h.finishClose.resolve();
    expect(await hangup).toEqual({ success: true });
    expect((await callStore.findCallInStore(h.storePath, h.callId))?.transcript).toHaveLength(2);
    expect(h.bridgeClose).toHaveBeenCalledOnce();
    expect(h.rooms.deleteRoom).toHaveBeenCalledOnce();
  } finally {
    h.finishClose.resolve();
    await hangup;
    await h.handler.close();
    await h.provider.stop();
  }
});

it.each(["before-bridge", "after-bridge"] as const)(
  "settles shutdown during carrier-owned admission (%s)",
  async (stage) => {
    const h = await fixture({ shutdownDuringAdmission: stage });
    await h.shutdown;
    await h.provider.stop();
    expect(h.manager.getActiveCalls()).toHaveLength(0);
    expect(h.rooms.deleteRoom).toHaveBeenCalled();
    expect(rtc.disconnect).toHaveBeenCalledOnce();
    if (stage === "after-bridge") {
      expect(h.bridgeClose).toHaveBeenCalledOnce();
    }
  },
);

it.each(["carrier", "terminal-persistence"] as const)(
  "recovers authenticated terminal redelivery after %s failure",
  async (failure) => {
    const h = await fixture();
    const original = callStore.persistCallRecord;
    let fail = true;
    const write = vi.spyOn(callStore, "persistCallRecord").mockImplementation(async (...args) => {
      if (failure === "terminal-persistence" && fail && args[1].endedAt) {
        fail = false;
        throw new Error("Synthetic terminal persistence failure");
      }
      await original(...args);
    });
    if (failure === "carrier") {
      vi.mocked(h.rooms.deleteRoom).mockRejectedValueOnce(new Error("Transient deletion failure"));
    }
    const first = h.webhook("room_finished");
    const rejected = first.catch((error: unknown) => error);
    try {
      await h.closeEntered.promise;
      h.finishClose.resolve();
      expect(await rejected).toBeInstanceOf(Error);
      expect(h.manager.getCall(h.callId)).toBeDefined();
      const replay = await h.webhook("room_finished");
      expect(replay.events).toHaveLength(1);
      expect(h.manager.getCall(h.callId)).toBeUndefined();
      expect((await callStore.findCallInStore(h.storePath, h.callId))?.state).toBe("completed");
      expect(h.bridgeClose).toHaveBeenCalledOnce();
      expect(h.rooms.deleteRoom).toHaveBeenCalledTimes(failure === "carrier" ? 2 : 1);
    } finally {
      h.finishClose.resolve();
      await rejected;
      write.mockRestore();
      await h.handler.close();
      await h.provider.stop();
    }
  },
);

it("surfaces provisional provider cleanup failure during synchronous bridge creation close", async () => {
  const h = await fixture({ provisionalCloseFailure: true });
  expect(h.placement.success).toBe(false);
  expect(h.placement.error).toContain("cleanup pending retry");
  expect(await h.termination.promise).toMatchObject({
    success: false,
    error: "LiveKit RTC disconnect failed",
  });
  expect(h.rooms.deleteRoom).toHaveBeenCalledOnce();
  expect(rtc.sourceClose).toHaveBeenCalledOnce();
  expect(h.bridgeClose).toHaveBeenCalledOnce();
  await expect(h.provider.stop()).rejects.toThrow("cleanup failed during shutdown");
  await h.handler.close().catch(() => {});
});

it.each(["ttl", "capacity"] as const)(
  "retains unresolved terminal correlation through tombstone %s eviction",
  async (eviction) => {
    const h = await fixture();
    const original = callStore.persistCallRecord;
    let fail = true;
    const write = vi.spyOn(callStore, "persistCallRecord").mockImplementation(async (...args) => {
      if (fail && args[1].endedAt) {
        fail = false;
        throw new Error("Synthetic recoverable terminal persistence failure");
      }
      await original(...args);
    });
    const first = h.webhook("room_finished").catch((error: unknown) => error);
    let clock: { mockRestore: () => void } | undefined;
    try {
      await h.closeEntered.promise;
      h.finishClose.resolve();
      expect(await first).toBeInstanceOf(Error);
      expect(h.manager.getCall(h.callId)).toBeDefined();
      if (eviction === "ttl") {
        const now = Date.now();
        clock = vi.spyOn(Date, "now").mockReturnValue(now + 300001);
      } else {
        for (let index = 0; index < 4097; index++) {
          await h.webhook("room_finished", `openclaw-call-unknown-${index}`);
        }
      }
      expect((await h.webhook("room_finished")).events).toHaveLength(1);
      expect(h.manager.getCall(h.callId)).toBeUndefined();
      expect((await callStore.findCallInStore(h.storePath, h.callId))?.state).toBe("completed");
      expect(h.bridgeClose).toHaveBeenCalledOnce();
      expect(h.rooms.deleteRoom).toHaveBeenCalledOnce();
    } finally {
      clock?.mockRestore();
      h.finishClose.resolve();
      await first;
      write.mockRestore();
      await h.handler.close();
      await h.provider.stop();
    }
  },
);

function failTerminalWrites(mode: "once" | "always") {
  const original = callStore.persistCallRecord;
  let failures = 0;
  return vi.spyOn(callStore, "persistCallRecord").mockImplementation(async (...args) => {
    if (args[1].endedAt && (mode === "always" || failures++ === 0)) {
      throw new Error("Synthetic terminal persistence failure");
    }
    await original(...args);
  });
}

it.each(["during-stop", "before-stop"] as const)(
  "retries failed terminal persistence at shutdown after successful carrier disposal (%s)",
  async (when) => {
    const h = await fixture();
    h.finishClose.resolve();
    const write = failTerminalWrites("once");
    try {
      if (when === "before-stop") {
        await expect(h.manager.endCall(h.callId)).resolves.toMatchObject({ success: false });
        expect(h.manager.getCall(h.callId)).toBeDefined();
      }
      await h.provider.stop();
      // Carrier disposal succeeded earlier; shutdown must not report success while
      // the manager still owns an unterminated record.
      expect(h.manager.getCall(h.callId)).toBeUndefined();
      expect((await callStore.findCallInStore(h.storePath, h.callId))?.state).toBe("completed");
      expect(h.rooms.deleteRoom).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
      await h.handler.close();
    }
  },
);

it("rejects shutdown when terminal persistence keeps failing after carrier disposal", async () => {
  const h = await fixture();
  h.finishClose.resolve();
  const write = failTerminalWrites("always");
  try {
    await expect(h.provider.stop()).rejects.toThrow("failed during shutdown");
    expect(h.manager.getCall(h.callId)).toBeDefined();
  } finally {
    write.mockRestore();
    await h.handler.close();
  }
});

it("keeps the manager owner when a cancelled admission's late final write fails", async () => {
  const h = await fixture({ holdAttachedAdmission: true });
  h.finishClose.resolve();
  const original = callStore.persistCallRecord;
  let failedFinal = false;
  const write = vi.spyOn(callStore, "persistCallRecord").mockImplementation(async (...args) => {
    if (!failedFinal && args[1].transcript.some((entry) => entry.text === "Late assistant final")) {
      failedFinal = true;
      throw new Error("Synthetic final persistence failure");
    }
    await original(...args);
  });
  try {
    const hangup = h.manager.endCall(h.callId, { reason: "completed" });
    await nextEventLoopTurn();
    h.releaseAttach.resolve();
    expect(await hangup).toMatchObject({ success: false, error: "LiveKit RTC disconnect failed" });
    expect((await h.placementWork).success).toBe(false);
    expect(failedFinal).toBe(true);
    // The generic dial-failure catch must not terminalize over the lost final.
    expect(h.manager.getCall(h.callId)).toBeDefined();
    expect((await callStore.findCallInStore(h.storePath, h.callId))?.endedAt).toBeUndefined();
    await expect(h.provider.stop()).rejects.toThrow("cleanup failed during shutdown");
  } finally {
    h.releaseAttach.resolve();
    write.mockRestore();
    await h.placementWork;
    await h.handler.close();
  }
});
