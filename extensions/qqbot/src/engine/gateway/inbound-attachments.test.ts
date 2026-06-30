import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
// Qqbot tests cover inbound attachments plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processAttachments, type AudioConvertPort } from "./inbound-attachments.js";

const downloadFileMock = vi.hoisted(() => vi.fn());
const resolveSTTConfigMock = vi.hoisted(() => vi.fn());
const transcribeAudioMock = vi.hoisted(() => vi.fn());

vi.mock("../utils/file-utils.js", () => ({
  downloadFile: downloadFileMock,
}));

vi.mock("../utils/platform.js", () => ({
  getQQBotMediaDir: () => "/tmp/openclaw-qqbot-downloads",
}));

vi.mock("../utils/stt.js", () => ({
  resolveSTTConfig: resolveSTTConfigMock,
  transcribeAudio: transcribeAudioMock,
}));

function createAudioConvert(overrides: Partial<AudioConvertPort> = {}): AudioConvertPort {
  return {
    convertSilkToWav: vi.fn(async () => null),
    formatDuration: (seconds: number) => `${seconds}s`,
    isVoiceAttachment: (att: { content_type: string; filename?: string }) =>
      att.content_type === "voice" || att.content_type.startsWith("audio/"),
    ...overrides,
  };
}

describe("engine/gateway/inbound-attachments", () => {
  let audioConvert: AudioConvertPort;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveSTTConfigMock.mockReturnValue(null);
    transcribeAudioMock.mockResolvedValue(null);
    audioConvert = createAudioConvert();
  });

  it("returns an empty result when no attachments are present", async () => {
    await expect(
      processAttachments(undefined, { accountId: "qq", cfg: {}, audioConvert }),
    ).resolves.toStrictEqual({
      attachmentInfo: "",
      imageUrls: [],
      imageMediaTypes: [],
      voiceAttachmentPaths: [],
      voiceAttachmentUrls: [],
      voiceAsrReferTexts: [],
      voiceTranscripts: [],
      voiceTranscriptSources: [],
      attachmentLocalPaths: [],
    });
  });

  it("uses remote image URL when image download fails", async () => {
    downloadFileMock.mockResolvedValue(null);

    const result = await processAttachments(
      [{ content_type: "image/png", url: "//cdn.example.test/a.png", filename: "a.png" }],
      { accountId: "qq", cfg: {}, audioConvert },
    );

    expect(downloadFileMock).toHaveBeenCalledWith(
      "https://cdn.example.test/a.png",
      "/tmp/openclaw-qqbot-downloads",
      "a.png",
    );
    expect(result.imageUrls).toEqual(["https://cdn.example.test/a.png"]);
    expect(result.imageMediaTypes).toEqual(["image/png"]);
    expect(result.attachmentLocalPaths).toEqual([null]);
  });

  it("prefers voice_wav_url for voice downloads and transcribes with configured STT", async () => {
    downloadFileMock.mockResolvedValue("/tmp/openclaw-qqbot-downloads/voice.wav");
    resolveSTTConfigMock.mockReturnValue({
      baseUrl: "https://stt.example.test",
      apiKey: "key",
      model: "whisper-1",
    });
    transcribeAudioMock.mockResolvedValue("transcribed voice");

    const result = await processAttachments(
      [
        {
          content_type: "voice",
          url: "https://cdn.example.test/voice.silk",
          filename: "voice.silk",
          voice_wav_url: "//cdn.example.test/voice.wav",
          asr_refer_text: "platform text",
        },
      ],
      { accountId: "qq", cfg: { channels: { qqbot: { stt: {} } } }, audioConvert },
    );

    expect(downloadFileMock).toHaveBeenCalledWith(
      "https://cdn.example.test/voice.wav",
      "/tmp/openclaw-qqbot-downloads",
    );
    expect(transcribeAudioMock).toHaveBeenCalledWith("/tmp/openclaw-qqbot-downloads/voice.wav", {
      channels: { qqbot: { stt: {} } },
    });
    expect(result.voiceAttachmentPaths).toEqual(["/tmp/openclaw-qqbot-downloads/voice.wav"]);
    expect(result.voiceAttachmentUrls).toEqual(["https://cdn.example.test/voice.wav"]);
    expect(result.voiceAsrReferTexts).toEqual(["platform text"]);
    expect(result.voiceTranscripts).toEqual(["transcribed voice"]);
    expect(result.voiceTranscriptSources).toEqual(["stt"]);
  });

  it("falls back to platform ASR text when voice download fails", async () => {
    downloadFileMock.mockResolvedValue(null);

    const result = await processAttachments(
      [
        {
          content_type: "voice",
          url: "https://cdn.example.test/voice.silk",
          filename: "voice.silk",
          asr_refer_text: "platform text",
        },
      ],
      { accountId: "qq", cfg: {}, audioConvert },
    );

    expect(result.voiceAttachmentUrls).toEqual(["https://cdn.example.test/voice.silk"]);
    expect(result.voiceTranscripts).toEqual(["platform text"]);
    expect(result.voiceTranscriptSources).toEqual(["asr"]);
    expect(result.attachmentLocalPaths).toEqual([null]);
  });
});

describe("inbound-attachments STT transcript log preview UTF-16 truncation", () => {
  // Mirrors the call at extensions/qqbot/src/engine/gateway/inbound-attachments.ts:334 —
  // `truncateUtf16Safe(transcript, 100)` for the debug log preview. Helper-only tests
  // verify the SDK helper drops a trailing surrogate that would otherwise produce a
  // lone 0xd83c in the agent-facing log.
  const emoji = "🎉"; // U+1F389, surrogate pair 0xd83c 0xdf89

  it("drops a trailing surrogate straddling the 100-char boundary", () => {
    const input = "a".repeat(99) + emoji;
    const out = truncateUtf16Safe(input, 100);
    expect(out.length).toBe(99);
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });

  it("passes plain ASCII under the cap through unchanged", () => {
    const input = "x".repeat(60);
    expect(truncateUtf16Safe(input, 100)).toBe(input);
  });

  it("stays empty for empty input", () => {
    expect(truncateUtf16Safe("", 100)).toBe("");
  });

  it("preserves an emoji fully inside the 100-char window (no false-positive drop)", () => {
    const input = emoji + "a".repeat(98);
    const out = truncateUtf16Safe(input, 100);
    expect(out.startsWith(emoji)).toBe(true);
    expect(out.length).toBe(100);
  });
});
