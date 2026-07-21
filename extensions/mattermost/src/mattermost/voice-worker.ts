// Mattermost plugin module coordinates persistent voice call sessions and turns.
import { createVoiceCapture } from "./voice-audio.js";

const CALLS_EVENT_PREFIX = "custom_com.mattermost.calls_";
const PLAYBACK_INTERRUPT_MILLISECONDS = 2_000;
const PLAYBACK_STALL_TIMEOUT_MILLISECONDS = 10_000;
const RECONNECT_RETRY_DELAYS_MILLISECONDS = [1_000, 2_000, 5_000, 10_000] as const;

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
  closed?: Promise<void>;
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
  userId: string;
};

type PlaybackState = {
  call: ActiveCall;
  controller: AbortController;
  interruptSessionId?: string;
  interruptTimer?: ReturnType<typeof setTimeout>;
  interruptUserId?: string;
};

type ActiveGeneration = {
  call: ActiveCall;
  controller: AbortController;
  id: number;
};

type PendingTranscript = {
  call: ActiveCall;
  clearBatchIfEmpty?: boolean;
  transcript?: string;
  userId: string;
};

type PlaybackOutcome = "finished" | "timeout" | "aborted" | "failed";

type PlaybackCaptureGuard = {
  interrupted: boolean;
  userId: string;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
    abortSignal?: AbortSignal;
    channelId: string;
    message: string;
    userId: string;
  }) => Promise<MattermostVoiceReplyAudio | undefined>;
  transcribeTurn: (params: {
    channelId: string;
    userId: string;
    samples: Int16Array;
  }) => Promise<string | undefined>;
  reconnectRetryDelaysMs?: readonly number[];
  sleep?: (milliseconds: number) => Promise<void>;
  onDebug?: (message: string) => void;
  onError?: (message: string) => void;
}): MattermostVoiceWorker {
  const captures = new Map<string, ReturnType<typeof createVoiceCapture>>();
  let activeCall: ActiveCall | undefined;
  let pendingChannelId: string | undefined;
  let pendingOwnerId = 0;
  let lifecycleGeneration = 0;
  let playback: PlaybackState | undefined;
  let activeGeneration: ActiveGeneration | undefined;
  let playing = false;
  let generationId = 0;
  let nextUtteranceId = 1;
  let nextTranscriptId = 1;
  const pendingTasks = new Set<Promise<void>>();
  const pendingLifecycleTasks = new Set<Promise<void>>();
  const pendingTranscripts = new Map<number, PendingTranscript>();
  const playbackCaptureGuards = new Map<string, PlaybackCaptureGuard>();
  let voiceBatch: string[] = [];
  const sleep = params.sleep ?? delay;
  const reconnectRetryDelays = params.reconnectRetryDelaysMs?.length
    ? params.reconnectRetryDelaysMs
    : RECONNECT_RETRY_DELAYS_MILLISECONDS;
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

  const reservePendingChannel = (channelId: string) => {
    pendingOwnerId += 1;
    pendingChannelId = channelId;
    return pendingOwnerId;
  };

  const clearPendingChannel = (ownerId: number, channelId: string) => {
    if (pendingOwnerId === ownerId && pendingChannelId === channelId) {
      pendingChannelId = undefined;
    }
  };

  const cancelPendingChannel = (channelId: string) => {
    if (pendingChannelId !== channelId) {
      return false;
    }
    pendingOwnerId += 1;
    pendingChannelId = undefined;
    return true;
  };

  const trackTask = (task: Promise<void>) => {
    pendingTasks.add(task);
    void task.then(
      () => pendingTasks.delete(task),
      () => pendingTasks.delete(task),
    );
  };

  const trackLifecycleTask = (task: Promise<void>) => {
    pendingLifecycleTasks.add(task);
    void task.then(
      () => pendingLifecycleTasks.delete(task),
      () => pendingLifecycleTasks.delete(task),
    );
  };

  const waitForTrackedTasks = async () => {
    while (pendingTasks.size > 0) {
      await Promise.all([...pendingTasks]);
    }
  };

  const waitForLifecycleTasks = async () => {
    while (pendingLifecycleTasks.size > 0) {
      await Promise.all([...pendingLifecycleTasks]);
    }
  };

  const setPlaybackActive = (active: boolean) => {
    playing = active;
  };

  const clearInactiveCapturePreRoll = () => {
    for (const capture of captures.values()) {
      capture.clearInactivePreRoll();
    }
  };

  const playbackCaptureKey = (event: { sessionId: string; userId: string }) =>
    `${event.sessionId}\0${event.userId}`;

  const consumePlaybackCaptureGuard = (event: { sessionId: string; userId: string }) => {
    const key = playbackCaptureKey(event);
    const guard = playbackCaptureGuards.get(key);
    playbackCaptureGuards.delete(key);
    return guard;
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

  const abortPlayback = () => {
    const state = playback;
    if (!state) {
      return;
    }
    playback = undefined;
    clearPlaybackInterruptTimer(state);
    state.controller.abort();
    setPlaybackActive(false);
    clearInactiveCapturePreRoll();
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
      const guard = playbackCaptureGuards.get(playbackCaptureKey(event));
      if (guard?.userId === event.userId) {
        guard.interrupted = true;
      }
      abortPlayback();
    }, PLAYBACK_INTERRUPT_MILLISECONDS);
    state.interruptTimer.unref?.();
  };

  const clearMatchingPlaybackInterrupt = (event: { sessionId: string; userId: string }) => {
    const state = playback;
    if (state?.interruptSessionId === event.sessionId && state.interruptUserId === event.userId) {
      clearPlaybackInterruptTimer(state);
    }
  };

  const playReply = async (paramsForPlayback: {
    call: ActiveCall;
    reply: MattermostVoiceReplyAudio;
    userId: string;
  }): Promise<PlaybackOutcome> => {
    const { call, reply, userId } = paramsForPlayback;
    const controller = new AbortController();
    const state: PlaybackState = { call, controller };
    clearInactiveCapturePreRoll();
    playback = state;
    setPlaybackActive(true);
    const playbackTimeoutMilliseconds = resolvePlaybackTimeoutMilliseconds(reply);
    let playbackTimeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const playbackFinished = call.session
      .play(reply, { signal: controller.signal })
      .then((): PlaybackOutcome => {
        if (timedOut) {
          return "timeout";
        }
        return controller.signal.aborted ? "aborted" : "finished";
      })
      .catch((error: unknown): PlaybackOutcome => {
        if (timedOut) {
          params.onError?.(`mattermost voice playback failed after timeout: ${String(error)}`);
          return "timeout";
        }
        if (controller.signal.aborted) {
          return "aborted";
        }
        params.onError?.(`mattermost voice playback failed: ${String(error)}`);
        return "failed";
      });
    try {
      params.onDebug?.(
        `mattermost voice playback start channel=${call.channelId} speaker=${userId}`,
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
        playbackTimedOut ? [playbackFinished, playbackTimedOut] : [playbackFinished],
      );
      if (outcome === "timeout") {
        params.onError?.(
          `mattermost voice playback timed out after ${playbackTimeoutMilliseconds}ms`,
        );
      } else if (outcome === "finished") {
        params.onDebug?.(
          `mattermost voice playback finished channel=${call.channelId} speaker=${userId}`,
        );
      }
      return outcome;
    } finally {
      if (playbackTimeout) {
        clearTimeout(playbackTimeout);
      }
      if (playback === state) {
        playback = undefined;
        setPlaybackActive(false);
        clearInactiveCapturePreRoll();
      }
      clearPlaybackInterruptTimer(state);
      await releaseReply(reply);
    }
  };

  const isCurrentGeneration = (generation: ActiveGeneration) =>
    activeGeneration?.id === generation.id &&
    activeGeneration.controller === generation.controller &&
    activeCall === generation.call;

  const releaseReply = async (reply: MattermostVoiceReplyAudio | undefined) => {
    try {
      await reply?.release?.();
    } catch (error) {
      params.onError?.(`mattermost voice playback release failed: ${String(error)}`);
    }
  };

  const runGeneration = async (generation: ActiveGeneration, userId: string, message: string) => {
    try {
      params.onDebug?.(
        `mattermost voice turn start channel=${generation.call.channelId} speaker=${userId} chars=${message.length}`,
      );
      let reply: MattermostVoiceReplyAudio | undefined;
      try {
        reply = await params.processTurn({
          abortSignal: generation.controller.signal,
          channelId: generation.call.channelId,
          message,
          userId,
        });
      } catch (error) {
        if (!generation.controller.signal.aborted && isCurrentGeneration(generation)) {
          voiceBatch = [];
          params.onError?.(`mattermost voice turn failed: ${String(error)}`);
        }
        return;
      }
      if (!isCurrentGeneration(generation) || generation.controller.signal.aborted) {
        await releaseReply(reply);
        params.onDebug?.(
          `mattermost voice turn skipped channel=${generation.call.channelId} speaker=${userId} reason=stale-generation`,
        );
        return;
      }
      if (!reply) {
        voiceBatch = [];
        params.onDebug?.(
          `mattermost voice turn skipped channel=${generation.call.channelId} speaker=${userId} reason=no-reply`,
        );
        return;
      }
      const outcome = await playReply({ call: generation.call, reply, userId });
      if (isCurrentGeneration(generation) && outcome !== "aborted") {
        voiceBatch = [];
      }
    } finally {
      if (activeGeneration?.id === generation.id) {
        activeGeneration = undefined;
      }
    }
  };

  const restartGeneration = (call: ActiveCall, userId: string) => {
    if (activeCall !== call || voiceBatch.length === 0) {
      return;
    }
    activeGeneration?.controller.abort();
    abortPlayback();
    const generation: ActiveGeneration = {
      call,
      controller: new AbortController(),
      id: ++generationId,
    };
    activeGeneration = generation;
    const message = voiceBatch.join("\n\n");
    trackTask(runGeneration(generation, userId, message));
  };

  const flushReadyTranscripts = () => {
    let restartFrom: PendingTranscript | undefined;
    for (;;) {
      const pending = pendingTranscripts.get(nextTranscriptId);
      if (!pending) {
        break;
      }
      pendingTranscripts.delete(nextTranscriptId);
      nextTranscriptId += 1;
      if (pending.call !== activeCall) {
        continue;
      }
      if (!pending.transcript) {
        if (pending.clearBatchIfEmpty) {
          voiceBatch = [];
        }
        continue;
      }
      voiceBatch.push(pending.transcript);
      restartFrom = pending;
    }
    if (restartFrom) {
      restartGeneration(restartFrom.call, restartFrom.userId);
    }
  };

  const handleCapturedUtterance = async (paramsForUtterance: {
    call: ActiveCall;
    clearBatchIfEmpty?: boolean;
    samples: Int16Array;
    userId: string;
    utteranceId: number;
  }) => {
    const { call, clearBatchIfEmpty, samples, userId, utteranceId } = paramsForUtterance;
    let transcript: string | undefined;
    try {
      params.onDebug?.(
        `mattermost voice transcription start channel=${call.channelId} speaker=${userId} samples=${samples.length}`,
      );
      transcript = await params.transcribeTurn({
        channelId: call.channelId,
        userId,
        samples,
      });
    } catch (error) {
      params.onError?.(`mattermost voice transcription failed: ${String(error)}`);
    }
    if (activeCall !== call) {
      return;
    }
    pendingTranscripts.set(utteranceId, { call, clearBatchIfEmpty, transcript, userId });
    flushReadyTranscripts();
  };

  const callbacks: MattermostVoiceCallCallbacks = {
    onAudio(event) {
      getCapture(event.sessionId).push(event.samples);
    },
    onVoice(event) {
      if (event.userId === params.botUserId) {
        return;
      }
      const capture = getCapture(event.sessionId);
      if (event.speaking) {
        if (playing) {
          capture.clearInactivePreRoll();
        }
        const started = capture.start();
        if (!playing && started) {
          playbackCaptureGuards.delete(playbackCaptureKey(event));
        }
        if (playing && started) {
          const key = playbackCaptureKey(event);
          if (!playbackCaptureGuards.has(key)) {
            playbackCaptureGuards.set(key, { interrupted: false, userId: event.userId });
          }
          schedulePlaybackInterrupt(event);
        }
        return;
      }
      const samples = capture.stop();
      const playbackGuard = consumePlaybackCaptureGuard(event);
      if (playing && playbackGuard) {
        clearMatchingPlaybackInterrupt(event);
        return;
      }
      clearMatchingPlaybackInterrupt(event);
      if (playbackGuard && !playbackGuard.interrupted) {
        return;
      }
      const call = activeCall;
      if (!call || samples.length === 0) {
        return;
      }
      const utteranceId = nextUtteranceId;
      nextUtteranceId += 1;
      trackTask(
        handleCapturedUtterance({
          call,
          clearBatchIfEmpty: playbackGuard?.interrupted === true,
          samples,
          userId: event.userId,
          utteranceId,
        }),
      );
    },
  };

  const resetActiveCall = async (options: { closeSession: boolean }) => {
    const call = activeCall;
    activeCall = undefined;
    activeGeneration?.controller.abort();
    activeGeneration = undefined;
    abortPlayback();
    captures.clear();
    pendingTranscripts.clear();
    playbackCaptureGuards.clear();
    voiceBatch = [];
    nextUtteranceId = 1;
    nextTranscriptId = 1;
    setPlaybackActive(false);
    if (options.closeSession) {
      await call?.session.close();
    }
  };

  const connectActiveCall = async (paramsForCall: {
    channelId: string;
    generation: number;
    userId: string;
  }) => {
    const { channelId, generation, userId } = paramsForCall;
    const pendingOwner = reservePendingChannel(channelId);
    await resetActiveCall({ closeSession: true });
    if (
      generation !== lifecycleGeneration ||
      pendingOwnerId !== pendingOwner ||
      pendingChannelId !== channelId
    ) {
      return;
    }
    let session: MattermostVoiceCallSession;
    try {
      session = await params.connect({ channelId, callbacks });
    } catch (error) {
      clearPendingChannel(pendingOwner, channelId);
      throw error;
    }
    // Call end and shutdown can race the async WebRTC join. Never retain a
    // connection that belongs to an older lifecycle generation.
    if (
      generation !== lifecycleGeneration ||
      pendingOwnerId !== pendingOwner ||
      pendingChannelId !== channelId
    ) {
      await session.close();
      return;
    }
    const call: ActiveCall = { channelId, session, userId };
    clearPendingChannel(pendingOwner, channelId);
    activeCall = call;
    watchSessionClosed(call);
  };

  const handleSessionClosed = async (call: ActiveCall) => {
    if (activeCall !== call) {
      return;
    }
    if (pendingChannelId && pendingChannelId !== call.channelId) {
      await resetActiveCall({ closeSession: false });
      return;
    }
    params.onDebug?.(
      `mattermost voice call session closed channel=${call.channelId}; reconnecting`,
    );
    const generation = ++lifecycleGeneration;
    let pendingOwner = reservePendingChannel(call.channelId);
    await resetActiveCall({ closeSession: false });
    if (
      generation !== lifecycleGeneration ||
      pendingOwnerId !== pendingOwner ||
      pendingChannelId !== call.channelId
    ) {
      return;
    }
    let attempt = 0;
    for (;;) {
      if (
        generation !== lifecycleGeneration ||
        pendingOwnerId !== pendingOwner ||
        pendingChannelId !== call.channelId
      ) {
        return;
      }
      let retrying = false;
      try {
        if ((await params.resolveChannelType(call.channelId))?.toUpperCase() !== "D") {
          return;
        }
        if (
          generation !== lifecycleGeneration ||
          pendingOwnerId !== pendingOwner ||
          pendingChannelId !== call.channelId
        ) {
          return;
        }
        if (!(await params.authorizeJoin({ channelId: call.channelId, userId: call.userId }))) {
          return;
        }
        if (generation === lifecycleGeneration) {
          await connectActiveCall({
            channelId: call.channelId,
            generation,
            userId: call.userId,
          });
        }
        return;
      } catch (error) {
        if (generation !== lifecycleGeneration) {
          return;
        }
        params.onError?.(
          `mattermost voice reconnect failed channel=${call.channelId}: ${String(error)}`,
        );
        const retryDelay = reconnectRetryDelays[attempt];
        if (retryDelay === undefined) {
          params.onError?.(`mattermost voice reconnect exhausted channel=${call.channelId}`);
          return;
        }
        attempt += 1;
        pendingOwner = reservePendingChannel(call.channelId);
        await sleep(Math.max(0, retryDelay));
        retrying = true;
      } finally {
        if (!retrying) {
          clearPendingChannel(pendingOwner, call.channelId);
        }
      }
    }
  };

  function watchSessionClosed(call: ActiveCall) {
    if (!call.session.closed) {
      return;
    }
    const task = call.session.closed
      .then(async () => {
        await handleSessionClosed(call);
      })
      .catch((error: unknown) => {
        params.onError?.(`mattermost voice call session watcher failed: ${String(error)}`);
      });
    trackLifecycleTask(task);
  }

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
        const matchesActiveCall = activeCall?.channelId === channelId;
        const invalidatedPendingJoin = cancelPendingChannel(channelId);
        if (matchesActiveCall) {
          if (!pendingChannelId && !invalidatedPendingJoin) {
            lifecycleGeneration += 1;
          }
          await resetActiveCall({ closeSession: true });
        }
        return;
      }
      const joinedUserId = event.data?.user_id ?? event.data?.userID;
      const humanJoined =
        eventName === "user_joined" && Boolean(joinedUserId) && joinedUserId !== params.botUserId;
      if (!humanJoined || !joinedUserId) {
        return;
      }
      if (activeCall?.channelId === channelId || pendingChannelId !== undefined) {
        return;
      }
      const pendingOwner = reservePendingChannel(channelId);
      try {
        if ((await params.resolveChannelType(channelId))?.toUpperCase() !== "D") {
          return;
        }
        if (pendingOwnerId !== pendingOwner || pendingChannelId !== channelId) {
          return;
        }
        if (!(await params.authorizeJoin({ channelId, userId: joinedUserId }))) {
          return;
        }
        if (pendingOwnerId !== pendingOwner || pendingChannelId !== channelId) {
          return;
        }
        if (activeCall?.channelId === channelId || pendingChannelId !== channelId) {
          return;
        }
        const generation = ++lifecycleGeneration;
        const connectTask = connectActiveCall({ channelId, generation, userId: joinedUserId });
        trackLifecycleTask(connectTask);
        await connectTask;
      } finally {
        clearPendingChannel(pendingOwner, channelId);
      }
    },
    async waitForIdle() {
      await waitForTrackedTasks();
    },
    async close() {
      lifecycleGeneration += 1;
      pendingOwnerId += 1;
      pendingChannelId = undefined;
      await resetActiveCall({ closeSession: true });
      await waitForLifecycleTasks();
      await waitForTrackedTasks();
    },
  };
}
