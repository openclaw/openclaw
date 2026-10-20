import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  capabilityHost,
  loadLazyProviders,
  runtimeMocks as m,
} from "./lazy-capability-providers.test-support.js";

async function createSession() {
  const lazy = await loadLazyProviders();
  return lazy.createLazyXaiRealtimeTranscriptionProvider(capabilityHost).createSession({
    providerConfig: {},
  });
}

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
        m.buildImageProvider,
        m.buildMediaProvider,
        m.buildVideoProvider,
        m.buildSpeechProvider,
        m.buildTranscriptionProvider,
        m.buildVoiceProvider,
      ].map((mock) => mock.mock.calls.length),
    ).toEqual([0, 0, 0, 0, 0, 0]);
    expect(transcription.label).toBe("xAI Realtime Transcription");
    expect(voice.label).toBe("xAI Grok Voice");

    await image.generateImage({} as never);
    await media.transcribeAudio?.({} as never);
    await video.generateVideo({} as never);
    await speech.synthesize({} as never);
    await speech.listVoices?.({} as never);

    expect(m.buildImageProvider).toHaveBeenCalledOnce();
    expect(m.buildMediaProvider).toHaveBeenCalledOnce();
    expect(m.buildVideoProvider).toHaveBeenCalledOnce();
    expect(m.buildSpeechProvider).toHaveBeenCalledOnce();
    expect(m.generateImage).toHaveBeenCalledOnce();
    expect(m.transcribeAudio).toHaveBeenCalledOnce();
    expect(m.generateVideo).toHaveBeenCalledOnce();
    expect(m.synthesize).toHaveBeenCalledOnce();
    expect(m.listVoices).toHaveBeenCalledOnce();
  });

  it("keeps the newest transcription audio ordered while the runtime loads", async () => {
    const session = await createSession();
    const first = Buffer.alloc(1024 * 1024, 0x01);
    const second = Buffer.alloc(1024 * 1024, 0x02);
    const third = Buffer.alloc(1024 * 1024, 0x03);

    session.sendAudio(first);
    session.sendAudio(second);
    session.sendAudio(third);
    await session.connect();

    expect(m.buildTranscriptionProvider).toHaveBeenCalledOnce();
    const forwarded = m.transcriptionSendAudio.mock.calls.map(([audio]) => audio);
    expect(forwarded.every(Buffer.isBuffer)).toBe(true);
    expect(forwarded).toEqual([second, third]);
    expect(m.transcriptionConnect).toHaveBeenCalledOnce();
    expect(m.transcriptionConnect.mock.invocationCallOrder[0]).toBeLessThan(
      m.transcriptionSendAudio.mock.invocationCallOrder[0]!,
    );
  });

  it("closes a transcription session that finishes loading after the wrapper closes", async () => {
    const session = await createSession();

    const connectPromise = session.connect();
    session.close();
    session.close();
    await connectPromise;

    expect(m.createTranscriptionSession).toHaveBeenCalledOnce();
    expect(m.transcriptionConnect).not.toHaveBeenCalled();
    expect(m.transcriptionClose).toHaveBeenCalledOnce();
  });

  it("reopens transcription after close without replaying discarded audio", async () => {
    const reconnecting = createDeferred<void>();
    const forwarded: Buffer[] = [];
    const events: string[] = [];
    let connectCount = 0;
    let providerClosed = false;
    m.transcriptionConnect.mockImplementation(() => {
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
    m.transcriptionClose.mockImplementation(() => {
      providerClosed = true;
    });
    m.transcriptionSendAudio.mockImplementation((audio: Buffer) => {
      events.push(`${providerClosed ? "drop" : "audio"}:${audio[0]}`);
      if (!providerClosed) {
        forwarded.push(audio);
      }
    });
    const session = await createSession();
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
    await vi.waitFor(() => expect(m.transcriptionConnect).toHaveBeenCalledTimes(2));
    session.sendAudio(live);

    expect(m.transcriptionClose).toHaveBeenCalledOnce();
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

  it("reconnects after closing an in-flight transcription connection", async () => {
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    const started = createDeferred<void>();
    m.transcriptionConnect
      .mockImplementationOnce(() => {
        started.resolve();
        return first.promise;
      })
      .mockImplementationOnce(() => second.promise);
    const session = await createSession();
    const connecting = session.connect();
    await started.promise;
    session.close();
    const reconnecting = session.connect();
    const audio = Buffer.from([0x07]);
    session.sendAudio(audio);
    try {
      await vi.dynamicImportSettled();
      expect(m.transcriptionConnect).toHaveBeenCalledTimes(2);
      expect(m.transcriptionSendAudio).toHaveBeenCalledWith(audio);
      first.resolve();
      await connecting;
      const joined = session.connect();
      expect(m.transcriptionConnect).toHaveBeenCalledTimes(2);
      second.resolve();
      await Promise.all([reconnecting, joined]);
    } finally {
      first.resolve();
      second.resolve();
      await Promise.all([connecting, reconnecting]);
    }
  });
});
