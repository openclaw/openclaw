import type { AudioResource } from "@discordjs/voice";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import type { DiscordAudioCommand } from "./audio-worker-protocol.js";
import { getDiscordAudioTestWorker } from "./audio-worker.test-support.js";
import { createRealtimePlaybackFixture } from "./realtime-playback.integration.test-support.js";

it.each(["response", "continuous"] as const)(
  "cancels callback PCM before worker delivery (%s)",
  async (mode) => {
    const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: mode });
    const worker = getDiscordAudioTestWorker(fixture.roomPlayer.audio);
    const resources = new Set<AudioResource>();
    const heardFirst = createDeferred<void>();
    const playedAtTailMark: number[] = [];
    const playedMs = () =>
      [...resources].reduce((total, resource) => total + resource.playbackDuration, 0);
    fixture.player.on("stateChange", (_previous, state) => {
      if (state.status !== fixture.voiceSdk.AudioPlayerStatus.Idle) {
        resources.add(state.resource);
      }
    });
    let restore = () => {};
    try {
      fixture.callbacks.onAudio(Buffer.alloc(500 * 48, 0x20), { itemId: "first" });
      fixture.callbacks.onMark?.("first", () => heardFirst.resolve());
      await heardFirst.promise;
      expect(playedMs()).toBe(500);
      const receive = worker.receive.bind(worker);
      const pending: DiscordAudioCommand[] = [];
      const hook = vi.spyOn(worker, "receive").mockImplementation((command) => {
        if (command.type.startsWith("output-")) {
          pending.push(command);
        } else {
          receive(command);
        }
      });
      restore = () => hook.mockRestore();
      fixture.callbacks.onAudio(Buffer.alloc(100 * 48, 0x30), { itemId: "tail" });
      fixture.callbacks.onMark?.("tail", () => playedAtTailMark.push(playedMs()));
      fixture.callbacks.onClearAudio();
      restore();
      for (const command of pending) {
        receive(command);
      }
      await vi.waitFor(() => expect(fixture.playback.isOutputAudioActive()).toBe(false), {
        timeout: 4_000,
      });
      expect(playedMs()).toBe(500);
      expect(playedAtTailMark).toEqual([]);
      expect(fixture.onTerminalError).not.toHaveBeenCalled();
    } finally {
      restore();
      fixture.close();
    }
  },
);
