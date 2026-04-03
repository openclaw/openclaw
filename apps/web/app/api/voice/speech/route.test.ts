import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/dench-cloud-settings", () => ({
  getCloudVoiceState: vi.fn(),
}));

vi.mock("@/lib/elevenlabs-voice", () => ({
  resolveElevenLabsVoiceId: vi.fn(),
  synthesizeElevenLabsSpeech: vi.fn(),
}));

const { getCloudVoiceState } = await import("@/lib/dench-cloud-settings");
const { resolveElevenLabsVoiceId, synthesizeElevenLabsSpeech } = await import("@/lib/elevenlabs-voice");

const mockedVoiceState = vi.mocked(getCloudVoiceState);
const mockedResolveVoiceId = vi.mocked(resolveElevenLabsVoiceId);
const mockedSynthesizeSpeech = vi.mocked(synthesizeElevenLabsSpeech);

describe("voice speech API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 409 when ElevenLabs is disabled", async () => {
    mockedVoiceState.mockResolvedValue({
      status: "valid",
      apiKeySource: "config",
      gatewayUrl: "https://gateway.merseoriginals.com",
      apiKey: "dench-key",
      selectedVoiceId: null,
      elevenLabsEnabled: false,
    });

    const response = await POST(new Request("http://localhost/api/voice/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello world" }),
    }));

    expect(response.status).toBe(409);
  });

  it("returns audio when speech generation succeeds", async () => {
    mockedVoiceState.mockResolvedValue({
      status: "valid",
      apiKeySource: "config",
      gatewayUrl: "https://gateway.merseoriginals.com",
      apiKey: "dench-key",
      selectedVoiceId: "voice_123",
      elevenLabsEnabled: true,
    });
    mockedResolveVoiceId.mockResolvedValue("voice_123");
    mockedSynthesizeSpeech.mockResolvedValue({
      audio: new TextEncoder().encode("audio").buffer,
      contentType: "audio/mpeg",
    });

    const response = await POST(new Request("http://localhost/api/voice/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello world" }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(mockedResolveVoiceId).toHaveBeenCalled();
    expect(mockedSynthesizeSpeech).toHaveBeenCalledWith({
      gatewayUrl: "https://gateway.merseoriginals.com",
      apiKey: "dench-key",
      text: "Hello world",
      voiceId: "voice_123",
    });
  });
});
