import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/dench-cloud-settings", () => ({
  getCloudVoiceState: vi.fn(),
}));

vi.mock("@/lib/elevenlabs-voice", () => ({
  transcribeElevenLabsAudio: vi.fn(),
}));

const { getCloudVoiceState } = await import("@/lib/dench-cloud-settings");
const { transcribeElevenLabsAudio } = await import("@/lib/elevenlabs-voice");

const mockedVoiceState = vi.mocked(getCloudVoiceState);
const mockedTranscribe = vi.mocked(transcribeElevenLabsAudio);

describe("voice transcribe API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when no file is provided", async () => {
    const request = new Request("http://localhost/api/voice/transcribe", {
      method: "POST",
      body: new FormData(),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("returns transcript text when ElevenLabs transcription succeeds", async () => {
    mockedVoiceState.mockResolvedValue({
      status: "valid",
      apiKeySource: "config",
      gatewayUrl: "https://gateway.merseoriginals.com",
      apiKey: "dench-key",
      selectedVoiceId: null,
      elevenLabsEnabled: true,
    });
    mockedTranscribe.mockResolvedValue({ text: "hello from voice" });

    const body = new FormData();
    body.set("file", new File(["audio"], "recording.webm", { type: "audio/webm" }));
    const request = new Request("http://localhost/api/voice/transcribe", {
      method: "POST",
      body,
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.text).toBe("hello from voice");
    expect(mockedTranscribe).toHaveBeenCalledTimes(1);
  });
});
