import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceBridgeCallbacks,
  type RealtimeVoiceBridgeSession,
  type TalkEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { vi } from "vitest";
import { DiscordAudioTransport } from "./audio-transport.js";
import { getDiscordAudioTestWorker } from "./audio-worker.test-support.js";
import * as sdkRuntime from "./sdk-runtime.js";

vi.mock("./audio-worker-thread.js", async () => {
  const { InProcessDiscordAudioWorker } = await import("./audio-worker.test-support.js");
  return {
    createDiscordAudioWorkerThread: (
      options: import("./audio-worker-protocol.js").DiscordAudioWorkerOptions,
    ) => new InProcessDiscordAudioWorker(undefined, { workerData: options }),
  };
});
import { DiscordRealtimePlayback } from "./realtime-playback.js";
import { DiscordRealtimePlayer } from "./realtime-player.js";
import type { VoiceSessionEntry } from "./session.js";
import { DiscordVoiceConversationQueue } from "./voice-conversation-input.js";

export function createRealtimePlaybackFixture(
  onTalkEvent?: (event: TalkEvent) => void,
  options: { outputAudioMode?: "response" | "continuous"; bargeIn?: boolean } = {},
) {
  const voiceSdk = sdkRuntime.loadDiscordVoiceSdk();
  const noop = () => {};
  const connectionOptions = {
    guildId: "guild",
    channelId: "voice",
    group: "playback-integration",
    selfDeaf: true,
    selfMute: false,
  };
  const adapterCreator = () => ({ sendPayload: () => true, destroy: noop });
  // A signalling-only connection supplies the session shape without opening Discord sockets.
  const connection = new voiceSdk.VoiceConnection(connectionOptions, { adapterCreator });
  const sdkOverride = vi.spyOn(sdkRuntime, "loadDiscordVoiceSdk").mockReturnValue({
    ...voiceSdk,
    createAudioPlayer: () =>
      voiceSdk.createAudioPlayer({
        behaviors: { noSubscriber: voiceSdk.NoSubscriberBehavior.Play, maxMissedFrames: 100 },
      }),
    joinVoiceChannel: () => connection,
    entersState: voiceSdk.entersState,
  });
  const audio = new DiscordAudioTransport(
    {
      ...connectionOptions,
      connectTimeoutMs: 30_000,
      reconnectGraceMs: 15_000,
      captureSilenceGraceMs: 2_000,
      realtime: true,
    },
    adapterCreator,
  );
  const player = getDiscordAudioTestWorker(audio)["player"];
  sdkOverride.mockRestore();
  const entry: VoiceSessionEntry = {
    generation: 1,
    captureOnly: false,
    autoJoinWhenOccupied: false,
    sessionLifecycle: { status: "active" },
    guildId: "guild",
    channelId: "voice",
    voiceSessionKey: "agent:main:discord:voice",
    route: {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:voice",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    },
    audio,
    playbackQueue: Promise.resolve(),
    processingQueue: Promise.resolve(),
    conversations: new DiscordVoiceConversationQueue(),
    audioInputBudget: { enabled: false },
    ttsStreamFallbackWarned: false,
    capture: new Map(),
    realtimeLifecycle: { status: "inactive" },
    receiveRecovery: {
      decryptFailureCount: 0,
      lastDecryptFailureAt: 0,
      decryptRecoveryInFlight: false,
    },
    stop: vi.fn(),
  };
  const roomPlayer = new DiscordRealtimePlayer(audio);
  const lanes: Array<{ playback: DiscordRealtimePlayback<unknown>; close: () => void }> = [];
  const createLane = (interruption: "decline" | "clear" | "unsupported" = "decline") => {
    let closed = false;
    let bridge: RealtimeVoiceBridgeSession | null = null;
    let callbacks!: RealtimeVoiceBridgeCallbacks;
    const harness = createRealtimeVoiceSessionHarness({
      onTalkEvent,
      talk: {
        sessionId: entry.voiceSessionKey,
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
      },
      talkPayloads: {
        turnStarted: () => ({}),
        turnEnded: () => ({}),
        inputAudioDelta: () => ({}),
        outputAudioStarted: () => ({}),
        outputAudioDelta: () => ({}),
        outputAudioDone: () => ({}),
      },
    });
    const cancel = vi.spyOn(harness, "handleBargeIn");
    const mocks = {
      onTerminalError: vi.fn(),
      stopTerminally: vi.fn(),
      sendUserMessage: vi.fn(),
      acknowledgeMark: vi.fn(),
    };
    const playback = new DiscordRealtimePlayback({
      bridge: () => bridge,
      bridgeReady: () => true,
      buildSpeakExactMessage: (text) => text,
      entry,
      player: roomPlayer,
      harness,
      markProviderGenerationObserved: noop,
      onTerminalError: mocks.onTerminalError,
      providerId: () => "openai",
      realtimeConfig: () =>
        options.bargeIn === undefined ? undefined : { bargeIn: options.bargeIn },
      stopTerminally: mocks.stopTerminally,
      stopped: () => closed,
      wakeNameRequired: () => false,
    });
    bridge = harness.createBridge({
      provider: {
        id: "synthetic",
        label: "Synthetic",
        isConfigured: () => true,
        createBridge: (events) => {
          callbacks = events;
          return {
            outputAudioMode: options.outputAudioMode,
            connect: async () => {},
            close: noop,
            sendAudio: noop,
            sendUserMessage: mocks.sendUserMessage,
            setMediaTimestamp: noop,
            acknowledgeMark: mocks.acknowledgeMark,
            submitToolResult: noop,
            isConnected: () => true,
            ...(interruption === "unsupported"
              ? {}
              : { handleBargeIn: () => interruption === "clear" && events.onClearAudio() }),
          };
        },
      },
      providerConfig: {},
      audioSink: {
        sendAudio: (pcm, metadata) => playback.sendOutputAudio(pcm, metadata),
        sendMark: (markName, acknowledge) =>
          acknowledge ? playback.sendOutputMark(acknowledge) : bridge?.acknowledgeMark(markName),
        getPlaybackState: () => playback.getPlaybackState(),
        clearAudio: () => harness.flushOutput(() => playback.clearOutputAudio("provider-clear")),
      },
      onResponseDone: (outcome) => playback.handleResponseDone(outcome),
      onEvent: (event) => {
        if (event.direction === "server" && event.type === "response.created") {
          playback.beginResponse();
        }
      },
    });
    const lane = {
      playback,
      harness,
      callbacks,
      cancel,
      ...mocks,
      close(this: void, preserveUnplayedSpeech = false) {
        closed = true;
        playback.close(preserveUnplayedSpeech);
        harness.close();
        // The synthetic provider closes synchronously, including reentrant player callbacks.
        void bridge?.close();
        cancel.mockRestore();
      },
    };
    lanes.push(lane);
    return lane;
  };
  const firstLane = createLane();
  const stopPlayer = player.stop.bind(player);
  const stop = vi.spyOn(player, "stop");
  const onPlayerError = vi.fn();
  player.on("error", onPlayerError);

  return {
    voiceSdk,
    player,
    ...firstLane,
    closeSpeaker: firstLane.close,
    createLane,
    roomPlayer,
    stopPlayer,
    stop,
    onPlayerError,
    close() {
      roomPlayer.close();
      for (const lane of lanes) {
        lane.close();
      }
      void audio.stop();
      player.off("error", onPlayerError);
      stop.mockRestore();
    },
  };
}
