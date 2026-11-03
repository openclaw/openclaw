import { once } from "node:events";
import { loadLibopus } from "libopus-wasm";
import { createRealtimeVoiceAudioPortSender } from "openclaw/plugin-sdk/realtime-voice";
import { expect, it, onTestFinished, vi } from "vitest";
import type { DiscordAudioEvent } from "./audio-worker-protocol.js";
import { DiscordRealtimeOutput } from "./realtime-output.runtime.js";
import { createRealtimePlaybackFixture } from "./realtime-playback.integration.test-support.js";

async function createDirectPlaybackFixture() {
  await loadLibopus();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
  const audio = fixture.roomPlayer.audio;
  const output = fixture.playback.createOutputAudioPort();
  const sender = createRealtimeVoiceAudioPortSender(output);
  const successor = { deliverRetainedSpeech: vi.fn() };
  onTestFinished(() => {
    sender.close();
    fixture.close();
    vi.useRealTimers();
  });
  const send = (pcm = Buffer.alloc(9_600, 0x20)) => {
    const admitted = once(output.port, "message");
    sender.sendAudio(pcm);
    return admitted;
  };
  const retain = () => {
    fixture.closeSpeaker(true);
    fixture.playback.transferPendingSpeechTo(successor);
    return successor.deliverRetainedSpeech.mock.calls;
  };
  const done = () => fixture.callbacks.onEvent?.({ direction: "server", type: "response.done" });
  const captureEvents = () => {
    const listeners = audio.listeners("event");
    const delayed: DiscordAudioEvent[] = [];
    const capture = (event: DiscordAudioEvent) => delayed.push(event);
    audio.removeAllListeners("event");
    audio.on("event", capture);
    const restore = () => {
      audio.off("event", capture);
      listeners.forEach((listener) => audio.on("event", listener));
    };
    onTestFinished(() => {
      audio.off("event", capture);
    });
    return { delayed, restore };
  };
  return { fixture, audio, output, sender, send, retain, done, captureEvents };
}

it.each([0, 3])("preserves transferred PCM view bounds at offset %i", async (offset) => {
  const { audio, output, sender } = await createDirectPlaybackFixture();
  audio.send({ type: "output-hold", hold: true });
  const append = vi.spyOn(DiscordRealtimeOutput.prototype, "append");
  onTestFinished(() => append.mockRestore());
  const expected = Buffer.from(Array.from({ length: 9_600 }, (_, index) => index % 251));
  const storage = new ArrayBuffer(offset + expected.length + 7);
  new Uint8Array(storage).fill(0xfe);
  const transferred = new Uint8Array(storage, offset, expected.length);
  transferred.set(expected);
  const admitted = once(output.port, "message");
  output.port.postMessage({ type: "audio", audio: transferred }, [storage]);
  expect(storage.byteLength).toBe(0);
  await admitted;
  expect(append.mock.calls.map(([pcm]) => pcm)).toEqual([expected]);

  // Clear must retire the old converter before the next caller-owned chunk arrives.
  sender.clear();
  const borrowed = Buffer.from(expected);
  const next = once(output.port, "message");
  sender.sendAudio(borrowed);
  borrowed.fill(0);
  await next;
  expect(append.mock.calls.map(([pcm]) => pcm)).toEqual([expected, expected]);
  expect(append.mock.contexts[1]).not.toBe(append.mock.contexts[0]);

  Atomics.store(new Int32Array(output.state), 0, 1);
  const rejected = once(output.port, "message");
  const late = Uint8Array.from(expected);
  output.port.postMessage({ type: "audio", audio: late }, [late.buffer]);
  await rejected;
  expect(append).toHaveBeenCalledTimes(2);
});

it.each([true, false])("retains exact speech only while playback is held (%s)", async (hold) => {
  const { fixture, audio, send, retain } = await createDirectPlaybackFixture();
  fixture.playback.enqueueExactSpeechMessage("one answer");
  expect(fixture.sendUserMessage).toHaveBeenCalledWith("one answer");
  if (!hold) {
    // Delay main-thread delivery, not the media owner.
    audio.removeAllListeners("event");
  }
  audio.send({ type: "output-hold", hold });
  await send(Buffer.alloc(9_600, Buffer.from([0xe0, 0x2e]))); // int16le 12,000
  // The worker acknowledges after append, including its synchronous playback grant.
  expect(fixture.player.state.status === fixture.voiceSdk.AudioPlayerStatus.Idle).toBe(hold);
  if (!hold) {
    const state = fixture.player.state;
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("Expected an admitted playback resource");
    }
    if (state.resource.playStream.readableLength === 0) {
      await once(state.resource.playStream, "readable");
    }
    expect(state.resource.read()).toBeInstanceOf(Buffer);
  }
  expect(retain()).toEqual(hold ? [["one answer"]] : []);
});

it.each(["playback events", "flush receipt"])(
  "does not apply old direct %s to the next exact-speech request",
  async (receipt) => {
    const { fixture, audio, send, retain, done, captureEvents } =
      await createDirectPlaybackFixture();
    fixture.playback.enqueueExactSpeechMessage("old answer");
    const captured = receipt === "playback events" ? captureEvents() : undefined;
    const flushed = captured ? undefined : once(audio, "event");
    if (captured) {
      await send();
    } else {
      done();
    }
    fixture.playback.clearOutputAudio();
    captured?.restore();
    fixture.playback.enqueueExactSpeechMessage("next answer");
    if (captured) {
      expect(captured.delayed.map((event) => event.type)).toEqual(
        expect.arrayContaining(["continuous-start", "continuous-idle"]),
      );
      captured.delayed.forEach((event) => audio.emit("event", event));
    } else {
      expect((await flushed!)[0]).toMatchObject({ type: "continuous-flushed" });
    }
    expect(retain()).toEqual([["next answer"]]);
  },
);

it("keeps exact speech owned when response completion overtakes direct PCM", async () => {
  const { fixture, send, retain, done } = await createDirectPlaybackFixture();
  fixture.playback.enqueueExactSpeechMessage("in transit");
  const admitted = send();
  // This follows the legacy GPT-Live transcript completion through the real harness.
  done();
  const pendingBeforeAdmission = fixture.playback.retainedExactSpeechTexts();
  await admitted;
  expect(pendingBeforeAdmission).toEqual(["in transit"]);
  expect(retain()).toEqual([]);
});

it("releases a completed direct response with no PCM instead of wedging queued speech", async () => {
  const { fixture } = await createDirectPlaybackFixture();
  fixture.playback.enqueueExactSpeechMessage("empty response");
  const next = new Promise<void>((resolve) => {
    fixture.sendUserMessage.mockImplementation((text: string) => {
      if (text === "next answer") {
        resolve();
      }
    });
  });
  fixture.playback.enqueueExactSpeechMessage("next answer");
  fixture.callbacks.onEvent?.({ direction: "server", type: "response.done" });
  await next;
  expect(fixture.playback.retainedExactSpeechTexts()).toEqual(["next answer"]);
  expect(fixture.sendUserMessage.mock.calls).toEqual([["empty response"], ["next answer"]]);
});

it("ignores a late flush receipt after exact-speech ownership changes", async () => {
  const { fixture, audio, retain } = await createDirectPlaybackFixture();
  fixture.playback.enqueueExactSpeechMessage("old answer");
  const receipt = once(audio, "event");
  fixture.callbacks.onEvent?.({ direction: "server", type: "response.done" });
  fixture.playback.clearOutputAudio();
  fixture.playback.enqueueExactSpeechMessage("next answer");
  expect((await receipt)[0]).toMatchObject({ type: "continuous-flushed" });
  expect(retain()).toEqual([["next answer"]]);
});

it("waits for a pending direct flush when an older idle event arrives", async () => {
  const { fixture, audio, send, done, captureEvents } = await createDirectPlaybackFixture();
  fixture.playback.enqueueExactSpeechMessage("first answer");
  await send();
  fixture.playback.enqueueExactSpeechMessage("next answer");
  const { delayed, restore } = captureEvents();
  fixture.player.stop(true);
  restore();
  expect(delayed.map((event) => event.type)).toContain("continuous-idle");
  const admitted = send();
  done();
  delayed.forEach((event) => audio.emit("event", event));
  const requestsBeforeAdmission = fixture.sendUserMessage.mock.calls.map(([text]) => text);
  await admitted;
  expect(requestsBeforeAdmission).toEqual(["first answer"]);
});
