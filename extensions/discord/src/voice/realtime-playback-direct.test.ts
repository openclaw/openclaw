import { once } from "node:events";
import { createRealtimeVoiceAudioPortSender } from "openclaw/plugin-sdk/realtime-voice";
import { expect, it, vi } from "vitest";
import type { DiscordAudioEvent } from "./audio-worker-protocol.js";
import { createRealtimePlaybackFixture } from "./realtime-playback.integration.test-support.js";

it.each([
  { playback: "unheard", hold: true, delayEvents: false },
  { playback: "started", hold: false, delayEvents: false },
  { playback: "started before main receives its events", hold: false, delayEvents: true },
])("retains only unheard direct exact speech when $playback", async ({ hold, delayEvents }) => {
  const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
  const audio = fixture.roomPlayer.audio;
  const output = fixture.playback.createOutputAudioPort();
  const sender = createRealtimeVoiceAudioPortSender(output);
  const successor = { deliverRetainedSpeech: vi.fn() };
  try {
    fixture.playback.enqueueExactSpeechMessage("one answer");
    expect(fixture.sendUserMessage).toHaveBeenCalledWith("one answer");
    if (delayEvents) {
      // The media owner still runs; only delivery to main-thread consumers is delayed.
      for (const listener of audio.listeners("event")) {
        audio.off("event", listener);
      }
    }
    audio.send({ type: "output-hold", hold });
    const tone = Buffer.alloc(9_600);
    for (let offset = 0; offset < tone.length; offset += 2) {
      tone.writeInt16LE(12_000, offset);
    }
    const admitted = once(output.port, "message");
    sender.sendAudio(tone);
    await admitted;
    // The worker acknowledges after append, including its synchronous playback grant.
    expect(fixture.player.state.status === fixture.voiceSdk.AudioPlayerStatus.Idle).toBe(hold);
    fixture.closeSpeaker(true);
    fixture.playback.transferPendingSpeechTo(successor);
    expect(successor.deliverRetainedSpeech.mock.calls).toEqual(hold ? [["one answer"]] : []);
  } finally {
    sender.close();
    fixture.close();
  }
});

it("does not apply old direct playback events to the next exact-speech request", async () => {
  const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
  const audio = fixture.roomPlayer.audio;
  const output = fixture.playback.createOutputAudioPort();
  const sender = createRealtimeVoiceAudioPortSender(output);
  const successor = { deliverRetainedSpeech: vi.fn() };
  const listeners = audio.listeners("event");
  const delayed: DiscordAudioEvent[] = [];
  const capture = (event: DiscordAudioEvent) => delayed.push(event);
  try {
    fixture.playback.enqueueExactSpeechMessage("old answer");
    for (const listener of listeners) {
      audio.off("event", listener);
    }
    audio.on("event", capture);
    const admitted = once(output.port, "message");
    sender.sendAudio(Buffer.alloc(9_600, 0x20));
    await admitted;
    fixture.playback.clearOutputAudio();
    expect(delayed.map((event) => event.type)).toContain("continuous-start");
    expect(delayed.map((event) => event.type)).toContain("continuous-idle");
    audio.off("event", capture);
    for (const listener of listeners) {
      audio.on("event", listener);
    }
    fixture.playback.enqueueExactSpeechMessage("next answer");
    for (const event of delayed) {
      audio.emit("event", event);
    }
    fixture.closeSpeaker(true);
    fixture.playback.transferPendingSpeechTo(successor);
    expect(successor.deliverRetainedSpeech.mock.calls).toEqual([["next answer"]]);
  } finally {
    audio.off("event", capture);
    sender.close();
    fixture.close();
  }
});

it("keeps exact speech owned when response completion overtakes direct PCM", async () => {
  const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
  const output = fixture.playback.createOutputAudioPort();
  const sender = createRealtimeVoiceAudioPortSender(output);
  const successor = { deliverRetainedSpeech: vi.fn() };
  try {
    fixture.playback.enqueueExactSpeechMessage("in transit");
    const admitted = once(output.port, "message");
    sender.sendAudio(Buffer.alloc(9_600, 0x20));
    // This follows the legacy GPT-Live transcript completion through the real harness.
    fixture.callbacks.onEvent?.({ direction: "server", type: "response.done" });
    const pendingBeforeAdmission = fixture.playback.retainedExactSpeechTexts();
    await admitted;
    expect(pendingBeforeAdmission).toEqual(["in transit"]);
    fixture.closeSpeaker(true);
    fixture.playback.transferPendingSpeechTo(successor);
    expect(successor.deliverRetainedSpeech).not.toHaveBeenCalled();
  } finally {
    sender.close();
    fixture.close();
  }
});

it("releases a completed direct response with no PCM instead of wedging queued speech", async () => {
  const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
  const sender = createRealtimeVoiceAudioPortSender(fixture.playback.createOutputAudioPort());
  try {
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
  } finally {
    sender.close();
    fixture.close();
  }
});

it("ignores a late flush receipt after exact-speech ownership changes", async () => {
  const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
  const audio = fixture.roomPlayer.audio;
  const sender = createRealtimeVoiceAudioPortSender(fixture.playback.createOutputAudioPort());
  const successor = { deliverRetainedSpeech: vi.fn() };
  try {
    fixture.playback.enqueueExactSpeechMessage("old answer");
    const receipt = once(audio, "event");
    fixture.callbacks.onEvent?.({ direction: "server", type: "response.done" });
    fixture.playback.clearOutputAudio();
    fixture.playback.enqueueExactSpeechMessage("next answer");
    expect((await receipt)[0]).toMatchObject({ type: "continuous-flushed" });
    fixture.closeSpeaker(true);
    fixture.playback.transferPendingSpeechTo(successor);
    expect(successor.deliverRetainedSpeech.mock.calls).toEqual([["next answer"]]);
  } finally {
    sender.close();
    fixture.close();
  }
});

it("waits for a pending direct flush when an older idle event arrives", async () => {
  const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
  const audio = fixture.roomPlayer.audio;
  const output = fixture.playback.createOutputAudioPort();
  const sender = createRealtimeVoiceAudioPortSender(output);
  const delayed: DiscordAudioEvent[] = [];
  const capture = (event: DiscordAudioEvent) => delayed.push(event);
  try {
    fixture.playback.enqueueExactSpeechMessage("first answer");
    const first = once(output.port, "message");
    sender.sendAudio(Buffer.alloc(9_600, 0x20));
    await first;
    fixture.playback.enqueueExactSpeechMessage("next answer");
    const listeners = audio.listeners("event");
    for (const listener of listeners) {
      audio.off("event", listener);
    }
    audio.on("event", capture);
    fixture.player.stop(true);
    audio.off("event", capture);
    for (const listener of listeners) {
      audio.on("event", listener);
    }
    expect(delayed.map((event) => event.type)).toContain("continuous-idle");
    const admitted = once(output.port, "message");
    sender.sendAudio(Buffer.alloc(9_600, 0x20));
    fixture.callbacks.onEvent?.({ direction: "server", type: "response.done" });
    for (const event of delayed) {
      audio.emit("event", event);
    }
    const requestsBeforeAdmission = fixture.sendUserMessage.mock.calls.map(([text]) => text);
    await admitted;
    expect(requestsBeforeAdmission).toEqual(["first answer"]);
  } finally {
    audio.off("event", capture);
    sender.close();
    fixture.close();
  }
});
