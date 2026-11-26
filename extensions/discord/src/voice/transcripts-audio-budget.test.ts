import { readFile } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createDiscordRecordingFixture } from "./transcripts-recording.test-support.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

function mediaConfig(audio: { enabled?: boolean; maxBytes?: number }): OpenClawConfig {
  return {
    channels: { discord: { token: "test-token", voice: { enabled: true } } },
    commands: { ownerAllowFrom: ["discord:100000000000000001"] },
    tools: { media: { audio } },
  };
}

defineDiscordVoiceTests((harness) => {
  const { expect, it, startTranscripts, getSessionConnection, joinVoiceChannelMock } = harness;
  const fixture = createDiscordRecordingFixture(harness);

  it("admits and stops admitting batch speakers after audio is toggled in a connected room", async () => {
    const disabled = mediaConfig({ enabled: false });
    const enabled = mediaConfig({ enabled: true });
    setRuntimeConfigSnapshot(disabled);
    try {
      const f = await fixture("stt-tts", false, disabled);
      setRuntimeConfigSnapshot(enabled);
      const started = await startTranscripts(
        f.manager,
        f.sink,
        "notes",
        "1001",
        "default",
        enabled,
      );
      expect(started).toMatchObject({ ok: true });

      const receiving = f.begin("guest-a");
      // The receive subscription must exist before Discord delivers the triggering packet.
      const stream = f.streams.get("guest-a");
      expect(stream).toBeDefined();
      stream!.end(Buffer.alloc(96_000, 1));
      await receiving;
      await f.entry.processingQueue;
      expect(f.sink).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          speaker: { id: "guest-a", label: "Guest" },
          text: "audio-1-96000",
        }),
      );

      setRuntimeConfigSnapshot(disabled);
      const excluded = f.begin("guest-b");
      expect(f.streams.has("guest-b")).toBe(false);
      await excluded;
      expect(getSessionConnection(f.entry).receiver.subscribe).toHaveBeenCalledOnce();
      expect(joinVoiceChannelMock).toHaveBeenCalledOnce();
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("uses only the bound realtime final when batch audio is disabled between speakers", async () => {
    const enabled = mediaConfig({ enabled: true });
    setRuntimeConfigSnapshot(enabled);
    try {
      const f = await fixture("agent-proxy", false, enabled);
      expect(
        await startTranscripts(f.manager, f.sink, "notes", "1001", "default", enabled),
      ).toMatchObject({ ok: true });
      setRuntimeConfigSnapshot(mediaConfig({ enabled: false }));
      await f.audio("100000000000000001", 1);
      await harness.emitFinalRealtimeUserTranscript(
        harness.lastRealtimeBridgeParams(),
        "Realtime note.",
      );
      expect(harness.transcribeAudioFileMock).not.toHaveBeenCalled();
      expect(f.sink).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          text: "Realtime note.",
          speaker: { id: "100000000000000001", label: "Owner" },
        }),
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("keeps the admitted speaker's upload cap when overlapping speech begins after a reload", async () => {
    const transcriptionConfig = (maxBytes: number): OpenClawConfig => ({
      ...mediaConfig({ maxBytes }),
      tools: {
        media: {
          audio: { maxBytes },
          models: [
            {
              type: "cli",
              command: process.execPath,
              args: ["-e", "process.stdout.write('Accepted audio')", "{{AttachmentPath}}"],
              capabilities: ["audio"],
            },
          ],
        },
      },
    });
    const original = transcriptionConfig(96_044);
    setRuntimeConfigSnapshot(original);
    try {
      const f = await fixture("stt-tts", false, original);
      expect(
        await startTranscripts(f.manager, f.sink, "notes", "1001", "default", original),
      ).toMatchObject({ ok: true });
      const uploads: Array<{ marker: number; bytes: number; processing?: string }> = [];
      harness.transcribeAudioFileMock.mockImplementation(async (request) => {
        const wav = await readFile(request.filePath);
        const result = await transcribeAudioFile(request);
        uploads.push({
          marker: wav.readUInt8(44),
          bytes: wav.length,
          processing: result.decision?.attachmentProcessing?.[0],
        });
        return result;
      });
      const first = f.begin("first");
      setRuntimeConfigSnapshot(transcriptionConfig(48_044));
      const second = f.begin("second");
      f.streams.get("first")!.end(Buffer.alloc(96_000, 1));
      f.streams.get("second")!.end(Buffer.alloc(96_000, 2));
      await Promise.all([first, second]);
      await f.entry.processingQueue;

      expect(uploads.toSorted((a, b) => a.marker - b.marker)).toEqual([
        { marker: 1, bytes: 96_044, processing: "omitted" },
        { marker: 2, bytes: 48_044, processing: "completed" },
        { marker: 2, bytes: 48_044, processing: "completed" },
      ]);
      expect(f.sink.mock.calls.map(([u]) => [u.speaker.id, u.text])).toEqual([
        ["second", "Accepted audio"],
        ["second", "Accepted audio"],
      ]);
      expect(joinVoiceChannelMock).toHaveBeenCalledOnce();
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });
});
