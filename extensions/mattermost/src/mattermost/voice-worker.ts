// Mattermost plugin module coordinates persistent voice call sessions and turns.
import { createVoiceCapture } from "./voice-audio.js";

const CALLS_EVENT_PREFIX = "custom_com.mattermost.calls_";
const PLAYBACK_INTERRUPT_MILLISECONDS = 2_000;
const PLAYBACK_STALL_TIMEOUT_MILLISECONDS = 10_000;

export type MattermostVoiceCallCallbacks = {
  onAudio: (event: { sessionId: string; samples: Int16Array }) => void;
  onVoice: (event: { sessionId: string; userId: string; speaking: boolean }) => void;
};

export type MattermostVoiceReplyAudio = {
  audioPath: string;
  durationMilliseconds?: number;
  release?: () => Promise<void> | void;
};

type MattermostVoicePlaybackOptions = {
  signal?: AbortSignal;
};

export type MattermostVoiceCallSession = {
  play: (
    audio: MattermostVoiceReplyAudio,
    options?: MattermostVoicePlaybackOptions,
  ) => Promise<void>;
  close: () => Promise<void>;
};

type MattermostCallsEvent = {
  event?: string;
  data?: {
    channel_id?: string;
    channelID?: string;
    id?: string;
    userID?: string;
    user_id?: string;
  };
  broadcast?: {
    channel_id?: string;
  };
};

type MattermostVoiceWorker = {
  handleEvent: (event: MattermostCallsEvent) => Promise<void>;
  waitForIdle: () => Promise<void>;
  close: () => Promise<void>;
};

type ActiveCall = {
  channelId: string;
  session: MattermostVoiceCallSession;
};

type PlaybackState = {
  call: ActiveCall;
  controller: AbortController;
  interruptSessionId?: string;
  interruptTimer?: ReturnType<typeof setTimeout>;
  interruptUserId?: string;
};

export function createMattermostVoiceWorker(params: {
  authorizeJoin: (params: { channelId: string; userId: string }) => Promise<boolean>;
  botUserId: string;
  maxSpeechSamples: number;
  playbackTimeoutMilliseconds?: number;
  preRollFrames: number;
  resolveChannelType: (channelId: string) => Promise<string | undefined>;
  connect: (params: {
    channelId: string;
    callbacks: MattermostVoiceCallCallbacks;
  }) => Promise<MattermostVoiceCallSession>;
  processTurn: (params: {
    channelId: string;
    userId: string;
    samples: Int16Array;
  }) => Promise<MattermostVoiceReplyAudio | undefined>;
  onDebug?: (message: string) => void;
  onError?: (message: string) => void;
}): MattermostVoiceWorker {
  const captures = new Map<string, ReturnType<typeof createVoiceCapture>>();
  let activeCall: ActiveCall | undefined;
  let pendingChannelId: string | undefined;
  let lifecycleGeneration = 0;
  let playback: PlaybackState | undefined;
  let playing = false;
  let turnTail = Promise.resolve();
  const resolvePlaybackTimeoutMilliseconds = (reply: MattermostVoiceReplyAudio) => {
    if (params.playbackTimeoutMilliseconds !== undefined) {
      return Math.max(1, params.playbackTimeoutMilliseconds);
    }
    const duration = reply.durationMilliseconds;
    return typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? Math.ceil(duration + PLAYBACK_STALL_TIMEOUT_MILLISECONDS)
      : undefined;
  };

  const getCapture = (sessionId: string) => {
    const existing = captures.get(sessionId);
    if (existing) {
      return existing;
    }
    const capture = createVoiceCapture({
      maxSpeechSamples: params.maxSpeechSamples,
      preRollFrames: params.preRollFrames,
    });
    captures.set(sessionId, capture);
    return capture;
  };

  const setPlaybackSuppressed = (suppressed: boolean) => {
    playing = suppressed;
    for (const capture of captures.values()) {
      capture.setSuppressed(suppressed);
    }
  };

  const clearPlaybackInterruptTimer = (state: PlaybackState | undefined) => {
    if (!state?.interruptTimer) {
      return;
    }
    clearTimeout(state.interruptTimer);
    state.interruptTimer = undefined;
    state.interruptSessionId = undefined;
    state.interruptUserId = undefined;
  };

  const schedulePlaybackInterrupt = (event: { sessionId: string; userId: string }) => {
    const state = playback;
    if (!state || state.controller.signal.aborted) {
      return;
    }
    if (
      state.interruptTimer &&
      state.interruptSessionId === event.sessionId &&
      state.interruptUserId === event.userId
    ) {
      return;
    }
    clearPlaybackInterruptTimer(state);
    state.interruptSessionId = event.sessionId;
    state.interruptUserId = event.userId;
    state.interruptTimer = setTimeout(() => {
      if (playback !== state || activeCall !== state.call || state.controller.signal.aborted) {
        return;
      }
      clearPlaybackInterruptTimer(state);
      state.controller.abort();
      setPlaybackSuppressed(false);
      getCapture(event.sessionId).start();
    }, PLAYBACK_INTERRUPT_MILLISECONDS);
    state.interruptTimer.unref?.();
  };

  const clearMatchingPlaybackInterrupt = (event: { sessionId: string; userId: string }) => {
    const state = playback;
    if (state?.interruptSessionId === event.sessionId && state.interruptUserId === event.userId) {
      clearPlaybackInterruptTimer(state);
    }
  };

  const callbacks: MattermostVoiceCallCallbacks = {
    onAudio(event) {
      if (playing) {
        return;
      }
      getCapture(event.sessionId).push(event.samples);
    },
    onVoice(event) {
      if (event.userId === params.botUserId) {
        return;
      }
      if (playing) {
        if (event.speaking) {
          schedulePlaybackInterrupt(event);
        } else {
          clearMatchingPlaybackInterrupt(event);
        }
        return;
      }
      const capture = getCapture(event.sessionId);
      if (event.speaking) {
        capture.start();
        return;
      }
      const samples = capture.stop();
      const call = activeCall;
      if (!call || samples.length === 0) {
        return;
      }
      turnTail = turnTail
        .then(async () => {
          params.onDebug?.(
            `mattermost voice turn start channel=${call.channelId} speaker=${event.userId} samples=${samples.length}`,
          );
          const reply = await params.processTurn({
            channelId: call.channelId,
            userId: event.userId,
            samples,
          });
          if (!reply || activeCall !== call) {
            await reply?.release?.();
            params.onDebug?.(
              `mattermost voice turn skipped channel=${call.channelId} speaker=${event.userId} reason=${reply ? "stale-call" : "no-reply"}`,
            );
            return;
          }
          const controller = new AbortController();
          const state: PlaybackState = { call, controller };
          playback = state;
          setPlaybackSuppressed(true);
          const playbackTimeoutMilliseconds = resolvePlaybackTimeoutMilliseconds(reply);
          let playbackTimeout: ReturnType<typeof setTimeout> | undefined;
          let timedOut = false;
          const playbackFinished = call.session
            .play(reply, { signal: controller.signal })
            .catch((error: unknown) => {
              if (!timedOut) {
                throw error;
              }
              params.onError?.(`mattermost voice playback failed after timeout: ${String(error)}`);
            });
          try {
            params.onDebug?.(
              `mattermost voice playback start channel=${call.channelId} speaker=${event.userId}`,
            );
            const playbackTimedOut =
              playbackTimeoutMilliseconds === undefined
                ? undefined
                : new Promise<"timeout">((resolve) => {
                    playbackTimeout = setTimeout(() => {
                      timedOut = true;
                      controller.abort();
                      resolve("timeout");
                    }, playbackTimeoutMilliseconds);
                    playbackTimeout.unref?.();
                  });
            const outcome = await Promise.race(
              playbackTimedOut
                ? [playbackFinished.then(() => "finished" as const), playbackTimedOut]
                : [playbackFinished.then(() => "finished" as const)],
            );
            if (outcome === "timeout") {
              params.onError?.(
                `mattermost voice playback timed out after ${playbackTimeoutMilliseconds}ms`,
              );
            } else {
              params.onDebug?.(
                `mattermost voice playback finished channel=${call.channelId} speaker=${event.userId}`,
              );
            }
          } finally {
            if (playbackTimeout) {
              clearTimeout(playbackTimeout);
            }
            if (playback === state) {
              playback = undefined;
            }
            clearPlaybackInterruptTimer(state);
            setPlaybackSuppressed(false);
            await reply.release?.();
          }
        })
        .catch((error: unknown) => {
          params.onError?.(`mattermost voice turn failed: ${String(error)}`);
        });
    },
  };

  const closeActiveCall = async () => {
    const call = activeCall;
    activeCall = undefined;
    if (playback) {
      const state = playback;
      playback = undefined;
      clearPlaybackInterruptTimer(state);
      state.controller.abort();
    }
    captures.clear();
    setPlaybackSuppressed(false);
    await call?.session.close();
  };

  return {
    async handleEvent(event) {
      if (!event.event?.startsWith(CALLS_EVENT_PREFIX)) {
        return;
      }
      const eventName = event.event.slice(CALLS_EVENT_PREFIX.length);
      const channelId =
        event.data?.channelID ?? event.data?.channel_id ?? event.broadcast?.channel_id;
      if (eventName === "user_joined" || eventName === "call_end") {
        const userId = event.data?.user_id ?? event.data?.userID;
        params.onDebug?.(
          `mattermost voice event=${eventName} channel=${channelId ?? "unknown"} user=${userId ?? "unknown"}`,
        );
      }
      if (!channelId) {
        return;
      }
      if (eventName === "call_end") {
        if (activeCall?.channelId === channelId || pendingChannelId === channelId) {
          lifecycleGeneration += 1;
          pendingChannelId = undefined;
          await closeActiveCall();
        }
        return;
      }
      const joinedUserId = event.data?.user_id ?? event.data?.userID;
      const humanJoined =
        eventName === "user_joined" && Boolean(joinedUserId) && joinedUserId !== params.botUserId;
      if (!humanJoined || !joinedUserId) {
        return;
      }
      if (activeCall?.channelId === channelId || pendingChannelId === channelId) {
        return;
      }
      if ((await params.resolveChannelType(channelId))?.toUpperCase() !== "D") {
        return;
      }
      if (!(await params.authorizeJoin({ channelId, userId: joinedUserId }))) {
        return;
      }
      if (activeCall?.channelId === channelId || pendingChannelId === channelId) {
        return;
      }
      const generation = ++lifecycleGeneration;
      pendingChannelId = channelId;
      await closeActiveCall();
      let session: MattermostVoiceCallSession;
      try {
        session = await params.connect({ channelId, callbacks });
      } catch (error) {
        if (generation === lifecycleGeneration) {
          pendingChannelId = undefined;
        }
        throw error;
      }
      // Call end and shutdown can race the async WebRTC join. Never retain a
      // connection that belongs to an older lifecycle generation.
      if (generation !== lifecycleGeneration) {
        await session.close();
        return;
      }
      pendingChannelId = undefined;
      activeCall = { channelId, session };
    },
    async waitForIdle() {
      await turnTail;
    },
    async close() {
      lifecycleGeneration += 1;
      pendingChannelId = undefined;
      await closeActiveCall();
      await turnTail;
    },
  };
}
