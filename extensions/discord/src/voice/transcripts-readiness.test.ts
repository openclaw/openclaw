import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { SpeakingMap } from "@discordjs/voice";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createClient,
    createManager,
    createConnectionMock,
    joinVoiceChannelMock,
    entersStateMock,
    resolveRealtimeBootstrapContextInstructionsMock,
    realtimeSessionMock,
    configureVoiceStateGateway,
    getSessionEntry,
    startTranscripts,
    stopTranscripts,
    emitDecryptFailure,
    decodeOpusStreamChunksMock,
    transcribeAudioFileMock,
    agentCommandMock,
    controlRealtimeVoiceAgentRunMock,
    enqueueSystemEventMock,
  }) => {
    function fixture(occupied: boolean, mode: "agent-proxy" | "bidi" | "stt-tts" = "agent-proxy") {
      const client = createClient();
      client.fetchMember.mockResolvedValue({
        nickname: "Guest",
        roles: [],
        user: { id: "guest" },
      });
      const states = [
        {
          user_id: "guest",
          channel_id: "1001",
          member: { user: { id: "guest", bot: false } },
        },
      ];
      configureVoiceStateGateway(client, () => states);
      const manager = createManager(
        {
          groupPolicy: "open",
          allowFrom: ["discord:owner"],
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
      );
      const connection = createConnectionMock();
      const speaking = new SpeakingMap();
      connection.receiver.speaking = {
        users: speaking.users,
        on: vi.fn(speaking.on.bind(speaking)),
        off: vi.fn(speaking.off.bind(speaking)),
      };
      const stream = new PassThrough({ objectMode: true });
      connection.receiver.subscribe.mockReturnValue(stream);
      decodeOpusStreamChunksMock.mockImplementation(async (input, params) => {
        for await (const packet of input) {
          await params.onChunk(packet, packet);
        }
      });
      transcribeAudioFileMock.mockImplementation(async ({ filePath }) => {
        const wav = await fs.readFile(filePath);
        return { text: `${wav.toString("ascii", 0, 4)}-${wav[44]}-${wav.length - 44}` };
      });
      const received = createDeferred<void>();
      const sink = vi.fn(() => received.resolve());
      return { manager, connection, speaking, stream, states, received, sink };
    }

    it.each([
      { name: "capture-only", occupied: false, recovery: false, stage: "ready", overlap: "none" },
      {
        name: "occupied autoJoin bootstrap",
        occupied: true,
        recovery: false,
        stage: "bootstrap",
        overlap: "none",
      },
      {
        name: "occupied autoJoin connect",
        occupied: true,
        recovery: false,
        stage: "connect",
        overlap: "none",
      },
      {
        name: "capture-only recovery",
        occupied: false,
        recovery: true,
        stage: "ready",
        overlap: "none",
      },
      {
        name: "occupied recovery",
        occupied: true,
        recovery: true,
        stage: "connect",
        overlap: "none",
      },
      {
        name: "overlapping start event",
        occupied: true,
        recovery: false,
        stage: "connect",
        overlap: "after",
      },
      {
        name: "start event before scan",
        occupied: true,
        recovery: false,
        stage: "connect",
        overlap: "before",
      },
    ])(
      "records speech already in progress at $name readiness",
      async ({ occupied, recovery, stage, overlap }) => {
        const f = fixture(occupied);
        if (recovery) {
          expect(await startTranscripts(f.manager, f.sink)).toMatchObject({ ok: true });
        }
        joinVoiceChannelMock.mockReturnValueOnce(f.connection);
        const waiting = createDeferred<void>();
        const ready = createDeferred<undefined>();
        const pending =
          stage === "ready"
            ? entersStateMock
            : stage === "bootstrap"
              ? resolveRealtimeBootstrapContextInstructionsMock
              : realtimeSessionMock.connect;
        pending.mockImplementationOnce(() => {
          waiting.resolve();
          return ready.promise;
        });
        const joins = vi.spyOn(f.manager, "join");
        const starting = recovery ? undefined : startTranscripts(f.manager, f.sink);
        if (recovery) {
          emitDecryptFailure(f.manager);
          emitDecryptFailure(f.manager);
          emitDecryptFailure(f.manager);
        }
        await waiting.promise;
        vi.useFakeTimers();
        const starts = vi.fn();
        f.speaking.on("start", starts);
        try {
          // Native speaking state exists before OpenClaw installs its receive listeners.
          f.speaking.onPacket("guest");
          expect(f.connection.receiver.subscribe).not.toHaveBeenCalled();
          if (overlap === "before") {
            // Roster publication follows listener installation and session-map publication.
            enqueueSystemEventMock.mockImplementationOnce(() => {
              f.speaking.emit("start", "guest");
              return true;
            });
          }
          ready.resolve(undefined);
          expect(await joins.mock.results[0]!.value).toMatchObject({ ok: true });
          if (starting) {
            expect(await starting).toMatchObject({ ok: true });
          }
          expect(f.connection.receiver.subscribe).toHaveBeenCalledExactlyOnceWith(
            "guest",
            expect.anything(),
          );
          // Continuous packets refresh the native timeout without another start event.
          f.speaking.onPacket("guest");
          expect(starts).toHaveBeenCalledTimes(overlap === "before" ? 2 : 1);
          if (overlap === "after") {
            f.speaking.emit("start", "guest");
          }
          f.stream.end(Buffer.alloc(96_000, 7));
          await f.received.promise;
          await getSessionEntry(f.manager).processingQueue;
          expect(f.sink).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              sessionId: "notes-1",
              speaker: { id: "guest", label: "Guest" },
              text: "RIFF-7-96000",
            }),
          );
          expect(f.connection.receiver.subscribe).toHaveBeenCalledOnce();
          expect(decodeOpusStreamChunksMock).toHaveBeenCalledOnce();
          expect(transcribeAudioFileMock).toHaveBeenCalledOnce();
          expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
          expect(agentCommandMock).not.toHaveBeenCalled();
          expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
          expect(getSessionEntry(f.manager).player.play).not.toHaveBeenCalled();
        } finally {
          ready.resolve(undefined);
          await f.manager.destroy();
          f.stream.destroy();
          vi.clearAllTimers();
          vi.useRealTimers();
          joins.mockRestore();
        }
      },
    );

    it.each(["agent-proxy", "bidi", "stt-tts"] as const)(
      "does not start receiving existing speech on %s join without capture",
      async (mode) => {
        const f = fixture(false, mode);
        f.speaking.users.set("owner", Date.now());
        joinVoiceChannelMock.mockReturnValueOnce(f.connection);
        try {
          expect(await f.manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({
            ok: true,
          });
          expect(f.connection.receiver.subscribe).not.toHaveBeenCalled();
          expect(decodeOpusStreamChunksMock).not.toHaveBeenCalled();
          expect(transcribeAudioFileMock).not.toHaveBeenCalled();
          expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
          expect(agentCommandMock).not.toHaveBeenCalled();
        } finally {
          await f.manager.destroy();
          f.stream.destroy();
        }
      },
    );

    it.each(["cancelled", "failed", "emptied"])(
      "does not subscribe existing speech after capture join is %s",
      async (outcome) => {
        const f = fixture(outcome !== "cancelled");
        f.speaking.users.set("guest", Date.now());
        joinVoiceChannelMock.mockReturnValueOnce(f.connection);
        const waiting = createDeferred<void>();
        const ready = createDeferred<undefined>();
        entersStateMock.mockImplementationOnce(() => {
          waiting.resolve();
          return ready.promise;
        });
        const starting = startTranscripts(f.manager, f.sink);
        await waiting.promise;
        try {
          if (outcome === "cancelled") {
            expect(await stopTranscripts()).toMatchObject({ ok: true });
          } else if (outcome === "failed") {
            realtimeSessionMock.connect.mockRejectedValueOnce(new Error("provider unavailable"));
          } else {
            f.states.length = 0;
          }
          ready.resolve(undefined);
          expect(await starting).toMatchObject({ ok: outcome === "emptied" });
          expect(f.manager.status()).toEqual([]);
          expect(f.connection.destroy).toHaveBeenCalledOnce();
          expect(f.connection.receiver.subscribe).not.toHaveBeenCalled();
          expect(transcribeAudioFileMock).not.toHaveBeenCalled();
          expect(f.sink).not.toHaveBeenCalled();
        } finally {
          ready.resolve(undefined);
          await f.manager.destroy();
          f.stream.destroy();
        }
      },
    );
  },
);
