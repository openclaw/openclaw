import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createClient,
    createManager,
    getSessionEntry,
    startTranscripts,
    stopTranscripts,
    handleSpeakingStart,
    decodeOpusStreamChunksMock,
    transcribeAudioFileMock,
    realtimeSessionMock,
    agentCommandMock,
    controlRealtimeVoiceAgentRunMock,
    lastRealtimeBridgeParams,
    emitFinalRealtimeUserTranscript,
    configureVoiceStateGateway,
    updateVoiceState,
  }) => {
    async function fixture(
      mode: "agent-proxy" | "bidi" | "stt-tts" = "agent-proxy",
      occupied = false,
      cfg: OpenClawConfig = {},
    ) {
      const client = createClient();
      client.fetchMember.mockImplementation(async (_guildId, userId) => ({
        nickname: userId === "100000000000000001" ? "Owner" : "Guest",
        roles: [],
        user: { id: userId },
      }));
      const states = [
        {
          user_id: "100000000000000001",
          channel_id: "1001",
          member: { user: { id: "100000000000000001", bot: false } },
        },
      ];
      if (occupied) {
        configureVoiceStateGateway(client, () => states);
      }
      const manager = createManager(
        {
          groupPolicy: "open",
          guilds: { g1: { channels: { "1001": { users: ["100000000000000001"] } } } },
          voice: {
            enabled: true,
            mode,
            realtime: { provider: "openai", requireWakeName: true },
            ...(occupied
              ? { autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }] }
              : {}),
          },
        },
        client,
        { ...cfg, commands: { ownerAllowFrom: ["discord:100000000000000001"] } },
      );
      if (occupied) {
        await manager.autoJoin();
      } else {
        await manager.join({ guildId: "g1", channelId: "1001" });
      }
      const entry = getSessionEntry(manager);
      const streams = new Map<string, PassThrough>();
      entry.connection.receiver.subscribe.mockImplementation((userId: string) => {
        const stream = new PassThrough({ objectMode: true });
        streams.set(userId, stream);
        return stream;
      });
      decodeOpusStreamChunksMock.mockImplementation(async (stream, params) => {
        try {
          for await (const chunk of stream) {
            await params.onChunk(chunk, chunk);
          }
        } catch (error) {
          params.onError?.(error);
        }
      });
      transcribeAudioFileMock.mockImplementation(async ({ filePath }) => {
        const wav = await fs.readFile(filePath);
        return { text: `audio-${wav[44]}-${wav.length - 44}` };
      });
      const sink = vi.fn();
      const begin = (userId: string) => handleSpeakingStart(manager, entry, userId);
      const audio = async (userId: string, marker: number) => {
        const receiving = begin(userId);
        await vi.waitFor(() => expect(streams.has(userId)).toBe(true));
        streams.get(userId)!.end(Buffer.alloc(96_000, marker));
        await receiving;
        await entry.processingQueue;
      };
      return { client, manager, entry, streams, sink, begin, audio, states };
    }

    it.each(["agent-proxy", "bidi"] as const)(
      "records overlapping participants once with receiver IDs in %s",
      async (mode) => {
        const f = await fixture(mode);
        await startTranscripts(f.manager, f.sink);
        const starts = ["100000000000000001", "guest-a", "guest-b"].map(f.begin);
        // The packet that triggered speaking.start is delivered immediately after the listener.
        expect([...f.streams.keys()]).toEqual(["100000000000000001", "guest-a", "guest-b"]);
        for (const [index, stream] of [...f.streams.values()].entries()) {
          stream.end(Buffer.alloc(96_000, index + 1));
        }
        await Promise.all(starts);
        await f.entry.processingQueue;
        expect(
          f.sink.mock.calls
            .map(([u]) => [u.speaker.id, u.speaker.label, u.text])
            .toSorted(([leftSpeakerId], [rightSpeakerId]) =>
              leftSpeakerId.localeCompare(rightSpeakerId),
            ),
        ).toEqual([
          ["100000000000000001", "Owner", "audio-1-96000"],
          ["guest-a", "Guest", "audio-2-96000"],
          ["guest-b", "Guest", "audio-3-96000"],
        ]);
        expect(decodeOpusStreamChunksMock).toHaveBeenCalledTimes(3);
        expect(transcribeAudioFileMock).toHaveBeenCalledTimes(3);
        expect(realtimeSessionMock.sendAudio).toHaveBeenCalled();
        await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "ambient mixed final");
        await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "second mixed final");
        expect(f.sink).toHaveBeenCalledTimes(3);
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
      },
    );

    it("records protected-playback speech without interruption or conversational fallthrough", async () => {
      const f = await fixture();
      await startTranscripts(f.manager, f.sink);
      f.entry.player.state.status = "playing";
      const stopCalls = f.entry.player.stop.mock.calls.length;
      await Promise.all([f.audio("100000000000000001", 1), f.audio("guest", 2)]);
      expect(f.sink).toHaveBeenCalledTimes(2);
      expect(f.entry.player.stop).toHaveBeenCalledTimes(stopCalls);
      expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
      expect(f.entry.player.play).not.toHaveBeenCalled();
    });

    it("shares one batch transcription between recording and authorized conversation", async () => {
      const f = await fixture("stt-tts");
      await startTranscripts(f.manager, f.sink);
      await f.audio("100000000000000001", 1);
      await f.audio("guest", 2);
      expect(transcribeAudioFileMock).toHaveBeenCalledTimes(2);
      expect(f.sink).toHaveBeenCalledTimes(2);
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
      expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
    });

    it.each(["normal", "decoder failure"])(
      "finalizes batch conversation after %s utterance end",
      async (ending) => {
        const f = await fixture("stt-tts", false, {
          tools: { media: { audio: { maxBytes: 192_044 } } },
        });
        if (ending === "decoder failure") {
          decodeOpusStreamChunksMock.mockImplementation(async (input, params) => {
            for await (const packet of input) {
              if (packet[0] === 2) {
                params.onError?.(new Error("memory access out of bounds"));
                return;
              }
              await params.onChunk(packet, packet);
            }
          });
        }
        await startTranscripts(f.manager, f.sink);
        const receiving = f.begin("100000000000000001");
        const stream = f.streams.get("100000000000000001")!;
        stream.write(Buffer.alloc(192_000, 1));
        await vi.waitFor(() => expect(f.sink).toHaveBeenCalledOnce());
        await f.entry.processingQueue;
        try {
          expect(agentCommandMock).not.toHaveBeenCalled();
        } finally {
          stream.end(Buffer.alloc(192_000, 2));
          await receiving;
          await f.entry.processingQueue;
        }
        if (ending === "decoder failure") {
          expect(transcribeAudioFileMock).toHaveBeenCalledOnce();
          expect(f.sink).toHaveBeenCalledOnce();
          expect(agentCommandMock).not.toHaveBeenCalled();
        } else {
          expect(transcribeAudioFileMock).toHaveBeenCalledTimes(2);
          expect(f.sink).toHaveBeenCalledTimes(2);
          expect(agentCommandMock).toHaveBeenCalledOnce();
          expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
            message: expect.stringContaining("audio-1-192000\naudio-2-192000"),
          });
        }
      },
    );

    it.each(["identity", "decoder"])(
      "revokes opening packets while %s is pending",
      async (stage) => {
        const f = await fixture();
        await startTranscripts(f.manager, f.sink);
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        if (stage === "identity") {
          f.client.fetchMember.mockImplementation(async () => {
            await blocked;
            return { nickname: "Guest", user: { id: "guest" } };
          });
        } else {
          decodeOpusStreamChunksMock.mockImplementation(async (stream, params) => {
            await blocked;
            for await (const pcm of stream) {
              await params.onChunk(pcm, pcm);
            }
          });
        }
        const receiving = f.begin("guest");
        expect(f.streams.has("guest")).toBe(true);
        f.streams.get("guest")!.end(Buffer.alloc(96_000, 3));
        await stopTranscripts();
        const replacement = vi.fn();
        await startTranscripts(f.manager, replacement, "notes-2");
        release();
        await receiving;
        await f.entry.processingQueue;
        expect(f.sink).not.toHaveBeenCalled();
        expect(replacement).not.toHaveBeenCalled();
        expect(transcribeAudioFileMock).not.toHaveBeenCalled();
        expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
        expect(agentCommandMock).not.toHaveBeenCalled();
      },
    );

    it.each(["start", "replace"])(
      "binds new audio during continuous speech at capture %s",
      async (phase) => {
        const f = await fixture();
        if (phase === "replace") {
          await startTranscripts(f.manager, f.sink);
        }
        const receiving = f.begin("100000000000000001");
        await vi.waitFor(() => expect(f.streams.has("100000000000000001")).toBe(true));
        const stream = f.streams.get("100000000000000001")!;
        stream.write(Buffer.alloc(96_000, 1));
        await vi.waitFor(() => expect(realtimeSessionMock.sendAudio).toHaveBeenCalled());
        const nextSink = vi.fn();
        await startTranscripts(f.manager, nextSink, "notes-2");
        stream.end(Buffer.alloc(96_000, 2));
        await receiving;
        await f.entry.processingQueue;
        expect(nextSink).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: "audio-2-96000" }),
        );
        expect(f.sink).not.toHaveBeenCalled();
        expect(f.entry.connection.receiver.subscribe).toHaveBeenCalledOnce();
        expect(decodeOpusStreamChunksMock).toHaveBeenCalledOnce();
      },
    );

    it("starts recording a continuously speaking denied participant", async () => {
      const f = await fixture();
      await f.begin("guest");
      expect(f.streams.size).toBe(0);
      f.entry.connection.receiver.speaking.users.set("guest", Date.now());
      await startTranscripts(f.manager, f.sink);
      expect(f.streams.has("guest")).toBe(true);
      f.streams.get("guest")!.end(Buffer.alloc(96_000, 2));
      await vi.waitFor(() => expect(f.sink).toHaveBeenCalledOnce());
      expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();
    });

    it("uses audio upload caps and packet timestamps across speech gaps", async () => {
      const f = await fixture("agent-proxy", false, {
        tools: {
          media: {
            models: [
              { provider: "example", capabilities: ["image"], maxBytes: 96_044 },
              { provider: "example", capabilities: ["audio"], maxBytes: 192_044 },
            ],
          },
        },
      });
      await startTranscripts(f.manager, f.sink);
      const receiving = f.begin("guest");
      const clock = vi.spyOn(Date, "now");
      try {
        clock.mockReturnValue(1_000_000);
        f.streams.get("guest")!.write(Buffer.alloc(192_000, 1));
        clock.mockReturnValue(1_010_000);
        f.streams.get("guest")!.end(Buffer.alloc(192_000, 2));
        await receiving;
        await f.entry.processingQueue;
        expect(f.sink.mock.calls.map(([u]) => [Date.parse(u.startedAt), u.text])).toEqual([
          [1_000_000, "audio-1-192000"],
          [1_010_000, "audio-2-192000"],
        ]);
      } finally {
        clock.mockRestore();
      }
    });

    it("retains queued WAV input until processing owns its release", async () => {
      const f = await fixture();
      await startTranscripts(f.manager, f.sink);
      let release!: () => void;
      f.entry.processingQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      const removals = vi.spyOn(fs, "rm");
      vi.useFakeTimers();
      try {
        const receiving = f.begin("guest");
        f.streams.get("guest")!.end(Buffer.alloc(96_000, 3));
        await receiving;
        await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 + 1);
        await Promise.all(removals.mock.results.map((result) => result.value));
        release();
        await f.entry.processingQueue;
        expect(f.sink).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: "audio-3-96000" }),
        );
      } finally {
        release();
        vi.useRealTimers();
        removals.mockRestore();
      }
    });

    it.each(["missing", "disabled"])(
      "grants no passive receive access with %s capture",
      async (kind) => {
        const f = await fixture(
          "agent-proxy",
          false,
          kind === "disabled" ? { transcripts: { enabled: false } } : {},
        );
        await f.begin("guest");
        expect(f.streams.size).toBe(0);
        expect(transcribeAudioFileMock).not.toHaveBeenCalled();
        expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
        expect(agentCommandMock).not.toHaveBeenCalled();
      },
    );

    it("flushes bounded contiguous long speech with ingress timestamps", async () => {
      const f = await fixture();
      const packetCount = 130;
      const processed = createDeferred<void>();
      decodeOpusStreamChunksMock.mockImplementationOnce(async (input, params) => {
        let decodedPackets = 0;
        try {
          for await (const packet of input) {
            await params.onChunk(packet, packet);
            decodedPackets += 1;
            if (decodedPackets === packetCount) {
              processed.resolve();
            }
          }
          if (decodedPackets < packetCount) {
            processed.reject(new Error("Voice input ended before all test packets were processed"));
          }
        } catch (error) {
          processed.reject(error);
          params.onError?.(error);
        }
      });
      await startTranscripts(f.manager, f.sink);
      const startedBefore = Date.now();
      const receiving = f.begin("guest");
      await vi.waitFor(() => expect(f.streams.has("guest")).toBe(true));
      const stream = f.streams.get("guest")!;
      const frame = Buffer.alloc(192_000, 7);
      try {
        const clock = vi.spyOn(Date, "now");
        try {
          for (let second = 0; second < packetCount; second++) {
            clock.mockReturnValue(startedBefore + second * 1_000);
            stream.write(frame);
          }
        } finally {
          clock.mockRestore();
        }
        // Observe the real WAV write/queue work, not a one-second disk deadline.
        await processed.promise;
        await f.entry.processingQueue;
        expect(transcribeAudioFileMock).toHaveBeenCalled();
      } finally {
        stream.end();
        await receiving;
        await f.entry.processingQueue;
      }
      const utterances = f.sink.mock.calls.map(([u]) => u);
      expect(utterances.length).toBeGreaterThan(1);
      expect(utterances.every((u) => u.speaker.id === "guest")).toBe(true);
      expect(utterances.reduce((bytes, u) => bytes + Number(u.text.split("-")[2]), 0)).toBe(
        packetCount * frame.length,
      );
      expect(Date.parse(utterances[0].startedAt)).toBeGreaterThanOrEqual(startedBefore);
      expect(
        Date.parse(utterances.at(-1).startedAt) - Date.parse(utterances[0].startedAt),
      ).toBeGreaterThan(60_000);
    });

    it.each(["queue", "stt"])(
      "revokes captured audio during %s without redirecting it to a replacement",
      async (stage) => {
        const f = await fixture();
        await startTranscripts(f.manager, f.sink);
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        if (stage === "queue") {
          f.entry.processingQueue = blocked;
        } else {
          transcribeAudioFileMock.mockImplementationOnce(async () => {
            await blocked;
            return { text: "stale recording" };
          });
        }
        const receiving = f.begin("guest");
        await vi.waitFor(() => expect(f.streams.has("guest")).toBe(true));
        f.streams.get("guest")!.end(Buffer.alloc(96_000));
        await receiving;
        if (stage === "stt") {
          await vi.waitFor(() => expect(transcribeAudioFileMock).toHaveBeenCalledOnce());
        }
        await stopTranscripts();
        const replacement = vi.fn();
        await startTranscripts(f.manager, replacement, "notes-2");
        release();
        await f.entry.processingQueue;
        expect(f.sink).not.toHaveBeenCalled();
        expect(replacement).not.toHaveBeenCalled();
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
      },
    );

    it("keeps already-received final audio across occupancy departure and rejects stale bytes", async () => {
      const f = await fixture("agent-proxy", true);
      await startTranscripts(f.manager, f.sink);
      let releaseDecoder!: () => void;
      const decoderReady = new Promise<void>((resolve) => {
        releaseDecoder = resolve;
      });
      decodeOpusStreamChunksMock.mockImplementation(async (stream, params) => {
        await decoderReady;
        for await (const pcm of stream) {
          await params.onChunk(pcm, pcm);
        }
      });
      const receiving = f.begin("guest");
      expect(f.streams.has("guest")).toBe(true);
      f.streams.get("guest")!.write(Buffer.alloc(96_000, 4));
      await vi.waitFor(() => expect(f.streams.get("guest")!.readableLength).toBe(0));
      f.states.length = 0;
      await updateVoiceState(f.manager, "100000000000000001", null);
      f.streams.get("guest")!.emit("data", Buffer.alloc(96_000, 9));
      releaseDecoder();
      await receiving;
      await f.entry.processingQueue;
      expect(f.sink).toHaveBeenCalledWith(
        expect.objectContaining({
          speaker: { id: "guest", label: "Guest" },
          text: "audio-4-96000",
        }),
      );
      await f.begin("stale-speaker");
      expect(f.streams.has("stale-speaker")).toBe(false);
      expect(agentCommandMock).not.toHaveBeenCalled();
    });
  },
);
