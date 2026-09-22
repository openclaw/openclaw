import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createDiscordLivePolicyReader } from "../monitor/live-policy.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    agentCommandMock,
    controlRealtimeVoiceAgentRunMock,
    createAudioPlayerMock,
    createClientWithMember,
    createManager,
    createRuntime,
    entersStateMock,
    getSessionEntry,
    getLastAudioPlayer,
    receiveRecordedSpeech,
    lastTtsStreamArgs,
    loggerWarnMock,
    makeVoiceConfig,
    managerModule,
    receiveVoiceUtterance,
    textToSpeechMock,
    textToSpeechStreamMock,
  }) => {
    async function createBatchFixture() {
      const discordConfig = makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["333"] });
      let cfg: OpenClawConfig = { channels: { discord: discordConfig } };
      const client = createClientWithMember("333", "Guest", "4321");
      const manager = new managerModule.DiscordVoiceManager({
        cfg,
        discordConfig,
        client: client as never,
        accountId: "default",
        runtime: createRuntime(),
        readPolicy: createDiscordLivePolicyReader({
          cfg,
          accountId: "default",
          token: "synthetic-token",
          readConfig: () => cfg,
          resolvedAllowlist: { guildEntries: undefined, allowFrom: ["333"] },
        }),
      });
      expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({ ok: true });
      textToSpeechStreamMock.mockResolvedValue({
        success: true,
        audioStream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
        release: vi.fn(async () => {}),
      });
      return {
        manager,
        entry: getSessionEntry(manager),
        player: getLastAudioPlayer(),
        revokePolicy() {
          cfg = { channels: { discord: { ...discordConfig, groupPolicy: "disabled" } } };
        },
      };
    }

    it.each([
      { transition: "none", result: "miss", fallback: true },
      { transition: "none", result: "error", fallback: true },
      { transition: "none", result: "abort", fallback: false },
      { transition: "none", result: "guarded", fallback: false },
      { transition: "stop", result: "guarded", fallback: false },
      { transition: "policy", result: "guarded", fallback: false },
      { transition: "stop", result: "miss", fallback: false },
      { transition: "policy", result: "miss", fallback: false },
    ] as const)(
      "keeps batch control $result dispatch within its $transition conversation",
      async ({ transition, result, fallback: shouldFallback }) => {
        const fixture = await createBatchFixture();
        const voiceIngress = await import("./ingress.js");
        const resume = createDeferred<void>();
        const controlEffect = vi.fn();
        const fallback = vi.spyOn(voiceIngress, "runDiscordVoiceAgentTurn");
        controlRealtimeVoiceAgentRunMock.mockImplementationOnce(async (params) => {
          await resume.promise;
          if (result === "error") {
            throw new Error("Control runtime unavailable");
          }
          if (result === "abort") {
            throw new DOMException("Control was cancelled", "AbortError");
          }
          if (result === "guarded") {
            params.getToolAuthorityOverlay?.();
            controlEffect();
          }
          return {
            ok: result === "guarded",
            active: result === "guarded",
            mode: "steer",
            sessionKey: params.sessionKey,
            queued: result === "guarded",
            message: "Control completed",
            speak: true,
            show: true,
            suppress: false,
          };
        });
        agentCommandMock.mockResolvedValue({ payloads: [{ text: "Fallback answer" }] });
        const processing = receiveRecordedSpeech(
          fixture.manager,
          "stop using the slow path",
          fixture.entry,
          "333",
        ).then(
          () => ({ ok: true }),
          (error: unknown) => ({ error }),
        );
        try {
          await vi.waitFor(() => expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledOnce());
          if (transition === "stop") {
            await fixture.manager.leave({ guildId: "g1" });
          } else if (transition === "policy") {
            fixture.revokePolicy();
          }
          resume.resolve();
          expect(await processing).toEqual({ ok: true });
          await fixture.entry.playbackQueue;
          expect({
            control: controlEffect.mock.calls.length,
            fallback: fallback.mock.calls.length,
            agent: agentCommandMock.mock.calls.length,
            synthesis: textToSpeechStreamMock.mock.calls.length,
            playback: fixture.player.play.mock.calls.length,
          }).toEqual({
            control: transition === "none" && result === "guarded" ? 1 : 0,
            fallback: shouldFallback ? 1 : 0,
            agent: shouldFallback ? 1 : 0,
            synthesis: transition === "none" && result !== "abort" ? 1 : 0,
            playback: transition === "none" && result !== "abort" ? 1 : 0,
          });
        } finally {
          resume.resolve();
          await processing;
          fallback.mockRestore();
          await fixture.manager.destroy();
        }
      },
    );

    it.each(["none", "stop", "policy"] as const)(
      "starts batch reply synthesis only in a live conversation (transition=%s)",
      async (transition) => {
        const fixture = await createBatchFixture();
        const answer = createDeferred<{ payloads: Array<{ text: string }> }>();
        agentCommandMock.mockReturnValueOnce(answer.promise);
        const processing = receiveRecordedSpeech(
          fixture.manager,
          "Read the agenda",
          fixture.entry,
          "333",
        ).then(
          () => ({ ok: true }),
          (error: unknown) => ({ error }),
        );
        try {
          await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledOnce());
          if (transition === "stop") {
            await fixture.manager.leave({ guildId: "g1" });
          } else if (transition === "policy") {
            fixture.revokePolicy();
          }
          answer.resolve({ payloads: [{ text: "Completed shared work" }] });
          expect(await processing).toEqual({ ok: true });
          await fixture.entry.playbackQueue;
          expect(agentCommandMock).toHaveBeenCalledOnce();
          expect(textToSpeechStreamMock).toHaveBeenCalledTimes(transition === "none" ? 1 : 0);
          expect(fixture.player.play).toHaveBeenCalledTimes(transition === "none" ? 1 : 0);
        } finally {
          answer.resolve({ payloads: [] });
          await processing;
          await fixture.manager.destroy();
        }
      },
    );

    it("keeps streaming TTS audio alive until Discord finishes playback without a duration deadline", async () => {
      const release = vi.fn(async () => undefined);
      let finishPlayback!: () => void;
      const playbackCompletion = new Promise<void>((resolve) => {
        finishPlayback = resolve;
      });
      entersStateMock.mockImplementation(async (_target, state, timeoutOrSignal) => {
        if (state !== "idle") {
          return;
        }
        if (typeof timeoutOrSignal === "number") {
          throw new Error("voice playback deadline elapsed");
        }
        await playbackCompletion;
      });
      textToSpeechStreamMock.mockResolvedValue({
        success: true,
        audioStream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
        release,
      });
      agentCommandMock.mockResolvedValueOnce({
        payloads: [{ text: "hello back" }],
      });

      const client = createClientWithMember("u-guest", "Guest", "4321");
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-guest"] }),
        client,
        {},
      );
      await receiveVoiceUtterance(manager, "u-guest");

      expect(lastTtsStreamArgs().channel).toBe("discord");
      expect(lastTtsStreamArgs().disableFallback).toBe(true);
      expect(lastTtsStreamArgs().text).toBe("hello back");
      expect(textToSpeechMock).not.toHaveBeenCalled();
      const player = createAudioPlayerMock.mock.results.at(-1)?.value;
      await vi.waitFor(() =>
        expect(entersStateMock).toHaveBeenCalledWith(player, "idle", expect.any(AbortSignal)),
      );
      expect(release).not.toHaveBeenCalled();
      finishPlayback();
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    });

    it("releases and reports streaming TTS that ends before playback starts", async () => {
      const release = vi.fn(async () => undefined);
      textToSpeechStreamMock.mockResolvedValueOnce({
        success: true,
        audioStream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        release,
      });
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "failed voice reply" }] });
      entersStateMock.mockImplementation(async (target, state, signal) => {
        if (state === "playing") {
          if (!(signal instanceof AbortSignal)) {
            throw new Error("Expected a cancellable playback wait");
          }
          const lifecycle = signal;
          const readinessFailure = new Promise<never>((_resolve, reject) => {
            lifecycle.addEventListener("abort", () => reject(new Error("player never started")), {
              once: true,
            });
          });
          const player = target as ReturnType<typeof createAudioPlayerMock>;
          const idleHandler = player.on.mock.calls.find(([event]) => event === "idle")?.[1];
          idleHandler?.();
          await readinessFailure;
        }
      });
      const client = createClientWithMember("u-guest", "Guest", "4321");
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-guest"] }),
        client,
      );

      await receiveVoiceUtterance(manager, "u-guest");

      await vi.waitFor(() =>
        expect(loggerWarnMock).toHaveBeenCalledWith(
          "discord voice: playback failed: player never started",
        ),
      );
      expect(release).toHaveBeenCalledOnce();
      expect(entersStateMock).not.toHaveBeenCalledWith(
        expect.anything(),
        "idle",
        expect.anything(),
      );
    });

    it.each([
      { name: "buffering before playback starts", buffering: true },
      { name: "actively playing", buffering: false },
    ])(
      "releases $name streaming TTS immediately when the session leaves",
      async ({ buffering }) => {
        const release = vi.fn(async () => undefined);
        textToSpeechStreamMock.mockResolvedValueOnce({
          success: true,
          audioStream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
            },
          }),
          release,
        });
        agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "unfinished voice reply" }] });
        const client = createClientWithMember("u-guest", "Guest", "4321");
        const manager = createManager(
          makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-guest"] }),
          client,
        );
        await manager.join({ guildId: "g1", channelId: "1001" });
        const entry = getSessionEntry(manager);
        const player = getLastAudioPlayer();
        entersStateMock.mockImplementation(async (_target, state, signal) => {
          if (state === (buffering ? "playing" : "idle")) {
            await new Promise<void>((_resolve, reject) => {
              if (!(signal instanceof AbortSignal)) {
                throw new Error("Expected a cancellable playback wait");
              }
              const lifecycle = signal;
              lifecycle.addEventListener("abort", () => reject(new Error("playback cancelled")), {
                once: true,
              });
            });
          }
        });
        player.stop.mockImplementation(() => {
          const idleHandler = player.on.mock.calls.find(([event]) => event === "idle")?.[1];
          idleHandler?.();
          return true;
        });

        await receiveRecordedSpeech(manager, undefined, entry, "u-guest");
        await vi.waitFor(() =>
          expect(entersStateMock).toHaveBeenCalledWith(
            entry.player,
            buffering ? "playing" : "idle",
            expect.any(AbortSignal),
          ),
        );
        expect(release).not.toHaveBeenCalled();

        expect((await manager.leave({ guildId: "g1" })).ok).toBe(true);
        await entry.playbackQueue;

        expect(player.stop).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        expect(loggerWarnMock).not.toHaveBeenCalledWith(
          expect.stringContaining("discord voice: playback failed"),
        );
      },
    );
  },
);
