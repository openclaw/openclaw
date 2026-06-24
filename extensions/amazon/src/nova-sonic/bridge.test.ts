import { describe, it, expect, vi } from "vitest";
import { NovaSonicVoiceBridge } from "./bridge.js";

// Mock the AWS SDK
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockRejectedValue(new Error("mock: not connected")),
  })),
  InvokeModelWithBidirectionalStreamCommand: vi.fn(),
}));

vi.mock("../shared/client-cache.js", () => ({
  getAwsClient: vi.fn((_key, factory) => factory()),
}));

describe("NovaSonicVoiceBridge protocol", () => {
  it("builds sessionStart with inferenceConfiguration and turnDetectionConfiguration", () => {
    const bridge = new NovaSonicVoiceBridge({
      onAudio: () => {},
      onClearAudio: () => {},
      region: "us-east-1",
      model: "amazon.nova-sonic-v1:0",
      voice: "tiffany",
      temperature: 0.8,
      maxTokens: 2048,
    });

    // Access private method via any cast for testing
    const event = (bridge as any).buildSessionStartEvent();

    expect(event.event.sessionStart.inferenceConfiguration).toEqual({
      maxTokens: 2048,
      topP: 0.9,
      temperature: 0.8,
    });
    expect(event.event.sessionStart.turnDetectionConfiguration).toEqual({
      endpointingSensitivity: "MEDIUM",
    });
  });

  it("builds promptStart with correct audioOutputConfiguration", () => {
    const bridge = new NovaSonicVoiceBridge({
      onAudio: () => {},
      onClearAudio: () => {},
      region: "us-east-1",
      model: "amazon.nova-sonic-v1:0",
      voice: "matthew",
    });

    const event = (bridge as any).buildPromptStartEvent("test-prompt-id");
    const audio = event.event.promptStart.audioOutputConfiguration;

    expect(audio.mediaType).toBe("audio/lpcm");
    expect(audio.sampleRateHertz).toBe(24000);
    expect(audio.sampleSizeBits).toBe(16);
    expect(audio.voiceId).toBe("matthew");
    expect(audio.encoding).toBe("base64");
    expect(event.event.promptStart.promptName).toBe("test-prompt-id");
  });

  it("builds system prompt events with contentStart/textInput/contentEnd", () => {
    const bridge = new NovaSonicVoiceBridge({
      onAudio: () => {},
      onClearAudio: () => {},
      region: "us-east-1",
      model: "amazon.nova-sonic-v1:0",
      voice: "tiffany",
      instructions: "You are a helpful assistant.",
    });

    const events = (bridge as any).buildSystemPromptEvents("prompt-123");

    expect(events).toHaveLength(3);
    expect(events[0].event.contentStart.role).toBe("SYSTEM");
    expect(events[0].event.contentStart.type).toBe("TEXT");
    expect(events[0].event.contentStart.promptName).toBe("prompt-123");
    expect(events[1].event.textInput.content).toBe("You are a helpful assistant.");
    expect(events[1].event.textInput.promptName).toBe("prompt-123");
    expect(events[2].event.contentEnd.promptName).toBe("prompt-123");
    // contentName should be consistent across all three
    const cn = events[0].event.contentStart.contentName;
    expect(cn).toBeTruthy();
    expect(events[1].event.textInput.contentName).toBe(cn);
    expect(events[2].event.contentEnd.contentName).toBe(cn);
  });

  it("builds audio contentStart with audioInputConfiguration", () => {
    const bridge = new NovaSonicVoiceBridge({
      onAudio: () => {},
      onClearAudio: () => {},
      region: "us-east-1",
      model: "amazon.nova-sonic-v1:0",
      voice: "tiffany",
    });

    const event = (bridge as any).buildAudioContentStartEvent("prompt-abc", "content-xyz");

    expect(event.event.contentStart.promptName).toBe("prompt-abc");
    expect(event.event.contentStart.contentName).toBe("content-xyz");
    expect(event.event.contentStart.type).toBe("AUDIO");
    expect(event.event.contentStart.role).toBe("USER");
    expect(event.event.contentStart.audioInputConfiguration).toEqual({
      mediaType: "audio/lpcm",
      sampleRateHertz: 16000,
      sampleSizeBits: 16,
      channelCount: 1,
      encoding: "base64",
      audioType: "SPEECH",
    });
  });

  it("returns empty events array when no system instructions", () => {
    const bridge = new NovaSonicVoiceBridge({
      onAudio: () => {},
      onClearAudio: () => {},
      region: "us-east-1",
      model: "amazon.nova-sonic-v1:0",
      voice: "tiffany",
    });

    const events = (bridge as any).buildSystemPromptEvents("prompt-123");
    expect(events).toHaveLength(0);
  });

  it("includes tool configuration in promptStart when tools provided", () => {
    const bridge = new NovaSonicVoiceBridge({
      onAudio: () => {},
      onClearAudio: () => {},
      region: "us-east-1",
      model: "amazon.nova-sonic-v1:0",
      voice: "tiffany",
      tools: [{ name: "get_weather", description: "Get weather", parameters: { type: "object", properties: {} } }],
    });

    const event = (bridge as any).buildPromptStartEvent("prompt-456");
    expect(event.event.promptStart.toolConfiguration.tools).toHaveLength(1);
    expect(event.event.promptStart.toolConfiguration.tools[0].toolSpec.name).toBe("get_weather");
  });
});
