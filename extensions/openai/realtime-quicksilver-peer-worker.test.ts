import { once } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import { realtimeAudioTestEntrypoints } from "./realtime-audio-worker-entrypoints.test-support.js";
import type { QuicksilverAudioWorkerEvent } from "./realtime-quicksilver-peer.runtime.js";

const peerModule: typeof import("./realtime-quicksilver-peer.runtime.js") = await import(
  resolveRuntimeWorkerUrl(realtimeAudioTestEntrypoints.peer).href
);
const { OpenAIQuicksilverAudioPeer } = peerModule;

// Observe encrypted RTP on another event loop: a same-thread receiver would
// hide the gap by processing its queued callbacks after the deliberate stall.
const receiverSource = `const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { RTCPeerConnection, useOPUS } = await import(workerData.weriftUrl);
  const peer = new RTCPeerConnection({ codecs: { audio: [useOPUS({ payloadType: 111 })], video: [] }, iceServers: [] });
  const transceiver = peer.addTransceiver('audio', { direction: 'sendrecv' });
  const counts = new Int32Array(workerData.counts);
  if (workerData.output) {
    const { port, state } = workerData.output;
    const fence = new Int32Array(state);
    port.on('message', message => {
      if (message.type !== 'audio') return;
      if (Atomics.load(fence, 0) === 0) {
        Atomics.add(counts, 1, 1);
        const audio = Buffer.from(message.audio);
        for (let offset = 0; offset + 1 < audio.length; offset += 2) {
          if (Math.abs(audio.readInt16LE(offset)) > 1000) Atomics.add(counts, 2, 1);
        }
      }
      port.postMessage({ type: 'ack' });
    });
  }
  peer.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => {
    Atomics.add(counts, 0, 1);
    void transceiver.sender.sendRtp(packet);
  }));
  parentPort.on('message', async message => {
    if (message.type === 'offer') {
      await peer.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      await peer.setLocalDescription(await peer.createAnswer());
      parentPort.postMessage(peer.localDescription.sdp);
    }
  });
  parentPort.postMessage('ready');
})().catch(error => { throw error; });`;

// Inject a deterministic RTP gap inside the actual worker's event loop. Clearing
// in the same turn avoids racing the 80 ms reorder timer on a loaded test host.
const interruptionSource = `const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  if (workerData.tsxApiUrl) {
    const { register } = await import(workerData.tsxApiUrl);
    register();
  }
  const { OpenAIQuicksilverAudioPeer } = await import(workerData.mediaUrl);
  const { RtpHeader, RtpPacket } = await import(workerData.weriftUrl);
  const create = OpenAIQuicksilverAudioPeer.create;
  OpenAIQuicksilverAudioPeer.create = async options => {
    const peer = await create.call(OpenAIQuicksilverAudioPeer, options);
    peer.state.decoder.decode = opus => new Int16Array(960 * 2).fill(opus[0] === 13 ? 0 : 12000);
    peer.state.decoder.decodePacketLoss = () => new Int16Array(960 * 2).fill(12000);
    const receive = sequenceNumber => peer.handleInboundRtp(new RtpPacket(
      new RtpHeader({ payloadType: 111, sequenceNumber, ssrc: 1, timestamp: sequenceNumber * 960 }),
      Buffer.from([sequenceNumber]),
    ));
    parentPort.on('message', message => {
      if (message.type === 'test-clear') {
        receive(10);
        receive(12);
        parentPort.emit('message', { type: 'clear-output', generation: 1 });
        setTimeout(() => parentPort.postMessage({ type: 'test-drained' }), 100);
      } else if (message.type === 'test-resume') {
        receive(11);
        receive(12);
        receive(13);
        parentPort.postMessage({ type: 'test-resumed' });
      }
    });
    return peer;
  };
  await import(workerData.workerUrl);
})().catch(error => { throw error; });`;

describe("GPT-Live audio thread", () => {
  it("does not restamp pre-clear reordered RTP as the next output generation", async () => {
    const workerUrl = resolveRuntimeWorkerUrl(realtimeAudioTestEntrypoints.worker);
    const worker = new Worker(interruptionSource, {
      eval: true,
      // Source fallback registers inside the worker; prepared children need no loader.
      execArgv: [],
      workerData: {
        iceServers: [],
        reportMediaErrors: false,
        workerUrl: workerUrl.href,
        tsxApiUrl: workerUrl.pathname.endsWith(".ts")
          ? import.meta.resolve("tsx/esm/api")
          : undefined,
        mediaUrl: resolveRuntimeWorkerUrl(realtimeAudioTestEntrypoints.media).href,
        weriftUrl: pathToFileURL(createRequire(import.meta.url).resolve("werift")).href,
      },
    });
    const events: (QuicksilverAudioWorkerEvent | { type: "test-drained" | "test-resumed" })[] = [];
    const post = (message: { type: string }) => {
      // Node Worker messages have no browser targetOrigin.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage(message);
    };
    try {
      expect((await once(worker, "message"))[0]).toEqual({ type: "ready" });
      worker.on("message", (message: (typeof events)[number]) => {
        events.push(message);
        if (message.type === "audio") {
          post({ type: "audio-ack" });
        }
      });
      post({ type: "test-clear" });
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe("test-drained"));
      const beforeResume = events.filter((event) => event.type === "audio");
      expect(beforeResume.map((event) => event.generation)).toEqual([0]);

      post({ type: "test-resume" });
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe("test-resumed"));
      const audio = events.filter((event) => event.type === "audio");
      expect(audio.map((event) => event.generation)).toEqual([0, 1]);
      expect(Buffer.from(audio[1]!.audio)).toEqual(Buffer.alloc((480 - 7) * 2));
      expect(events.filter((event) => event.type === "error")).toEqual([]);
    } finally {
      await worker.terminate();
    }
  }, 15_000);

  it("fences already-posted PCM at interruption while accepting the next output generation", async () => {
    const audio: Buffer[] = [];
    const peer = await OpenAIQuicksilverAudioPeer.create({
      iceServers: [],
      callbacks: {
        onAudio: (chunk) => audio.push(chunk),
        onError: (error) => {
          throw error;
        },
      },
    });
    try {
      const worker = (peer as unknown as { worker: Worker }).worker;
      peer.clearOutputAudio();
      // Emulate PCM already queued on the real Worker emitter when sideband clear
      // ran first. A worker command alone cannot recall these posted messages.
      worker.emit("message", { type: "audio", audio: new Uint8Array([1, 2]), generation: 0 });
      expect(audio).toEqual([]);
      worker.emit("message", { type: "audio", audio: new Uint8Array([3, 4]), generation: 1 });
      expect(audio).toEqual([Buffer.from([3, 4])]);
    } finally {
      peer.close();
    }
  }, 15_000);

  it("cancels startup and rejects SDP work after close without late callbacks", async () => {
    const controller = new AbortController();
    const errors: Error[] = [];
    const callbacks = { onAudio: () => {}, onError: (error: Error) => errors.push(error) };
    const starting = OpenAIQuicksilverAudioPeer.create({
      callbacks,
      iceServers: [],
      signal: controller.signal,
    });
    const reason = new Error("call cancelled during worker startup");
    controller.abort(reason);
    await expect(starting).rejects.toBe(reason);

    const peer = await OpenAIQuicksilverAudioPeer.create({ callbacks, iceServers: [] });
    const offer = peer.createOffer();
    peer.close();
    peer.close();
    await expect(offer).rejects.toThrow("closed");
    await expect(peer.createOffer()).rejects.toThrow("closed");
    peer.sendAudio(Buffer.alloc(960));
    expect(errors).toEqual([]);
  }, 15_000);

  it.each([false, true])(
    "keeps RTP and media delivery running during a blocked Gateway (direct sink: %s)",
    async (direct) => {
      const counts = new Int32Array(new SharedArrayBuffer(12));
      const channel = direct ? new MessageChannel() : undefined;
      const state = new SharedArrayBuffer(4);
      const receiver = new Worker(receiverSource, {
        eval: true,
        transferList: channel ? [channel.port1] : [],
        workerData: {
          counts: counts.buffer,
          output: channel ? { port: channel.port1, state } : undefined,
          weriftUrl: pathToFileURL(createRequire(import.meta.url).resolve("werift")).href,
        },
      });
      const errors: Error[] = [];
      let audibleSamples = 0;
      let failAudioSink = false;
      const sinkError = new Error("audio consumer failed");
      let peer: Awaited<ReturnType<typeof OpenAIQuicksilverAudioPeer.create>> | undefined;
      try {
        await once(receiver, "message");
        peer = await OpenAIQuicksilverAudioPeer.create({
          output: channel ? { port: channel.port2, state } : undefined,
          callbacks: {
            onAudio: (audio) => {
              if (direct) {
                throw new Error("Direct PCM returned to the Gateway event loop");
              }
              if (failAudioSink) {
                throw sinkError;
              }
              for (let offset = 0; offset + 1 < audio.length; offset += 2) {
                if (Math.abs(audio.readInt16LE(offset)) > 1_000) {
                  audibleSamples++;
                }
              }
            },
            onError: (error) => errors.push(error),
          },
          iceServers: [],
        });
        const tone = Buffer.alloc(24_000 * 2);
        for (let sample = 0; sample < 24_000; sample++) {
          tone.writeInt16LE(
            Math.round(12_000 * Math.sin((sample * 2 * Math.PI * 440) / 24_000)),
            sample * 2,
          );
        }
        peer.sendAudio(tone);
        tone.fill(0); // Capture may immediately recycle this caller-owned buffer.
        const answer = once(receiver, "message");
        // Node Worker messaging has no browser targetOrigin.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        receiver.postMessage({ type: "offer", sdp: await peer.createOffer() });
        await peer.applyAnswer((await answer)[0] as string);
        const observedAudibleSamples = () => (direct ? Atomics.load(counts, 2) : audibleSamples);
        const deadline = Date.now() + 10_000;
        while (
          (Atomics.load(counts, 0) < 5 || observedAudibleSamples() < 1_000) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
        }
        expect(Atomics.load(counts, 0)).toBeGreaterThanOrEqual(5);
        expect(observedAudibleSamples()).toBeGreaterThan(1_000);
        const before = Atomics.load(counts, 0);
        const outputBefore = Atomics.load(counts, 1);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        const duringStall = Atomics.load(counts, 0) - before;
        // 25 nominal 20ms packets; tolerate loaded CI, but not a stopped pump.
        console.info(`RTP packets during 500 ms Gateway stall: ${duringStall}`);
        expect(duringStall).toBeGreaterThanOrEqual(10);
        expect(errors).toEqual([]);
        if (direct) {
          const mediaDuringStall = Atomics.load(counts, 1) - outputBefore;
          console.info(
            "PCM messages reaching the playback worker during stall: " + mediaDuringStall,
          );
          expect(mediaDuringStall).toBeGreaterThanOrEqual(10);
          peer.close();
          expect(Atomics.load(new Int32Array(state), 0)).toBe(1);
          const afterClose = Atomics.load(counts, 1);
          await new Promise((resolve) => {
            setTimeout(resolve, 80);
          });
          expect(Atomics.load(counts, 1)).toBe(afterClose);
          return;
        }
        failAudioSink = true;
        const failureDeadline = Date.now() + 2_000;
        while (errors.length === 0 && Date.now() < failureDeadline) {
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
        }
        expect(errors).toEqual([sinkError]);
        await expect(peer.createOffer()).rejects.toThrow("closed");
      } finally {
        peer?.close();
        await receiver.terminate();
      }
    },
    30_000,
  );
});
