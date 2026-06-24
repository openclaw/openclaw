import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTranscribeMediaProvider } from "./media-understanding-provider.js";
import * as sttModule from "./stt.js";

describe("buildTranscribeMediaProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when enabled is false", () => {
    const provider = buildTranscribeMediaProvider({ transcribe: { enabled: false } });
    expect(provider).toBeNull();
  });

  it("returns null when enabled is explicitly false with other config", () => {
    const provider = buildTranscribeMediaProvider({
      transcribe: { enabled: false, region: "us-west-2", languageCode: "en-US" },
    });
    expect(provider).toBeNull();
  });

  it("has correct id and capabilities", () => {
    const provider = buildTranscribeMediaProvider();
    expect(provider).not.toBeNull();
    expect(provider!.id).toBe("amazon-transcribe");
    expect(provider!.capabilities).toEqual(["audio"]);
    expect(provider!.autoPriority).toEqual({ audio: 25 });
  });

  it("transcribes audio using Transcribe Streaming", async () => {
    const provider = buildTranscribeMediaProvider({ transcribe: { region: "us-west-2" } });
    expect(provider).not.toBeNull();
    const spy = vi.spyOn(sttModule, "transcribeAudio").mockResolvedValue("Hello world");

    const result = await provider!.transcribeAudio!({
      buffer: Buffer.from([0x01]),
      fileName: "audio.ogg",
      mime: "audio/ogg",
      apiKey: "unused",
      timeoutMs: 10_000,
    });

    expect(result.text).toBe("Hello world");
    expect(result.model).toBe("amazon-transcribe-streaming");
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ region: "us-west-2", mime: "audio/ogg" }),
    );
  });

  it("uses plugin config language as fallback", async () => {
    const provider = buildTranscribeMediaProvider({
      transcribe: { region: "eu-west-1", languageCode: "fr-FR" },
    });
    expect(provider).not.toBeNull();
    const spy = vi.spyOn(sttModule, "transcribeAudio").mockResolvedValue("Bonjour");

    await provider!.transcribeAudio!({
      buffer: Buffer.from([0x01]),
      fileName: "audio.ogg",
      apiKey: "unused",
      timeoutMs: 10_000,
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ language: "fr-FR" }),
    );
  });

  it("prefers request language over config", async () => {
    const provider = buildTranscribeMediaProvider({
      transcribe: { region: "us-east-1", languageCode: "en-US" },
    });
    expect(provider).not.toBeNull();
    const spy = vi.spyOn(sttModule, "transcribeAudio").mockResolvedValue("Hola");

    await provider!.transcribeAudio!({
      buffer: Buffer.from([0x01]),
      fileName: "audio.ogg",
      apiKey: "unused",
      language: "es-ES",
      timeoutMs: 10_000,
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ language: "es-ES" }),
    );
  });
});
