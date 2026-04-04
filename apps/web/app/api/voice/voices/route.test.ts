import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@/lib/dench-cloud-settings", () => ({
  getCloudVoiceState: vi.fn(),
}));

vi.mock("@/lib/elevenlabs-voice", () => ({
  fetchElevenLabsVoices: vi.fn(),
}));

const { getCloudVoiceState } = await import("@/lib/dench-cloud-settings");
const { fetchElevenLabsVoices } = await import("@/lib/elevenlabs-voice");

const mockedVoiceState = vi.mocked(getCloudVoiceState);
const mockedFetchVoices = vi.mocked(fetchElevenLabsVoices);

describe("voice voices API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 409 when the Dench key is missing", async () => {
    mockedVoiceState.mockResolvedValue({
      status: "no_key",
      apiKeySource: "missing",
      gatewayUrl: "https://gateway.merseoriginals.com",
      apiKey: null,
      selectedVoiceId: null,
      elevenLabsEnabled: false,
    });

    const response = await GET();
    expect(response.status).toBe(409);
  });

  it("returns normalized voices when available", async () => {
    mockedVoiceState.mockResolvedValue({
      status: "valid",
      apiKeySource: "config",
      gatewayUrl: "https://gateway.merseoriginals.com",
      apiKey: "dench-key",
      selectedVoiceId: "voice_123",
      elevenLabsEnabled: true,
    });
    mockedFetchVoices.mockResolvedValue([
      {
        voiceId: "voice_123",
        name: "Rachel",
        description: "Warm narration",
        category: "premade",
        previewUrl: null,
        labels: [],
      },
    ]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.voices).toHaveLength(1);
    expect(mockedFetchVoices).toHaveBeenCalledWith({
      gatewayUrl: "https://gateway.merseoriginals.com",
      apiKey: "dench-key",
    });
  });
});
