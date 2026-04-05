import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mockSend = vi.fn();
const mockDestroy = vi.fn();

vi.mock("@aws-sdk/client-polly", () => {
  return {
    PollyClient: class {
      send(command: unknown, options?: unknown) {
        return mockSend(command, options);
      }
      destroy() {
        mockDestroy();
      }
    },
    SynthesizeSpeechCommand: class {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
    DescribeVoicesCommand: class {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
  };
});

let pollySynthesize: typeof import("./tts.js").pollySynthesize;
let pollyListVoices: typeof import("./tts.js").pollyListVoices;

describe("pollySynthesize", () => {
  beforeAll(async () => {
    ({ pollySynthesize, pollyListVoices } = await import("./tts.js"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns audio buffer from Polly response", async () => {
    const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    mockSend.mockResolvedValue({
      AudioStream: {
        transformToByteArray: async () => fakeAudio,
      },
    });

    const result = await pollySynthesize({
      text: "Hello world",
      voiceId: "Joanna",
      engine: "neural",
      outputFormat: "mp3",
      region: "us-east-1",
      timeoutMs: 10_000,
    });

    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(4);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it("throws when AudioStream is empty", async () => {
    mockSend.mockResolvedValue({
      AudioStream: undefined,
    });

    await expect(
      pollySynthesize({
        text: "Hello",
        voiceId: "Joanna",
        engine: "neural",
        outputFormat: "mp3",
        region: "us-east-1",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("Amazon Polly returned empty audio stream");
  });

  it("throws when audio buffer is zero bytes", async () => {
    mockSend.mockResolvedValue({
      AudioStream: {
        transformToByteArray: async () => new Uint8Array(0),
      },
    });

    await expect(
      pollySynthesize({
        text: "Hello",
        voiceId: "Joanna",
        engine: "neural",
        outputFormat: "mp3",
        region: "us-east-1",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("Amazon Polly produced empty audio buffer");
  });

  it("passes languageCode and sampleRate when provided", async () => {
    const fakeAudio = new Uint8Array([0x01, 0x02]);
    mockSend.mockResolvedValue({
      AudioStream: {
        transformToByteArray: async () => fakeAudio,
      },
    });

    await pollySynthesize({
      text: "Hola mundo",
      voiceId: "Mia",
      engine: "neural",
      outputFormat: "mp3",
      sampleRate: "24000",
      languageCode: "es-MX",
      region: "us-east-1",
      timeoutMs: 10_000,
    });

    const command = mockSend.mock.calls[0][0];
    expect(command.input).toEqual(
      expect.objectContaining({
        VoiceId: "Mia",
        LanguageCode: "es-MX",
        SampleRate: "24000",
        Engine: "neural",
      }),
    );
  });

  it("destroys client even on error", async () => {
    mockSend.mockRejectedValue(new Error("AWS error"));

    await expect(
      pollySynthesize({
        text: "Hello",
        voiceId: "Joanna",
        engine: "neural",
        outputFormat: "mp3",
        region: "us-east-1",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("AWS error");

    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });
});

describe("pollyListVoices", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns mapped voice entries from DescribeVoices", async () => {
    mockSend.mockResolvedValue({
      Voices: [
        {
          Id: "Joanna",
          Name: "Joanna",
          Gender: "Female",
          LanguageCode: "en-US",
          LanguageName: "US English",
          SupportedEngines: ["neural", "standard"],
        },
        {
          Id: "Mia",
          Name: "Mia",
          Gender: "Female",
          LanguageCode: "es-MX",
          LanguageName: "Mexican Spanish",
          SupportedEngines: ["neural", "standard"],
        },
      ],
    });

    const voices = await pollyListVoices({ region: "us-east-1" });

    expect(voices).toEqual([
      {
        id: "Joanna",
        name: "Joanna",
        gender: "Female",
        languageCode: "en-US",
        languageName: "US English",
        supportedEngines: ["neural", "standard"],
      },
      {
        id: "Mia",
        name: "Mia",
        gender: "Female",
        languageCode: "es-MX",
        languageName: "Mexican Spanish",
        supportedEngines: ["neural", "standard"],
      },
    ]);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it("filters out voices with empty ids", async () => {
    mockSend.mockResolvedValue({
      Voices: [
        { Id: "", Name: "Empty" },
        { Id: "Joanna", Name: "Joanna" },
      ],
    });

    const voices = await pollyListVoices({ region: "us-east-1" });
    expect(voices).toHaveLength(1);
    expect(voices[0].id).toBe("Joanna");
  });

  it("returns empty array when no voices are returned", async () => {
    mockSend.mockResolvedValue({ Voices: undefined });

    const voices = await pollyListVoices({ region: "us-east-1" });
    expect(voices).toEqual([]);
  });
});
