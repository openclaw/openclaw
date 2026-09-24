import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type {
  AudioTranscriptionRequest,
  MediaUnderstandingProvider,
  VideoDescriptionRequest,
} from "openclaw/plugin-sdk/media-understanding";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import googlePlugin from "./index.js";

const runtime = vi.hoisted(() => {
  const state: { moduleLoads: number; provider?: MediaUnderstandingProvider } = { moduleLoads: 0 };
  return {
    state,
    transcribeAudio: vi.fn<NonNullable<MediaUnderstandingProvider["transcribeAudio"]>>(),
    describeVideo: vi.fn<NonNullable<MediaUnderstandingProvider["describeVideo"]>>(),
  };
});

vi.mock("./media-understanding-provider.js", async (importOriginal) => {
  runtime.state.moduleLoads += 1;
  const original = await importOriginal<typeof import("./media-understanding-provider.js")>();
  runtime.state.provider = original.googleMediaUnderstandingProvider;
  return {
    ...original,
    googleMediaUnderstandingProvider: {
      ...original.googleMediaUnderstandingProvider,
      transcribeAudio: runtime.transcribeAudio,
      describeVideo: runtime.describeVideo,
    },
  };
});

function registerMediaProvider() {
  const captured = createCapturedPluginRegistration({ id: "google" });
  googlePlugin.register(captured.api);
  return expectDefined(
    captured.mediaUnderstandingProviders.find((provider) => provider.id === "google"),
    "registered Google media provider",
  );
}

it("registers independent media metadata and defers audio/video handlers until use", async () => {
  const provider = registerMediaProvider();
  const { transcribeAudio: _audio, describeVideo: _video, ...metadata } = provider;
  const expectedMetadata = {
    id: "google",
    capabilities: ["image", "audio", "video"],
    defaultModels: {
      image: "gemini-3-flash-preview",
      audio: "gemini-3-flash-preview",
      video: "gemini-3-flash-preview",
    },
    autoPriority: { image: 30, audio: 40, video: 10 },
    nativeDocumentInputs: ["pdf"],
    describeImage: undefined,
    describeImages: undefined,
  };
  expect(metadata).toEqual(expectedMetadata);

  const second = registerMediaProvider();
  expect(second).toMatchObject(expectedMetadata);
  expectDefined(second.capabilities, "second provider capabilities").push("image");
  expectDefined(second.defaultModels, "second provider defaults").audio = "fixture-model";
  expectDefined(second.autoPriority, "second provider priorities").audio = 99;
  expectDefined(second.nativeDocumentInputs, "second provider document inputs").push("pdf");
  expect(metadata).toEqual(expectedMetadata);
  expect(runtime.state.moduleLoads).toBe(0);

  const audioRequest: AudioTranscriptionRequest = {
    buffer: Buffer.from("synthetic audio bytes"),
    fileName: "recording.wav",
    mime: "audio/wav",
    apiKey: "fixture-api-key",
    timeoutMs: 15_000,
  };
  const videoRequest: VideoDescriptionRequest = {
    buffer: Buffer.from("synthetic video bytes"),
    fileName: "clip.mp4",
    mime: "video/mp4",
    apiKey: "fixture-api-key",
    timeoutMs: 15_000,
  };
  const audioResult = { text: "Spoken fixture sentence.", model: "gemini-3-flash-preview" };
  const videoResult = { text: "A fixture landscape.", model: "gemini-3-flash-preview" };
  runtime.transcribeAudio.mockResolvedValue(audioResult);
  runtime.describeVideo.mockResolvedValue(videoResult);

  expect(
    await Promise.all([
      provider.transcribeAudio?.(audioRequest),
      second.describeVideo?.(videoRequest),
    ]),
  ).toEqual([audioResult, videoResult]);
  expect(runtime.state.moduleLoads).toBe(1);
  expect(runtime.transcribeAudio).toHaveBeenCalledOnce();
  expect(runtime.transcribeAudio).toHaveBeenCalledWith(audioRequest);
  expect(runtime.describeVideo).toHaveBeenCalledOnce();
  expect(runtime.describeVideo).toHaveBeenCalledWith(videoRequest);

  const loaded = expectDefined(runtime.state.provider, "loaded Google media provider");
  const { transcribeAudio: _loadedAudio, describeVideo: _loadedVideo, ...loadedMetadata } = loaded;
  expect(loadedMetadata).toEqual(expectedMetadata);
  for (const entry of [provider, second, loaded]) {
    for (const hook of ["describeImage", "describeImages"] as const) {
      expect(Object.hasOwn(entry, hook)).toBe(true);
      expect(entry[hook]).toBeUndefined();
    }
  }
});
