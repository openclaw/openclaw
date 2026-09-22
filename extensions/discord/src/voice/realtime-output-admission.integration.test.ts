import type { AudioResource } from "@discordjs/voice";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import type { DiscordAudioCommand } from "./audio-worker-protocol.js";
import { getDiscordAudioTestWorker } from "./audio-worker.test-support.js";
import { createRealtimePlaybackFixture } from "./realtime-playback.integration.test-support.js";

const cases = (["response", "continuous"] as const).flatMap((mode) =>
  (["admission", "retirement", "cancellation"] as const).map((winner) => ({ mode, winner })),
);

it.each(cases)(
  "preserves callback PCM ownership when $winner wins ($mode)",
  async ({ mode, winner }) => {
    const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: mode });
    const worker = getDiscordAudioTestWorker(fixture.roomPlayer.audio);
    const resources = new Set<AudioResource>();
    const recorded = vi.spyOn(fixture.harness, "recordOutputAudio");
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
      let retirementStarted: boolean | undefined;
      let deliver = () => {};
      if (winner === "retirement") {
        const output = fixture.playback["generatingOutput"];
        if (!output) {
          throw new Error("Expected the live callback output");
        }
        const append = output.append.bind(output);
        const hook = vi.spyOn(output, "append").mockImplementationOnce((...args) => {
          // The worker wins after main selected this output, but before atomic admission.
          retirementStarted = fixture.player.stop(false);
          return append(...args);
        });
        restore = () => hook.mockRestore();
      } else {
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
        deliver = () => {
          restore();
          for (const command of pending) {
            receive(command);
          }
        };
      }
      fixture.callbacks.onAudio(Buffer.alloc(100 * 48, 0x30), { itemId: "tail" });
      fixture.callbacks.onMark?.("tail", () => playedAtTailMark.push(playedMs()));
      if (winner === "cancellation") {
        fixture.callbacks.onClearAudio();
      } else if (winner === "admission") {
        // The chunk is already admitted on main, but its worker command is withheld.
        retirementStarted = fixture.player.stop(false);
      }
      deliver();
      if (winner !== "cancellation") {
        fixture.callbacks.onResponseDone?.({ status: "completed" });
      }
      await vi.waitFor(() => expect(fixture.playback.isOutputAudioActive()).toBe(false), {
        timeout: 4_000,
      });
      expect(playedMs()).toBe(winner === "cancellation" ? 500 : 600);
      expect(playedAtTailMark).toEqual(winner === "cancellation" ? [] : [600]);
      if (winner !== "cancellation") {
        expect(retirementStarted).toBe(winner === "retirement");
        expect(recorded.mock.calls.map(([pcm]) => pcm.length)).toEqual([500 * 48, 100 * 48]);
      }
      expect(fixture.onTerminalError).not.toHaveBeenCalled();
    } finally {
      restore();
      recorded.mockRestore();
      fixture.close();
    }
  },
);
