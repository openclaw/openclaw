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

function createTranscribeTurn(text = "hello") {
  return vi.fn(
    async (_params: { channelId: string; userId: string; samples: Int16Array }) => text,
  );
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
    const transcribeTurn = createTranscribeTurn();
    const processTurn = vi.fn(async () => ({
      audioPath: "/tmp/reply.wav",
    }));
    const worker = createMattermostVoiceWorker({
      authorizeJoin: async () => true,
      botUserId: "bot-user",
      maxSpeechSamples: 100,
      preRollFrames: 2,
      resolveChannelType: async () => "D",
      connect,
      transcribeTurn,
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
    expect(transcribeTurn).toHaveBeenCalledTimes(2);
    expect(Array.from(transcribeTurn.mock.calls[0]?.[0].samples ?? [])).toEqual([1, 1, 2, 2]);
    expect(Array.from(transcribeTurn.mock.calls[1]?.[0].samples ?? [])).toEqual([3, 3]);
    expect(processTurn).toHaveBeenCalledTimes(2);
    expect(processTurn.mock.calls[0]?.[0].message).toBe("hello");
    expect(processTurn.mock.calls[1]?.[0].message).toBe("hello");
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
      transcribeTurn: createTranscribeTurn(),
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
      transcribeTurn: createTranscribeTurn(),
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
      transcribeTurn: createTranscribeTurn(),
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
      transcribeTurn: createTranscribeTurn(),
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
      transcribeTurn: createTranscribeTurn(),
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

  it("discards brief inbound capture while the bot is playing", async () => {
    let callbacks: MattermostVoiceCallCallbacks | undefined;
    const session: MattermostVoiceCallSession = {
      play: vi.fn(async () => {
        callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
        callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(9) });
        callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
      }),
      close: vi.fn(async () => undefined),
    };
    const transcribeTurn = createTranscribeTurn();
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
      transcribeTurn,
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

    expect(transcribeTurn).toHaveBeenCalledTimes(1);
    expect(processTurn).toHaveBeenCalledTimes(1);
  });

  it("discards brief playback capture when playback finishes before speech stops", async () => {
    vi.useFakeTimers();
    try {
      let callbacks: MattermostVoiceCallCallbacks | undefined;
      let finishPlayback: (() => void) | undefined;
      const session: MattermostVoiceCallSession = {
        play: vi.fn(
          async () =>
            await new Promise<void>((resolve) => {
              finishPlayback = resolve;
            }),
        ),
        close: vi.fn(async () => undefined),
      };
      const transcribeTurn = createTranscribeTurn();
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
        transcribeTurn,
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
      callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(9) });
      finishPlayback?.();
      await flushVoiceWorkerMicrotasks();
      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
      await worker.waitForIdle();

      expect(transcribeTurn).toHaveBeenCalledTimes(1);
      expect(processTurn).toHaveBeenCalledTimes(1);
      await worker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not prepend inactive playback pre-roll to the next turn", async () => {
    let callbacks: MattermostVoiceCallCallbacks | undefined;
    let finishPlayback: (() => void) | undefined;
    const session: MattermostVoiceCallSession = {
      play: vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            finishPlayback = resolve;
          }),
      ),
      close: vi.fn(async () => undefined),
    };
    const transcribeTurn = createTranscribeTurn();
    const processTurn = vi
      .fn(async () => ({ audioPath: "/tmp/reply.wav" }))
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
      transcribeTurn,
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

    callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(9) });
    finishPlayback?.();
    await worker.waitForIdle();

    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
    callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(2) });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
    await worker.waitForIdle();

    expect(transcribeTurn).toHaveBeenCalledTimes(2);
    expect(Array.from(transcribeTurn.mock.calls[1]?.[0].samples ?? [])).toEqual([2, 2]);
    await worker.close();
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
      const transcripts = ["first", "second"];
      const transcribeTurn = vi.fn(
        async (_params: { channelId: string; userId: string; samples: Int16Array }) =>
          transcripts.shift(),
      );
      const processTurn = vi
        .fn<
          (_params: {
            abortSignal?: AbortSignal;
            channelId: string;
            message: string;
            userId: string;
          }) => Promise<{ audioPath: string } | undefined>
        >()
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
        transcribeTurn,
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

      callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(9) });
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
      expect(Array.from(transcribeTurn.mock.calls[1]?.[0].samples ?? [])).toEqual([
        2, 2, 3, 3,
      ]);
      expect(processTurn.mock.calls[1]?.[0].message).toBe("first\n\nsecond");
      await worker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels active generation and reruns with combined transcripts", async () => {
    let callbacks: MattermostVoiceCallCallbacks | undefined;
    const session: MattermostVoiceCallSession = {
      play: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const transcripts = ["first", "second"];
    const transcribeTurn = vi.fn(
      async (_params: { channelId: string; userId: string; samples: Int16Array }) =>
        transcripts.shift(),
    );
    let firstSignal: AbortSignal | undefined;
    let processTurnCount = 0;
    const processTurn = vi.fn(
      async (params: {
        abortSignal?: AbortSignal;
        channelId: string;
        message: string;
        userId: string;
      }) => {
        processTurnCount += 1;
        if (processTurnCount === 1) {
          firstSignal = params.abortSignal;
          await new Promise<void>((resolve) => {
            params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return undefined;
        }
        return { audioPath: "/tmp/combined.wav" };
      },
    );
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
      transcribeTurn,
      processTurn,
    });

    await worker.handleEvent({
      event: USER_JOINED,
      data: { channelID: "dm-channel", user_id: "human-user" },
    });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
    callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(1) });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
    await vi.waitFor(() => expect(processTurn).toHaveBeenCalledTimes(1));

    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
    callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(2) });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
    await worker.waitForIdle();

    expect(firstSignal?.aborted).toBe(true);
    expect(transcribeTurn).toHaveBeenCalledTimes(2);
    expect(processTurn).toHaveBeenCalledTimes(2);
    expect(processTurn.mock.calls[0]?.[0].message).toBe("first");
    expect(processTurn.mock.calls[1]?.[0].message).toBe("first\n\nsecond");
    expect(session.play).toHaveBeenCalledTimes(1);
    expect(session.play).toHaveBeenCalledWith(
      expect.objectContaining({ audioPath: "/tmp/combined.wav" }),
      expect.any(Object),
    );
    await worker.close();
  });

  it("isolates release failures from stale cancelled generations", async () => {
    let callbacks: MattermostVoiceCallCallbacks | undefined;
    const onError = vi.fn();
    const session: MattermostVoiceCallSession = {
      play: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const transcripts = ["first", "second"];
    const transcribeTurn = vi.fn(
      async (_params: { channelId: string; userId: string; samples: Int16Array }) =>
        transcripts.shift(),
    );
    let processTurnCount = 0;
    const processTurn = vi.fn(
      async (params: {
        abortSignal?: AbortSignal;
        channelId: string;
        message: string;
        userId: string;
      }) => {
        processTurnCount += 1;
        if (processTurnCount === 1) {
          await new Promise<void>((resolve) => {
            params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            audioPath: "/tmp/stale.wav",
            release: async () => {
              throw new Error("stale cleanup failed");
            },
          };
        }
        return { audioPath: "/tmp/combined.wav" };
      },
    );
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
      transcribeTurn,
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
    await vi.waitFor(() => expect(processTurn).toHaveBeenCalledTimes(1));

    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
    callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(2) });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
    await worker.waitForIdle();

    expect(processTurn).toHaveBeenCalledTimes(2);
    expect(processTurn.mock.calls[1]?.[0].message).toBe("first\n\nsecond");
    expect(session.play).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      "mattermost voice playback release failed: Error: stale cleanup failed",
    );
    await worker.close();
  });

  it("processes speech that started before playback began", async () => {
    let callbacks: MattermostVoiceCallCallbacks | undefined;
    let finishFirstGeneration: ((reply: { audioPath: string }) => void) | undefined;
    const session: MattermostVoiceCallSession = {
      play: vi.fn(
        async (_audio, options?: { signal?: AbortSignal }) =>
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
      ),
      close: vi.fn(async () => undefined),
    };
    const transcripts = ["first", "second"];
    const transcribeTurn = vi.fn(
      async (_params: { channelId: string; userId: string; samples: Int16Array }) =>
        transcripts.shift(),
    );
    let processTurnCount = 0;
    const processTurn = vi.fn(
      async (_params: {
        abortSignal?: AbortSignal;
        channelId: string;
        message: string;
        userId: string;
      }) => {
        processTurnCount += 1;
        if (processTurnCount === 1) {
          return await new Promise<{ audioPath: string }>((resolve) => {
            finishFirstGeneration = resolve;
          });
        }
        return undefined;
      },
    );
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
      transcribeTurn,
      processTurn,
    });

    await worker.handleEvent({
      event: USER_JOINED,
      data: { channelID: "dm-channel", user_id: "human-user" },
    });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
    callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(1) });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
    await vi.waitFor(() => expect(processTurn).toHaveBeenCalledTimes(1));

    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
    callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(2) });
    finishFirstGeneration?.({ audioPath: "/tmp/reply.wav" });
    await vi.waitFor(() => expect(session.play).toHaveBeenCalledTimes(1));
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
    await worker.waitForIdle();

    expect(processTurn).toHaveBeenCalledTimes(2);
    expect(processTurn.mock.calls[1]?.[0].message).toBe("first\n\nsecond");
    await worker.close();
  });

  it("clears retained batch when an interrupted utterance transcribes empty", async () => {
    vi.useFakeTimers();
    try {
      let callbacks: MattermostVoiceCallCallbacks | undefined;
      let playCalls = 0;
      const session: MattermostVoiceCallSession = {
        play: vi.fn(
          async (_audio, options?: { signal?: AbortSignal }) => {
            playCalls += 1;
            if (playCalls === 1) {
              await new Promise<void>((resolve) => {
                options?.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
            }
          },
        ),
        close: vi.fn(async () => undefined),
      };
      const transcripts = ["first", undefined, "next"];
      const transcribeTurn = vi.fn(
        async (_params: { channelId: string; userId: string; samples: Int16Array }) =>
          transcripts.shift(),
      );
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
        transcribeTurn,
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
      await vi.advanceTimersByTimeAsync(2_000);
      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
      await worker.waitForIdle();
      expect(processTurn).toHaveBeenCalledTimes(1);

      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
      callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(3) });
      callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
      await worker.waitForIdle();

      expect(transcribeTurn).toHaveBeenCalledTimes(3);
      expect(processTurn).toHaveBeenCalledTimes(2);
      expect(processTurn.mock.calls[1]?.[0].message).toBe("next");
      await worker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the transcript batch after terminal playback failure", async () => {
    let callbacks: MattermostVoiceCallCallbacks | undefined;
    let playCalls = 0;
    const onError = vi.fn();
    const session: MattermostVoiceCallSession = {
      play: vi.fn(async () => {
        playCalls += 1;
        if (playCalls === 1) {
          throw new Error("speaker failed");
        }
      }),
      close: vi.fn(async () => undefined),
    };
    const transcripts = ["first", "second"];
    const transcribeTurn = vi.fn(
      async (_params: { channelId: string; userId: string; samples: Int16Array }) =>
        transcripts.shift(),
    );
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
      transcribeTurn,
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
    await worker.waitForIdle();

    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
    callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(2) });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
    await worker.waitForIdle();

    expect(processTurn).toHaveBeenCalledTimes(2);
    expect(processTurn.mock.calls[0]?.[0].message).toBe("first");
    expect(processTurn.mock.calls[1]?.[0].message).toBe("second");
    expect(onError).toHaveBeenCalledWith(
      "mattermost voice playback failed: Error: speaker failed",
    );
    await worker.close();
  });

  it("clears the transcript batch when reply release fails after playback", async () => {
    let callbacks: MattermostVoiceCallCallbacks | undefined;
    const onError = vi.fn();
    const session: MattermostVoiceCallSession = {
      play: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const transcripts = ["first", "second"];
    const transcribeTurn = vi.fn(
      async (_params: { channelId: string; userId: string; samples: Int16Array }) =>
        transcripts.shift(),
    );
    const processTurn = vi
      .fn(async () => ({
        audioPath: "/tmp/reply.wav",
        release: async () => {
          throw new Error("cleanup failed");
        },
      }))
      .mockResolvedValueOnce({
        audioPath: "/tmp/reply.wav",
        release: async () => {
          throw new Error("cleanup failed");
        },
      })
      .mockResolvedValueOnce({ audioPath: "/tmp/reply-2.wav" });
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
      transcribeTurn,
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
    await worker.waitForIdle();

    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: true });
    callbacks?.onAudio({ sessionId: "speaker-session", samples: pcm(2) });
    callbacks?.onVoice({ sessionId: "speaker-session", userId: "human-user", speaking: false });
    await worker.waitForIdle();

    expect(processTurn).toHaveBeenCalledTimes(2);
    expect(processTurn.mock.calls[0]?.[0].message).toBe("first");
    expect(processTurn.mock.calls[1]?.[0].message).toBe("second");
    expect(onError).toHaveBeenCalledWith(
      "mattermost voice playback release failed: Error: cleanup failed",
    );
    await worker.close();
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
        .fn<
          (_params: {
            abortSignal?: AbortSignal;
            channelId: string;
            message: string;
            userId: string;
          }) => Promise<{ audioPath: string } | undefined>
        >()
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
        transcribeTurn: createTranscribeTurn(),
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
        transcribeTurn: createTranscribeTurn(),
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
      transcribeTurn: createTranscribeTurn(),
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
