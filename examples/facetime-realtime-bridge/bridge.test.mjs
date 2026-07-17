import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTruncateEvent,
  buildSessionUpdate,
  buildSoxOutputArguments,
  calculatePlayedAudioMs,
  chooseOutputDevice,
  findAudioRouteProblems,
  parseArguments,
  parseBridgeOutputDevices,
  playbackQueueWouldOverflow,
  readAudioDelta,
  resolveOutputDevice,
  sanitizedChildEnv,
  schedulePlaybackSegment,
  websocketQueueWouldOverflow,
} from "./bridge.mjs";

test("parses bridge output devices and prefers the paired OpenClaw feed", () => {
  const devices = parseBridgeOutputDevices(`
        BlackHole 16ch:
          Manufacturer: Existential Audio Inc.
        OpenClaw-Feed:
          Manufacturer: Existential Audio Inc.
        OpenClaw-Mic:
          Manufacturer: Existential Audio Inc.
        OpenClaw BlackHole Output:
          Manufacturer: Apple Inc.
        BlackHole 2ch:
          Manufacturer: Existential Audio Inc.
  `);
  assert.deepEqual(devices, [
    "BlackHole 16ch",
    "OpenClaw-Feed",
    "OpenClaw BlackHole Output",
    "BlackHole 2ch",
  ]);
  assert.equal(chooseOutputDevice(devices), "OpenClaw-Feed");
});

test("falls back to an installed multichannel BlackHole device", () => {
  assert.equal(chooseOutputDevice(["BlackHole 16ch"]), "BlackHole 16ch");
});

test("rejects an explicitly selected device that is not installed", () => {
  assert.throws(
    () => resolveOutputDevice("BlackHole typo", ["BlackHole 16ch"]),
    /Bridge output device not found: BlackHole typo/u,
  );
});

test("accepts the paired OpenClaw driver with an independent system input", () => {
  assert.deepEqual(
    findAudioRouteProblems({
      bridgeOutputDevice: "OpenClaw-Feed",
      input: { name: "MacBook Air Microphone" },
      output: { isAggregate: true, name: "An unrelated system default" },
    }),
    [],
  );
});

test("accepts a dedicated BlackHole input with physical call output", () => {
  assert.deepEqual(
    findAudioRouteProblems({
      bridgeOutputDevice: "BlackHole 2ch",
      input: { name: "BlackHole 2ch" },
      output: { isAggregate: false, name: "MacBook Air Speakers" },
    }),
    [],
  );
});

test("rejects an aggregate call output and a mismatched input", () => {
  assert.deepEqual(
    findAudioRouteProblems({
      bridgeOutputDevice: "BlackHole 2ch",
      input: { name: "MacBook Air Microphone" },
      output: { isAggregate: true, name: "OpenClaw BlackHole Output" },
    }),
    [
      "System input is MacBook Air Microphone; set it to BlackHole 2ch so FaceTime receives model speech.",
      "System output is aggregate device OpenClaw BlackHole Output; select physical speakers or headphones because FaceTime Voice Processing rejects this input/output pair.",
    ],
  );
});

test("builds the current GA Realtime PCM session shape", () => {
  const event = buildSessionUpdate({
    instructions: "brief",
    model: "gpt-realtime-2.1",
    voice: "marin",
  });
  assert.equal(event.type, "session.update");
  assert.equal(event.session.type, "realtime");
  assert.equal("model" in event.session, false);
  assert.equal(event.session.audio.input.format.rate, 24000);
  assert.equal(event.session.audio.output.format.rate, 24000);
  assert.equal(event.session.audio.input.turn_detection.interrupt_response, true);
  assert.deepEqual(event.session.output_modalities, ["audio"]);
});

test("accepts current and compatibility output-audio events", () => {
  assert.equal(readAudioDelta({ type: "response.output_audio.delta", delta: "YQ==" }), "YQ==");
  assert.equal(readAudioDelta({ type: "response.audio.delta", delta: "Yg==" }), "Yg==");
  assert.equal(readAudioDelta({ type: "conversation.output_audio.delta", data: "Yw==" }), "Yw==");
  assert.equal(readAudioDelta({ type: "response.done", delta: "ZA==" }), undefined);
});

test("passes raw mono PCM to the selected CoreAudio device", () => {
  const args = buildSoxOutputArguments("BlackHole 16ch");
  assert.deepEqual(args.slice(-3), ["-t", "coreaudio", "BlackHole 16ch"]);
  assert.equal(args[args.indexOf("--buffer") + 1], "480");
  assert.ok(args.includes("24000"));
  assert.ok(args.includes("signed-integer"));
});

test("PCM output timing is 48 bytes per millisecond", () => {
  const oneSecond = Buffer.alloc(24_000 * 2);
  assert.equal(oneSecond.byteLength / 48, 1000);
});

test("does not expose the OpenAI key to audio child processes", () => {
  assert.deepEqual(sanitizedChildEnv({ OPENAI_API_KEY: "x", PATH: "/bin" }), {
    PATH: "/bin",
  });
});

test("bounds caller audio queued by a stalled WebSocket", () => {
  assert.equal(websocketQueueWouldOverflow(500_000, 1_000), false);
  assert.equal(websocketQueueWouldOverflow(524_000, 1_000), true);
});

test("allows a normal generated reply but bounds a stalled bridge output", () => {
  assert.equal(playbackQueueWouldOverflow(2_000_000, 1_000), false);
  assert.equal(playbackQueueWouldOverflow(2_097_000, 1_000), true);
});

test("truncates interrupted conversation history at played audio", () => {
  const first = schedulePlaybackSegment({
    audioDurationMs: 100,
    generatedAudioMs: 0,
    nowMs: 1000,
    playbackUntilMs: 0,
  });
  const afterUnderrun = schedulePlaybackSegment({
    audioDurationMs: 100,
    generatedAudioMs: first.audioEndMs,
    nowMs: 1300,
    playbackUntilMs: first.wallEndMs,
  });
  const segments = [first, afterUnderrun];
  const audioEndMs = calculatePlayedAudioMs({ nowMs: 1450, segments });
  assert.deepEqual(buildTruncateEvent({ audioEndMs, contentIndex: 2, itemId: "item_1" }), {
    type: "conversation.item.truncate",
    item_id: "item_1",
    content_index: 2,
    audio_end_ms: 150,
  });
  assert.equal(calculatePlayedAudioMs({ nowMs: 1050, segments }), 0);
  assert.equal(calculatePlayedAudioMs({ nowMs: 1350, segments }), 100);
  assert.equal(calculatePlayedAudioMs({ nowMs: 2000, segments }), 200);
});

test("parses explicit bridge options", () => {
  const options = parseArguments([
    "--doctor",
    "--preflight",
    "--model",
    "gpt-realtime",
    "--voice",
    "cedar",
    "--output-device",
    "BlackHole 16ch",
  ]);
  assert.equal(options.doctor, true);
  assert.equal(options.preflight, true);
  assert.equal(options.model, "gpt-realtime");
  assert.equal(options.voice, "cedar");
  assert.equal(options.outputDevice, "BlackHole 16ch");
});

test("accepts pnpm's leading argument separator", () => {
  const options = parseArguments(["--", "--output-device", "BlackHole 16ch"]);
  assert.equal(options.outputDevice, "BlackHole 16ch");
});
