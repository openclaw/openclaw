import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
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

it("keeps xAI builders unloaded until their capability methods run", async () => {
  const lazy = await loadLazyProviders();
  const image = lazy.createLazyXaiImageGenerationProvider();
  const media = lazy.createLazyXaiMediaUnderstandingProvider();
  const video = lazy.createLazyXaiVideoGenerationProvider(capabilityHost);
  const speech = lazy.createLazyXaiSpeechProvider(capabilityHost);
  const transcription = lazy.createLazyXaiRealtimeTranscriptionProvider(capabilityHost);
  const voice = lazy.createLazyXaiRealtimeVoiceProvider(capabilityHost);
  const builders = [
    m.buildImageProvider,
    m.buildMediaProvider,
    m.buildVideoProvider,
    m.buildSpeechProvider,
    m.buildTranscriptionProvider,
    m.buildVoiceProvider,
  ];
  await vi.dynamicImportSettled();
  expect(builders.map((mock) => mock.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  expect(transcription.label).toBe("xAI Realtime Transcription");
  expect(voice.label).toBe("xAI Grok Voice");

  await image.generateImage({} as never);
  await media.transcribeAudio?.({} as never);
  await video.generateVideo({} as never);
  await speech.synthesize({} as never);
  await speech.listVoices?.({} as never);

  expect(builders.map((mock) => mock.mock.calls.length)).toEqual([1, 1, 1, 1, 0, 0]);
  expect(m.generateImage).toHaveBeenCalledOnce();
  expect(m.transcribeAudio).toHaveBeenCalledOnce();
  expect(m.generateVideo).toHaveBeenCalledOnce();
  expect(m.synthesize).toHaveBeenCalledOnce();
  expect(m.listVoices).toHaveBeenCalledOnce();
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

it("bounds and orders queued audio on initial connect and reopen without replaying discarded audio", async () => {
  const reconnecting = createDeferred<void>();
  const forwarded: Buffer[] = [];
  const events: string[] = [];
  let providerClosed = false;
  m.transcriptionConnect.mockResolvedValueOnce(undefined).mockImplementationOnce(() => {
    providerClosed = false;
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
  const initial = [1, 2, 3].map((byte) => Buffer.alloc(1024 * 1024, byte));
  initial.forEach((audio) => session.sendAudio(audio));
  await session.connect();
  expect(forwarded).toEqual(initial.slice(1));
  expect(forwarded.every((audio) => Buffer.isBuffer(audio))).toBe(true);
  expect(m.buildTranscriptionProvider).toHaveBeenCalledOnce();
  expect(m.transcriptionConnect).toHaveBeenCalledOnce();
  expect(m.transcriptionConnect.mock.invocationCallOrder[0]).toBeLessThan(
    m.transcriptionSendAudio.mock.invocationCallOrder[0]!,
  );
  session.close();
  session.close();
  session.sendAudio(Buffer.from([0x02]));
  forwarded.length = 0;
  events.length = 0;

  const reconnectPromise = session.connect();
  [3, 4, 5].forEach((byte) => session.sendAudio(Buffer.alloc(1024 * 1024, byte)));
  await vi.waitFor(() => expect(m.transcriptionConnect).toHaveBeenCalledTimes(2));
  session.sendAudio(Buffer.from([0x06]));

  expect(m.transcriptionClose).toHaveBeenCalledOnce();
  expect(forwarded.map((audio) => [audio[0], audio.byteLength])).toEqual([
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
