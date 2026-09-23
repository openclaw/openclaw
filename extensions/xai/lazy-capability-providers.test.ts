import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  capabilityHost,
  loadLazyProviders,
  runtimeMocks,
} from "./lazy-capability-providers.test-support.js";

describe("xAI lazy capability providers", () => {
  it("keeps heavy builders unloaded until their capability methods run", async () => {
    const lazy = await loadLazyProviders();
    const image = lazy.createLazyXaiImageGenerationProvider();
    const media = lazy.createLazyXaiMediaUnderstandingProvider();
    const video = lazy.createLazyXaiVideoGenerationProvider(capabilityHost);
    const speech = lazy.createLazyXaiSpeechProvider(capabilityHost);
    const transcription = lazy.createLazyXaiRealtimeTranscriptionProvider(capabilityHost);
    const voice = lazy.createLazyXaiRealtimeVoiceProvider(capabilityHost);
    await vi.dynamicImportSettled();

    expect(
      [
        runtimeMocks.buildImageProvider,
        runtimeMocks.buildMediaProvider,
        runtimeMocks.buildVideoProvider,
        runtimeMocks.buildSpeechProvider,
        runtimeMocks.buildTranscriptionProvider,
        runtimeMocks.buildVoiceProvider,
      ].map((mock) => mock.mock.calls.length),
    ).toEqual([0, 0, 0, 0, 0, 0]);
    expect(transcription.label).toBe("xAI Realtime Transcription");
    expect(voice.label).toBe("xAI Grok Voice");

    await image.generateImage({} as never);
    await media.transcribeAudio?.({} as never);
    await video.generateVideo({} as never);
    await speech.synthesize({} as never);
    await speech.listVoices?.({} as never);

    expect(runtimeMocks.buildImageProvider).toHaveBeenCalledOnce();
    expect(runtimeMocks.buildMediaProvider).toHaveBeenCalledOnce();
    expect(runtimeMocks.buildVideoProvider).toHaveBeenCalledOnce();
    expect(runtimeMocks.buildSpeechProvider).toHaveBeenCalledOnce();
    expect(runtimeMocks.generateImage).toHaveBeenCalledOnce();
    expect(runtimeMocks.transcribeAudio).toHaveBeenCalledOnce();
    expect(runtimeMocks.generateVideo).toHaveBeenCalledOnce();
    expect(runtimeMocks.synthesize).toHaveBeenCalledOnce();
    expect(runtimeMocks.listVoices).toHaveBeenCalledOnce();
  });

  it("keeps the newest transcription audio ordered while the runtime loads", async () => {
    const lazy = await loadLazyProviders();
    const session = lazy.createLazyXaiRealtimeTranscriptionProvider(capabilityHost).createSession({
      providerConfig: {},
    });
    const first = Buffer.alloc(1024 * 1024, 0x01);
    const second = Buffer.alloc(1024 * 1024, 0x02);
    const third = Buffer.alloc(1024 * 1024, 0x03);

    session.sendAudio(first);
    session.sendAudio(second);
    session.sendAudio(third);
    await session.connect();

    expect(runtimeMocks.buildTranscriptionProvider).toHaveBeenCalledOnce();
    const forwardedAudio = runtimeMocks.transcriptionSendAudio.mock.calls.map(([audio]) => audio);
    expect(forwardedAudio).toHaveLength(2);
    for (const [index, expected] of [second, third].entries()) {
      const audio = forwardedAudio[index];
      expect(Buffer.isBuffer(audio) && audio.equals(expected)).toBe(true);
    }
    expect(runtimeMocks.transcriptionConnect).toHaveBeenCalledOnce();
    expect(runtimeMocks.transcriptionConnect.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeMocks.transcriptionSendAudio.mock.invocationCallOrder[0]!,
    );
  });

  it("closes a transcription session that finishes loading after the wrapper closes", async () => {
    const lazy = await loadLazyProviders();
    const session = lazy.createLazyXaiRealtimeTranscriptionProvider(capabilityHost).createSession({
      providerConfig: {},
    });

    const connectPromise = session.connect();
    session.close();
    session.close();
    await connectPromise;

    expect(runtimeMocks.createTranscriptionSession).toHaveBeenCalledOnce();
    expect(runtimeMocks.transcriptionConnect).not.toHaveBeenCalled();
    expect(runtimeMocks.transcriptionClose).toHaveBeenCalledOnce();
  });

  it("reopens transcription after close without replaying discarded audio", async () => {
    const reconnecting = createDeferred<void>();
    const forwarded: Buffer[] = [];
    const events: string[] = [];
    let connectCount = 0;
    let providerClosed = false;
    runtimeMocks.transcriptionConnect.mockImplementation(() => {
      providerClosed = false;
      connectCount += 1;
      if (connectCount === 1) {
        return Promise.resolve();
      }
      events.push("connect-start");
      return reconnecting.promise.then(() => {
        events.push("connect-settle");
      });
    });
    runtimeMocks.transcriptionClose.mockImplementation(() => {
      providerClosed = true;
    });
    runtimeMocks.transcriptionSendAudio.mockImplementation((audio: Buffer) => {
      events.push(`${providerClosed ? "drop" : "audio"}:${audio[0]}`);
      if (!providerClosed) {
        forwarded.push(audio);
      }
    });
    const lazy = await loadLazyProviders();
    const session = lazy.createLazyXaiRealtimeTranscriptionProvider(capabilityHost).createSession({
      providerConfig: {},
    });
    const first = Buffer.from([0x01]);
    const discarded = Buffer.from([0x02]);
    const droppedByLimit = Buffer.alloc(1024 * 1024, 0x03);
    const retainedFirst = Buffer.alloc(1024 * 1024, 0x04);
    const retainedSecond = Buffer.alloc(1024 * 1024, 0x05);
    const live = Buffer.from([0x06]);

    session.sendAudio(first);
    await session.connect();
    session.close();
    session.close();
    session.sendAudio(discarded);
    events.length = 0;

    const reconnectPromise = session.connect();
    session.sendAudio(droppedByLimit);
    session.sendAudio(retainedFirst);
    session.sendAudio(retainedSecond);
    await vi.waitFor(() => expect(runtimeMocks.transcriptionConnect).toHaveBeenCalledTimes(2));
    session.sendAudio(live);

    expect(runtimeMocks.transcriptionClose).toHaveBeenCalledOnce();
    expect(forwarded.map((audio) => [audio[0], audio.byteLength])).toEqual([
      [1, 1],
      [4, 1024 * 1024],
      [5, 1024 * 1024],
      [6, 1],
    ]);
    expect(events).toEqual(["connect-start", "audio:4", "audio:5", "audio:6"]);

    reconnecting.resolve();
    await reconnectPromise;
    expect(events.at(-1)).toBe("connect-settle");
  });
});
