import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { createDiscordLivePolicyReader } from "../monitor/live-policy.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests((h) => {
  const { expect, it, vi } = h;
  function streamReply({ empty = false, open = false } = {}) {
    const release = vi.fn(async () => undefined);
    return {
      success: true,
      audioStream: new ReadableStream<Uint8Array>({
        start(controller) {
          if (!empty) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          }
          if (!open) {
            controller.close();
          }
        },
      }),
      release,
    };
  }

  const guestManager = () =>
    h.createManager(
      h.makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-guest"] }),
      h.createClientWithMember("u-guest", "Guest", "4321"),
    );

  async function createBatchFixture() {
    const discordConfig = h.makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["333"] });
    let cfg: OpenClawConfig = { channels: { discord: discordConfig } };
    const client = h.createClientWithMember("333", "Guest", "4321");
    const manager = new h.managerModule.DiscordVoiceManager({
      scheduler: createTestPluginServiceScheduler(),
      cfg,
      discordConfig,
      client: client as never,
      accountId: "default",
      runtime: h.createRuntime(),
      readPolicy: createDiscordLivePolicyReader({
        cfg,
        accountId: "default",
        token: "synthetic-token",
        readConfig: () => cfg,
        resolvedAllowlist: { guildEntries: undefined, allowFrom: ["333"] },
      }),
    });
    expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({ ok: true });
    h.textToSpeechStreamMock.mockResolvedValue(streamReply());
    return {
      manager,
      entry: h.getSessionEntry(manager),
      player: h.getLastAudioPlayer(),
      revokePolicy() {
        cfg = { channels: { discord: { ...discordConfig, groupPolicy: "disabled" } } };
      },
    };
  }

  it.each([
    ["control", "none", "miss", true],
    ["control", "none", "error", true],
    ["control", "none", "abort", false],
    ["control", "none", "guarded", false],
    ["control", "stop", "guarded", false],
    ["control", "policy", "guarded", false],
    ["control", "stop", "miss", false],
    ["control", "policy", "miss", false],
    ["reply", "none", "miss", true],
    ["reply", "stop", "miss", false],
    ["reply", "policy", "miss", false],
  ] as const)(
    "keeps %s work within its %s conversation (result=%s)",
    async (phase, transition, result, shouldFallback) => {
      const fixture = await createBatchFixture();
      const voiceIngress = await import("./ingress.js");
      const resume = createDeferred<void>();
      const answer = createDeferred<{ payloads: Array<{ text: string }> }>();
      const controlEffect = vi.fn();
      const fallback = vi.spyOn(voiceIngress, "runDiscordVoiceAgentTurn");
      if (phase === "control") {
        h.controlRealtimeVoiceAgentRunMock.mockImplementationOnce(async (params) => {
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
        h.agentCommandMock.mockResolvedValue({ payloads: [{ text: "Fallback answer" }] });
      } else {
        h.agentCommandMock.mockReturnValueOnce(answer.promise);
      }
      const text = phase === "control" ? "stop using the slow path" : "Read the agenda";
      const processing = h.receiveRecordedSpeech(fixture.manager, text, fixture.entry, "333").then(
        () => ({ ok: true }),
        (error: unknown) => ({ error }),
      );
      try {
        const pending =
          phase === "control" ? h.controlRealtimeVoiceAgentRunMock : h.agentCommandMock;
        await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce());
        if (transition === "stop") {
          await fixture.manager.leave({ guildId: "g1" });
        }
        if (transition === "policy") {
          fixture.revokePolicy();
        }
        resume.resolve();
        answer.resolve({ payloads: [{ text: "Completed shared work" }] });
        expect(await processing).toEqual({ ok: true });
        await fixture.entry.playbackQueue;
        if (phase === "control") {
          expect({
            control: controlEffect.mock.calls.length,
            fallback: fallback.mock.calls.length,
            agent: h.agentCommandMock.mock.calls.length,
            synthesis: h.textToSpeechStreamMock.mock.calls.length,
            playback: fixture.player.play.mock.calls.length,
          }).toEqual({
            control: transition === "none" && result === "guarded" ? 1 : 0,
            fallback: shouldFallback ? 1 : 0,
            agent: shouldFallback ? 1 : 0,
            synthesis: transition === "none" && result !== "abort" ? 1 : 0,
            playback: transition === "none" && result !== "abort" ? 1 : 0,
          });
        } else {
          expect(h.agentCommandMock).toHaveBeenCalledOnce();
          expect(h.textToSpeechStreamMock).toHaveBeenCalledTimes(transition === "none" ? 1 : 0);
          expect(fixture.player.play).toHaveBeenCalledTimes(transition === "none" ? 1 : 0);
        }
      } finally {
        resume.resolve();
        answer.resolve({ payloads: [] });
        await processing;
        fallback.mockRestore();
        await fixture.manager.destroy();
      }
    },
  );

  it.each(["complete", "empty", "buffering", "playing"] as const)(
    "releases streaming TTS at the correct playback boundary (%s)",
    async (mode) => {
      const leaves = mode === "buffering" || mode === "playing";
      const reply = streamReply({ empty: mode === "empty", open: leaves });
      const { release } = reply;
      h.textToSpeechStreamMock.mockResolvedValueOnce(reply);
      h.agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "Voice reply" }] });
      const manager = guestManager();
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = h.getSessionEntry(manager);
      const player = h.getLastAudioPlayer();
      const completed = createDeferred<void>();
      const waitState = mode === "empty" || mode === "buffering" ? "playing" : "idle";
      h.entersStateMock.mockImplementation(async (target, state, signal) => {
        if (state !== waitState) {
          return;
        }
        if (mode === "complete") {
          if (typeof signal === "number") {
            throw new Error("voice playback deadline elapsed");
          }
          await completed.promise;
        } else {
          if (!(signal instanceof AbortSignal)) {
            throw new Error("Expected a cancellable playback wait");
          }
          const cancelled = new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                reject(new Error(mode === "empty" ? "player never started" : "playback cancelled")),
              { once: true },
            );
          });
          if (mode === "empty") {
            (target as ReturnType<typeof h.createAudioPlayerMock>).emit("idle");
          }
          await cancelled;
        }
      });
      if (leaves) {
        player.stop.mockImplementation(() => {
          const idle = player.on.mock.calls.find(([event]) => event === "idle")?.[1];
          idle?.();
          return true;
        });
      }
      await h.receiveRecordedSpeech(manager, undefined, entry, "u-guest");
      if (mode === "empty") {
        await vi.waitFor(() =>
          expect(h.loggerWarnMock).toHaveBeenCalledWith(
            "discord voice: playback failed: player never started",
          ),
        );
        expect(release).toHaveBeenCalledOnce();
        expect(h.entersStateMock).not.toHaveBeenCalledWith(
          expect.anything(),
          "idle",
          expect.anything(),
        );
        return;
      }
      await vi.waitFor(() =>
        expect(h.entersStateMock).toHaveBeenCalledWith(player, waitState, expect.any(AbortSignal)),
      );
      expect(release).not.toHaveBeenCalled();
      if (mode === "complete") {
        expect(h.lastTtsStreamArgs()).toMatchObject({
          channel: "discord",
          disableFallback: true,
          text: "Voice reply",
        });
        expect(h.textToSpeechMock).not.toHaveBeenCalled();
        completed.resolve();
        await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      } else {
        expect((await manager.leave({ guildId: "g1" })).ok).toBe(true);
        await entry.playbackQueue;
        expect(player.stop).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        expect(h.loggerWarnMock).not.toHaveBeenCalledWith(
          expect.stringContaining("discord voice: playback failed"),
        );
      }
    },
  );
});
