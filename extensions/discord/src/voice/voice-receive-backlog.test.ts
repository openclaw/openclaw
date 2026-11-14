import { AudioReceiveStream, EndBehaviorType } from "@discordjs/voice";
import { createEncoder } from "libopus-wasm";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests((h) => {
  const { expect, it, vi } = h;
  const receiveFixture = async (
    mode: "stt-tts" | "agent-proxy",
    audio: { enabled?: boolean; maxBytes?: number },
    stage?: "admission" | "decoder",
    config?: Parameters<typeof h.createAgentProxyManager>[1],
  ) => {
    const actual = await vi.importActual<typeof import("./audio.js")>("./audio.js");
    const blocked = createDeferred<void>();
    h.decodeOpusStreamChunksMock.mockImplementation(async (input, params) => {
      if (stage === "decoder") {
        await blocked.promise;
      }
      await actual.decodeOpusStreamChunks(input, params);
    });
    const client = h.createClientWithMember("u-speaker", "Speaker", "0");
    const connection = h.useConnection();
    const cfg = { tools: { media: { audio } } };
    const allowFrom = ["discord:u-speaker"];
    const manager =
      mode === "stt-tts"
        ? h.createManager(h.makeVoiceConfig({}, { groupPolicy: "open", allowFrom }), client, cfg)
        : h.createAgentProxyManager(client, { allowFrom, ...config }, cfg);
    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = h.getSessionEntry(manager);
    const open = () => {
      const stream = new AudioReceiveStream({ end: { behavior: EndBehaviorType.Manual } });
      connection.receiver.subscribe.mockReturnValueOnce(stream);
      return { stream, receiving: h.handleSpeakingStart(manager, entry, "u-speaker") };
    };
    return { actual, blocked, client, connection, manager, entry, open };
  };
  const silencePacket = Buffer.from([0xf8, 0xff, 0xfe]);
  const pushPackets = (stream: AudioReceiveStream, count: number, packet = silencePacket) => {
    for (let frame = 0; frame < count; frame++) {
      stream.push(packet);
    }
  };
  it.each([
    ["packets", "admission", true],
    ["packets", "decoder", true],
    ["bytes", "decoder", true],
    ["bytes", "decoder", false],
  ] as const)("bounds %s during %s (batch transcription=%s)", async (bound, stage, enabled) => {
    const packets = bound === "packets";
    const { blocked, client, connection, manager, entry, open } = await receiveFixture(
      packets ? "stt-tts" : "agent-proxy",
      packets ? { maxBytes: 192_044 } : { enabled },
      stage,
    );
    const sink = vi.fn();
    if (packets) {
      await h.startTranscripts(manager, sink);
    }
    const capture = entry.transcripts;
    const conversations = packets ? vi.spyOn(entry.conversations, "enqueue") : undefined;
    if (stage === "admission") {
      client.fetchMember.mockImplementationOnce(async () => {
        await blocked.promise;
        return { user: { id: "u-speaker" } };
      });
    }
    const { stream, receiving } = open();
    try {
      if (packets) {
        // UDP ignores backpressure; valid silence must stay bounded before admission/decode settles.
        pushPackets(stream, 2_000);
      } else {
        await vi.waitFor(() => expect(connection.receiver.subscribe).toHaveBeenCalled());
        const encoder = await createEncoder({ bitrate: 512_000, vbr: false });
        try {
          // High-bitrate Opus crosses the byte bound before the packet-count bound.
          const packet = Buffer.from(encoder.encode(new Int16Array(1_920), { frameSize: 960 }));
          pushPackets(stream, 950, packet);
        } finally {
          encoder.free();
        }
      }
      await vi.waitFor(() => expect(stream.destroyed).toBe(true));
      expect(h.loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining("receive backlog"));
      if (packets) {
        expect(entry.capture.size).toBe(0);
      }
      blocked.resolve();
      await receiving;
      if (packets) {
        await entry.processingQueue;
      }
      expect(h.transcribeAudioFileMock).not.toHaveBeenCalled();
      expect(h.agentCommandMock).not.toHaveBeenCalled();
      expect(entry).toMatchObject({ capture: { size: 0 }, sessionLifecycle: { status: "active" } });
      if (packets) {
        expect(h.controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
        expect(sink).not.toHaveBeenCalled();
        expect(entry.transcripts).toBe(capture);
        const { stream: next, receiving: resumed } = open();
        pushPackets(next, 20);
        next.push(null);
        await resumed;
        await entry.processingQueue;
        const queued = h.expectDefined(conversations, "conversation queue spy").mock.results;
        await Promise.all(queued.map((result) => result.value));
        expect(sink).toHaveBeenCalledOnce();
        expect(h.agentCommandMock).toHaveBeenCalledOnce();
      }
    } finally {
      stream.destroy();
      blocked.resolve();
      await receiving;
      await entry.processingQueue;
    }
  });

  it.each(["backlog", "decoder", "stream"] as const)(
    "retires only the incomplete realtime speaker after a %s failure",
    async (failure) => {
      const audio = await import("./audio.js");
      const { actual, manager, entry, open } = await receiveFixture(
        "agent-proxy",
        { maxBytes: 3_884 },
        undefined,
        { voice: { realtime: { requireWakeName: false } } },
      );
      const diskStarted = createDeferred<void>();
      const diskReady = createDeferred<void>();
      const write = vi.spyOn(audio, "writeVoiceWavFile").mockImplementationOnce(async (pcm) => {
        diskStarted.resolve();
        await diskReady.promise;
        return await actual.writeVoiceWavFile(pcm);
      });
      await h.startTranscripts(manager);
      const capture = entry.transcripts;
      h.beginSpeakerTurn(entry, { userId: "u-other", senderIsOwner: false }).close();
      const other = h.lastRealtimeBridge();
      const { stream, receiving } = open();
      try {
        stream.push(silencePacket);
        await diskStarted.promise;
        const interrupted = h.lastRealtimeBridge();
        expect(interrupted.session).not.toBe(other.session);
        if (failure === "backlog") {
          pushPackets(stream, 2_000);
        } else if (failure === "decoder") {
          stream.push(Buffer.from([0xff]));
          diskReady.resolve();
          await receiving;
        } else {
          stream.destroy(new Error("socket"));
        }
        await vi.waitFor(() => expect(stream.destroyed).toBe(true));
        await h.emitFinalRealtimeUserTranscript(interrupted.bridgeParams, "incomplete request");
        expect(h.agentCommandMock).not.toHaveBeenCalled();
        expect(interrupted.session.close).toHaveBeenCalledOnce();
        expect(other.session.close).not.toHaveBeenCalled();
        expect(entry.transcripts).toBe(capture);
        expect(entry.sessionLifecycle.status).toBe("active");
        await h.emitFinalRealtimeUserTranscript(other.bridgeParams, "Read the complete request");
        expect(h.agentCommandMock).toHaveBeenCalledOnce();
        diskReady.resolve();
        await receiving;
        await entry.processingQueue;
        expect(h.agentCommandMock).toHaveBeenCalledOnce();
        expect(entry.capture.size).toBe(0);
      } finally {
        diskReady.resolve();
        stream.destroy();
        await receiving;
        await entry.processingQueue;
        write.mockRestore();
      }
    },
  );
});
