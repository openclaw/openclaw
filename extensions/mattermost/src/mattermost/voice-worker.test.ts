import { describe, expect, it, vi } from "vitest";
import {
  createMattermostVoiceWorker,
  type MattermostVoiceCallCallbacks,
  type MattermostVoiceCallSession,
} from "./voice-worker.js";

const CALL_START = "custom_com.mattermost.calls_call_start";
const CALL_END = "custom_com.mattermost.calls_call_end";
const USER_JOINED = "custom_com.mattermost.calls_user_joined";

function pcm(value: number): Int16Array {
  return new Int16Array([value, value]);
}

async function flushVoiceWorkerMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Mattermost voice worker", () => {
  it("joins direct calls, handles repeated turns, and leaves on call end", async () => {
    let callbacks: MattermostVoiceCallCallbacks | undefined;
    const session: MattermostVoiceCallSession = {
      play: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const connect = vi.fn(async (params: { callbacks: MattermostVoiceCallCallbacks }) => {
      callbacks = params.callbacks;
      return session;
    });
    const processTurn = vi.fn(async (_params: { samples: Int16Array }) => ({
      audioPath: "/tmp/reply.wav",
    }));
    const worker = createMattermostVoiceWorker({
      authorizeJoin: async () => true,
      botUserId: "bot-user",
      maxSpeechSamples: 100,
      preRollFrames: 2,
      resolveChannelType: async () => "D",
      connect,
      processTurn,
    });

    await worker.handleEvent({
      event: USER_JOINED,
      data: { channelID: "dm-channel", user_id: "human-user" },
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ channelId: "dm-channel" }));

    callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(1) });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
    callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(2) });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
    await worker.waitForIdle();

    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
    callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(3) });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
    await worker.waitForIdle();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(processTurn).toHaveBeenCalledTimes(2);
    expect(Array.from(processTurn.mock.calls[0]?.[0].samples ?? [])).toEqual([1, 1, 2, 2]);
    expect(Array.from(processTurn.mock.calls[1]?.[0].samples ?? [])).toEqual([3, 3]);
    expect(session.play).toHaveBeenCalledTimes(2);

    await worker.handleEvent({
      event: CALL_END,
      data: { channelID: "dm-channel" },
    });
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("ignores non-direct calls and the bot's own voice activity", async () => {
    let callbacks: MattermostVoiceCallCallbacks | undefined;
    const session: MattermostVoiceCallSession = {
      play: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const connect = vi.fn(async (params: { callbacks: MattermostVoiceCallCallbacks }) => {
      callbacks = params.callbacks;
      return session;
    });
    const processTurn = vi.fn(async () => undefined);
    const resolveChannelType = vi
      .fn<(channelId: string) => Promise<string | undefined>>()
      .mockResolvedValueOnce("O")
      .mockResolvedValueOnce("D");
    const worker = createMattermostVoiceWorker({
      authorizeJoin: async () => true,
      botUserId: "bot-user",
      maxSpeechSamples: 100,
      preRollFrames: 2,
      resolveChannelType,
      connect,
      processTurn,
    });

    await worker.handleEvent({
      event: USER_JOINED,
      data: { channelID: "public-channel", user_id: "human-user" },
    });
    await worker.handleEvent({
      event: USER_JOINED,
      data: { channelID: "dm-channel", user_id: "human-user" },
    });

    callbacks?.onVoice({ sessionId: "bot-session", userId: "bot-user", speaking: true });
    callbacks?.onAudio({ sessionId: "bot-session", samples: pcm(5) });
    callbacks?.onVoice({ sessionId: "bot-session", userId: "bot-user", speaking: false });
    await worker.waitForIdle();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(processTurn).not.toHaveBeenCalled();
    await worker.close();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("joins an existing direct call when a human enters it", async () => {
    const session: MattermostVoiceCallSession = {
      play: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const connect = vi.fn(async () => session);
    const onDebug = vi.fn();
    const worker = createMattermostVoiceWorker({
      authorizeJoin: async () => true,
      botUserId: "bot-user",
      maxSpeechSamples: 100,
      preRollFrames: 2,
      resolveChannelType: async () => "D",
      connect,
      processTurn: async () => undefined,
      onDebug,
    });

    await worker.handleEvent({
      event: USER_JOINED,
      data: { channelID: "dm-channel", user_id: "human-user" },
    });
    await worker.handleEvent({
      event: USER_JOINED,
      data: { channelID: "dm-channel", user_id: "bot-user" },
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ channelId: "dm-channel" }));
    expect(onDebug).toHaveBeenCalledWith(
      "mattermost voice event=user_joined channel=dm-channel user=human-user",
    );
    await worker.close();
  });

  it("does not join calls for unauthorized users", async () => {
    const connect = vi.fn(async () => ({
      play: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }));
    const authorizeJoin = vi.fn(async () => false);
    const worker = createMattermostVoiceWorker({
      authorizeJoin,
      botUserId: "bot-user",
      maxSpeechSamples: 100,
      preRollFrames: 2,
      resolveChannelType: async () => "D",
      connect,
      processTurn: async () => undefined,
    });

    await worker.handleEvent({
      event: USER_JOINED,
      data: { channelID: "dm-channel", user_id: "untrusted-user" },
    });

    expect(authorizeJoin).toHaveBeenCalledWith({
      channelId: "dm-channel",
      userId: "untrusted-user",
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("does not let call_start without a user replace the active call", async () => {
    const session: MattermostVoiceCallSession = {
      play: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const connect = vi.fn(async () => session);
    const worker = createMattermostVoiceWorker({
      authorizeJoin: async () => true,
      botUserId: "bot-user",
      maxSpeechSamples: 100,
      preRollFrames: 2,
      resolveChannelType: async () => "D",
      connect,
      processTurn: async () => undefined,
    });

    await worker.handleEvent({
      event: USER_JOINED,
      data: { channelID: "dm-channel", user_id: "human-user" },
    });
    await worker.handleEvent({
      event: CALL_START,
      data: { channelID: "other-dm-channel", id: "call-2" },
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(session.close).not.toHaveBeenCalled();
    await worker.close();
  });

  it("does not let ignored non-DM joins cancel an in-flight DM join", async () => {
    let finishConnect: ((session: MattermostVoiceCallSession) => void) | undefined;
    const session: MattermostVoiceCallSession = {
      play: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const worker = createMattermostVoiceWorker({
      authorizeJoin: async () => true,
      botUserId: "bot-user",
      maxSpeechSamples: 100,
      preRollFrames: 2,
      resolveChannelType: async (channelId) => (channelId === "dm-channel" ? "D" : "O"),
      connect: async () =>
        await new Promise<MattermostVoiceCallSession>((resolve) => {
          finishConnect = resolve;
        }),
      processTurn: async () => undefined,
    });

    const joiningDm = worker.handleEvent({
      event: USER_JOINED,
      data: { channelID: "dm-channel", user_id: "human-user" },
    });
    await vi.waitFor(() => expect(finishConnect).toBeDefined());
    await worker.handleEvent({
      event: USER_JOINED,
      data: { channelID: "public-channel", user_id: "human-user" },
    });
    finishConnect?.(session);
    await joiningDm;

    expect(session.close).not.toHaveBeenCalled();
    await worker.close();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("suppresses inbound capture while the bot is playing", async () => {
    let callbacks: MattermostVoiceCallCallbacks | undefined;
    const session: MattermostVoiceCallSession = {
      play: vi.fn(async () => {
        callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
        callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(9) });
        callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
      }),
      close: vi.fn(async () => undefined),
    };
    const processTurn = vi.fn(async () => ({ audioPath: "/tmp/reply.wav" }));
    const worker = createMattermostVoiceWorker({
      authorizeJoin: async () => true,
      botUserId: "bot-user",
      maxSpeechSamples: 100,
      preRollFrames: 2,
      resolveChannelType: async () => "D",
      connect: async (params) => {
        callbacks = params.callbacks;
        return session;
      },
      processTurn,
    });

    await worker.handleEvent({
      event: USER_JOINED,
      data: { channelID: "dm-channel", user_id: "human-user" },
    });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
    callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(1) });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
    await worker.waitForIdle();

    expect(processTurn).toHaveBeenCalledTimes(1);
  });

  it("interrupts playback after sustained human speech and captures the next turn", async () => {
    vi.useFakeTimers();
    try {
      let callbacks: MattermostVoiceCallCallbacks | undefined;
      let playbackSignal: AbortSignal | undefined;
      const session: MattermostVoiceCallSession = {
        play: vi.fn(
          async (_audio, options?: { signal?: AbortSignal }) =>
            await new Promise<void>((resolve) => {
              playbackSignal = options?.signal;
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            }),
        ),
        close: vi.fn(async () => undefined),
      };
      const processTurn = vi
        .fn<(_params: { samples: Int16Array }) => Promise<{ audioPath: string } | undefined>>()
        .mockResolvedValueOnce({ audioPath: "/tmp/reply.wav" })
        .mockResolvedValueOnce(undefined);
      const worker = createMattermostVoiceWorker({
        authorizeJoin: async () => true,
        botUserId: "bot-user",
        maxSpeechSamples: 100,
        preRollFrames: 2,
        resolveChannelType: async () => "D",
        connect: async (params) => {
          callbacks = params.callbacks;
          return session;
        },
        processTurn,
      });

      await worker.handleEvent({
        event: USER_JOINED,
        data: { channelID: "dm-channel", user_id: "human-user" },
      });
      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
      callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(1) });
      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
      await flushVoiceWorkerMicrotasks();
      expect(session.play).toHaveBeenCalledTimes(1);

      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
      callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(2) });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(playbackSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(playbackSignal?.aborted).toBe(true);
      callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(3) });
      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
      await worker.waitForIdle();

      expect(processTurn).toHaveBeenCalledTimes(2);
      expect(Array.from(processTurn.mock.calls[1]?.[0].samples ?? [])).toEqual([3, 3]);
      await worker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out stalled playback and captures the next turn", async () => {
    vi.useFakeTimers();
    try {
      let callbacks: MattermostVoiceCallCallbacks | undefined;
      let playbackSignal: AbortSignal | undefined;
      const onError = vi.fn();
      const session: MattermostVoiceCallSession = {
        play: vi.fn(
          async (_audio, options?: { signal?: AbortSignal }) =>
            await new Promise<void>(() => {
              playbackSignal = options?.signal;
            }),
        ),
        close: vi.fn(async () => undefined),
      };
      const processTurn = vi
        .fn<(_params: { samples: Int16Array }) => Promise<{ audioPath: string } | undefined>>()
        .mockResolvedValueOnce({ audioPath: "/tmp/reply.wav" })
        .mockResolvedValueOnce(undefined);
      const worker = createMattermostVoiceWorker({
        authorizeJoin: async () => true,
        botUserId: "bot-user",
        maxSpeechSamples: 100,
        playbackTimeoutMilliseconds: 10,
        preRollFrames: 2,
        resolveChannelType: async () => "D",
        connect: async (params) => {
          callbacks = params.callbacks;
          return session;
        },
        processTurn,
        onError,
      });

      await worker.handleEvent({
        event: USER_JOINED,
        data: { channelID: "dm-channel", user_id: "human-user" },
      });
      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
      callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(1) });
      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
      await flushVoiceWorkerMicrotasks();
      expect(session.play).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(playbackSignal?.aborted).toBe(true);
      await flushVoiceWorkerMicrotasks();

      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
      callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(2) });
      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
      await worker.waitForIdle();

      expect(processTurn).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledWith("mattermost voice playback timed out after 10ms");
      await worker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bases the default playback timeout on reply audio duration", async () => {
    vi.useFakeTimers();
    try {
      let callbacks: MattermostVoiceCallCallbacks | undefined;
      let playbackSignal: AbortSignal | undefined;
      const onError = vi.fn();
      const session: MattermostVoiceCallSession = {
        play: vi.fn(
          async (_audio, options?: { signal?: AbortSignal }) =>
            await new Promise<void>((resolve) => {
              playbackSignal = options?.signal;
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            }),
        ),
        close: vi.fn(async () => undefined),
      };
      const processTurn = vi.fn(async () => ({
        audioPath: "/tmp/reply.wav",
        durationMilliseconds: 60_000,
      }));
      const worker = createMattermostVoiceWorker({
        authorizeJoin: async () => true,
        botUserId: "bot-user",
        maxSpeechSamples: 100,
        preRollFrames: 2,
        resolveChannelType: async () => "D",
        connect: async (params) => {
          callbacks = params.callbacks;
          return session;
        },
        processTurn,
        onError,
      });

      await worker.handleEvent({
        event: USER_JOINED,
        data: { channelID: "dm-channel", user_id: "human-user" },
      });
      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
      callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(1) });
      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
      await flushVoiceWorkerMicrotasks();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(playbackSignal?.aborted).toBe(false);
      expect(onError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(40_000);
      expect(playbackSignal?.aborted).toBe(true);
      expect(onError).toHaveBeenCalledWith("mattermost voice playback timed out after 70000ms");
      await worker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retain a connection that finishes after the call ended", async () => {
    let finishConnect: ((session: MattermostVoiceCallSession) => void) | undefined;
    const session: MattermostVoiceCallSession = {
      play: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const worker = createMattermostVoiceWorker({
      authorizeJoin: async () => true,
      botUserId: "bot-user",
      maxSpeechSamples: 100,
      preRollFrames: 2,
      resolveChannelType: async () => "D",
      connect: async () =>
        await new Promise<MattermostVoiceCallSession>((resolve) => {
          finishConnect = resolve;
        }),
      processTurn: async () => undefined,
    });

    const starting = worker.handleEvent({
      event: USER_JOINED,
      data: { channelID: "dm-channel", user_id: "human-user" },
    });
    await vi.waitFor(() => expect(finishConnect).toBeDefined());
    await worker.handleEvent({
      event: CALL_END,
      data: { channelID: "dm-channel" },
    });
    finishConnect?.(session);
    await starting;

    expect(session.close).toHaveBeenCalledTimes(1);
    await worker.close();
    expect(session.close).toHaveBeenCalledTimes(1);
  });
});
