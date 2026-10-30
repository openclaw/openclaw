import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { convertPcmToMulaw8k, mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  RealtimeCallCleanupError,
  type RealtimeCallHandler,
  type RealtimeMediaTransport,
  type RealtimeRoomBinding,
} from "../webhook/realtime-handler.js";

export type LiveKitAudioConnection = { close: () => Promise<void> };
/** A failed admission still owes a provider/transcript drain, not just room deletion. */
export class LiveKitAudioCleanupError extends Error {
  constructor() {
    super("LiveKit RTC audio cleanup failed");
  }
}
export type LiveKitAudioParams = {
  url: string;
  token: string;
  room: string;
  identity: string;
  participantSid?: string;
  callId: string;
  handler: Pick<RealtimeCallHandler, "attachRoomTransport">;
  isCurrent: () => boolean;
  onDisconnect: (reason: "completed" | "error") => void;
};

/** Native supported RTC SDK, not SIP-as-WebSocket or a browser-only shim. */
export async function connectLiveKitAudio(
  params: LiveKitAudioParams,
): Promise<LiveKitAudioConnection> {
  const rtc = await import("@livekit/rtc-node");
  const room = new rtc.Room();
  const source = new rtc.AudioSource(8000, 1, 200);
  let binding: RealtimeRoomBinding | null = null;
  let closed = false;
  let connected = false;
  let generation = 0;
  let bufferedAmount = 0;
  let output = Promise.resolve();
  const marks = new Set<ReturnType<typeof setTimeout>>();
  const clearMarks = () => {
    for (const timer of marks) {
      clearTimeout(timer);
    }
    marks.clear();
  };
  let closePromise: Promise<void> | undefined;
  let connectPromise: Promise<void> | undefined;
  const readers = new Set<ReadableStreamDefaultReader<InstanceType<typeof rtc.AudioFrame>>>();
  const tasks = new Set<Promise<void>>();
  // Active reader per subscribed track SID. A resubscription reuses the SID with a
  // new track object, so ownership is retired on unsubscribe/completion, not kept for life.
  const trackReaders = new Map<
    string,
    ReadableStreamDefaultReader<InstanceType<typeof rtc.AudioFrame>>
  >();
  const current = () => !closed && params.isCurrent();
  const close = (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }
    closed = true;
    generation++;
    clearMarks();
    source.clearQueue();
    room.removeAllListeners();
    // Publish the owner before binding disposal can reenter transport.close.
    // Carrier cleanup and the stock transcript drain are independent obligations.
    const completion = createDeferred<void>();
    closePromise = completion.promise;
    const disposal = binding?.endCall();
    const work = (async () => {
      const results = await Promise.allSettled([
        disposal,
        (async () => {
          await Promise.allSettled([...readers].map((reader) => reader.cancel()));
          await connectPromise?.catch(() => {});
          try {
            await room.disconnect();
          } finally {
            await output.catch(() => {});
            await source.close();
            await Promise.allSettled(tasks);
          }
        })(),
      ]);
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        throw new AggregateError(
          failures.map((result) => result.reason),
          "LiveKit audio cleanup failed",
        );
      }
    })();
    void work.then(completion.resolve, completion.reject);
    return closePromise;
  };
  const disconnected = (reason: "completed" | "error" = "completed") => {
    if (closed) {
      return;
    }
    params.onDisconnect(reason);
    void close().catch(() => {});
  };
  const transport: RealtimeMediaTransport = {
    get readyState() {
      return current() && connected ? 1 : 3;
    },
    get bufferedAmount() {
      return bufferedAmount;
    },
    close: (code) => {
      if (closed) {
        return;
      }
      params.onDisconnect(code === 1008 || code === 1011 || code === 1013 ? "error" : "completed");
      void close().catch(() => {});
    },
    send: (raw) => {
      if (!current()) {
        return;
      }
      const frame = asOptionalRecord(JSON.parse(raw));
      if (!frame) {
        return;
      }
      const media = asOptionalRecord(frame.media);
      const mark = asOptionalRecord(frame.mark);
      if (frame.event === "clear") {
        generation++;
        source.clearQueue();
        clearMarks();
        return;
      }
      const owner = generation;
      if (frame.event === "media" && typeof media?.payload === "string") {
        const pcm = mulawToPcm(Buffer.from(media.payload, "base64"));
        const samples = new Int16Array(pcm.length / 2);
        for (let i = 0; i < samples.length; i++) {
          samples[i] = pcm.readInt16LE(i * 2);
        }
        bufferedAmount += pcm.length;
        output = output
          .then(async () => {
            try {
              if (current() && owner === generation) {
                await source.captureFrame(new rtc.AudioFrame(samples, 8000, 1, samples.length));
              }
            } finally {
              bufferedAmount -= pcm.length;
            }
          })
          .catch(() => disconnected("error"));
      } else if (frame.event === "mark" && typeof mark?.name === "string") {
        const name = mark.name;
        // Capture ordering fixes the mark's native queue position. queuedDuration
        // is milliseconds; later captures re-arm the SDK drain waiter, so never
        // use waitForPlayout for a prefix acknowledgement.
        void output
          .then(() => {
            if (!current() || owner !== generation) {
              return;
            }
            const delayMs = Math.max(0, Math.ceil(source.queuedDuration));
            const timer = setTimeout(() => {
              marks.delete(timer);
              if (current() && owner === generation) {
                binding?.acknowledgeMark(name);
              }
            }, delayMs);
            marks.add(timer);
          })
          .catch(() => disconnected("error"));
      }
    },
  };
  const subscribe = (participant: InstanceType<typeof rtc.RemoteParticipant>) => {
    if (!current()) {
      return;
    }
    if (
      participant.identity !== params.identity ||
      (params.participantSid && participant.sid !== params.participantSid)
    ) {
      // A call room must never gain a third peer that could receive assistant speech.
      disconnected("error");
      return;
    }
    for (const publication of participant.trackPublications.values()) {
      if (publication.kind === rtc.TrackKind.KIND_AUDIO) {
        publication.setSubscribed(true);
      }
    }
  };
  room.on(rtc.RoomEvent.ParticipantConnected, subscribe);
  room.on(rtc.RoomEvent.TrackPublished, (_publication, participant) => subscribe(participant));
  room.on(rtc.RoomEvent.ParticipantDisconnected, (participant) => {
    if (participant.identity === params.identity) {
      disconnected();
    }
  });
  room.on(rtc.RoomEvent.Disconnected, () => disconnected());
  room.on(rtc.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (
      !current() ||
      participant.identity !== params.identity ||
      (params.participantSid && participant.sid !== params.participantSid) ||
      track.kind !== rtc.TrackKind.KIND_AUDIO ||
      !track.sid ||
      trackReaders.has(track.sid)
    ) {
      return;
    }
    const sid = track.sid;
    const reader = new rtc.AudioStream(track, {
      sampleRate: 8000,
      numChannels: 1,
      frameSizeMs: 20,
    }).getReader();
    trackReaders.set(sid, reader);
    readers.add(reader);
    const task = (async () => {
      try {
        while (current()) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (!current() || !value) {
            continue;
          }
          const pcm = Buffer.alloc(value.data.length * 2);
          for (let i = 0; i < value.data.length; i++) {
            pcm.writeInt16LE(value.data[i]!, i * 2);
          }
          binding?.sendAudio(convertPcmToMulaw8k(pcm, value.sampleRate));
        }
      } catch {
        disconnected("error");
      } finally {
        readers.delete(reader);
        // Exact-owner check: a retired reader must not unregister its replacement.
        if (trackReaders.get(sid) === reader) {
          trackReaders.delete(sid);
        }
        reader.releaseLock();
      }
    })();
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  room.on(rtc.RoomEvent.TrackUnsubscribed, (track) => {
    const reader = track.sid ? trackReaders.get(track.sid) : undefined;
    if (track.sid && reader) {
      trackReaders.delete(track.sid);
      void reader.cancel().catch(() => {});
    }
  });
  try {
    // The SDK import may outlive manager admission. A room JWT is still valid
    // after retirement, so revalidate before submitting the native connection.
    if (!current()) {
      throw new Error("RTC room admission cancelled");
    }
    connectPromise = room.connect(params.url, params.token, {
      autoSubscribe: false,
      dynacast: false,
    });
    await connectPromise;
    connected = true;
    if (!current() || room.name !== params.room) {
      throw new Error("RTC room admission cancelled");
    }
    const participant = room.remoteParticipants.get(params.identity);
    if (
      room.remoteParticipants.size !== 1 ||
      !participant ||
      (params.participantSid && participant.sid !== params.participantSid)
    ) {
      throw new Error("RTC SIP participant correlation failed");
    }
    const local = room.localParticipant;
    if (!local) {
      throw new Error("RTC local participant unavailable");
    }
    await local.publishTrack(
      rtc.LocalAudioTrack.createAudioTrack("openclaw-voice", source),
      new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }),
    );
    if (!current()) {
      throw new Error("RTC room admission cancelled");
    }
    binding = await params.handler.attachRoomTransport({
      callId: params.callId,
      providerCallId: params.room,
      streamId: `rtc:${params.room}`,
      transport,
    });
    if (!binding || !current()) {
      // Native disconnect can finish before attachment returns its binding.
      // That late binding still owns provider finals and must be joined here.
      try {
        await binding?.endCall();
      } catch {
        throw new LiveKitAudioCleanupError();
      }
      throw new Error("Realtime call admission failed");
    }
    subscribe(participant);
    return { close };
  } catch (error) {
    try {
      await close();
    } catch {
      throw new LiveKitAudioCleanupError();
    }
    if (error instanceof LiveKitAudioCleanupError) {
      throw error;
    }
    if (error instanceof RealtimeCallCleanupError) {
      throw new LiveKitAudioCleanupError();
    }
    // Do not return vendor errors containing URL/token material.
    throw new Error("LiveKit RTC audio connection failed", { cause: error });
  }
}
