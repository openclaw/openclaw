import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElevenLabsDialogueTool } from "./dialogue-tool.js";
import register from "./index.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  assertOk: vi.fn(),
  readBinary: vi.fn(),
  saveMedia: vi.fn(),
  resolveMediaPath: vi.fn(),
  resolveProfileKey: vi.fn(() => null),
}));

vi.mock("./config-api.js", () => ({
  resolveElevenLabsApiKeyWithProfileFallback: mocks.resolveProfileKey,
}));
vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowProviderError: mocks.assertOk,
  readProviderBinaryResponse: mocks.readBinary,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetch,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: (baseUrl: string) => ({ baseUrl }),
}));
vi.mock("openclaw/plugin-sdk/media-store", () => ({
  resolveMediaBufferPath: mocks.resolveMediaPath,
  saveMediaBuffer: mocks.saveMedia,
}));

const turns = [
  { text: "Hello [laughs]", voiceId: "voiceAlpha123" },
  { text: "Hi there", voiceId: "voiceBravo456" },
  { text: "Goodbye", voiceId: "voiceAlpha123" },
];

function createTool(
  config: unknown = { talk: { providers: { elevenlabs: { apiKey: "xi-fixture-key" } } } },
) {
  return createElevenLabsDialogueTool({ assertInvocationCurrent: vi.fn() } as never, () => config);
}

describe("ElevenLabs dialogue tool", () => {
  beforeEach(() => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    vi.stubEnv("XI_API_KEY", "");
    mocks.fetch.mockReset().mockResolvedValue({
      response: new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      }),
      release: vi.fn().mockResolvedValue(undefined),
    });
    mocks.assertOk.mockReset().mockResolvedValue(undefined);
    mocks.readBinary.mockReset().mockResolvedValue(Buffer.from([1, 2, 3]));
    mocks.saveMedia
      .mockReset()
      .mockResolvedValue({ id: "dialogue-id", path: "/media/dialogue.mp3" });
    mocks.resolveMediaPath.mockReset().mockResolvedValue("/media/dialogue.mp3");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves ordered A/B/A turns and returns saved media and source-reply results", async () => {
    const tool = createTool();
    expect(tool.canDeliverSourceReply).toBe(true);
    const result = await tool.execute("call-1", { turns } as never);
    const request = mocks.fetch.mock.calls[0]?.[0];

    expect(new URL(request.url).pathname).toBe("/v1/text-to-dialogue");
    expect(new URL(request.url).searchParams.get("output_format")).toBe("mp3_44100_128");
    expect(request.init.method).toBe("POST");
    expect(request.init.headers).toMatchObject({
      "xi-api-key": "xi-fixture-key",
      Accept: "audio/mpeg",
    });
    expect(JSON.parse(request.init.body)).toEqual({
      inputs: [
        { text: "Hello [laughs]", voice_id: "voiceAlpha123" },
        { text: "Hi there", voice_id: "voiceBravo456" },
        { text: "Goodbye", voice_id: "voiceAlpha123" },
      ],
      model_id: "eleven_v3",
    });
    expect(mocks.saveMedia).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3]),
      "audio/mpeg",
      "elevenlabs-dialogue",
      undefined,
      "elevenlabs-dialogue.mp3",
      undefined,
      expect.objectContaining({ assertCommitAllowed: expect.any(Function) }),
    );
    expect(result).toMatchObject({
      content: [{ type: "text" }],
      details: {
        mediaId: "dialogue-id",
        mimeType: "audio/mpeg",
        media: { mediaUrls: ["/media/dialogue.mp3"], audioAsVoice: true },
        sourceReply: {
          final: true,
          mediaUrls: ["/media/dialogue.mp3"],
          audioAsVoice: true,
        },
      },
    });
  });

  it.each([
    [
      "one voice",
      [
        { text: "A", voiceId: "voiceAlpha123" },
        { text: "B", voiceId: "voiceAlpha123" },
      ],
    ],
    [
      "three voices",
      [
        { text: "A", voiceId: "voiceAlpha123" },
        { text: "B", voiceId: "voiceBravo456" },
        { text: "C", voiceId: "voiceCharlie789" },
      ],
    ],
    [
      "invalid voice ID",
      [
        { text: "A", voiceId: "../bad" },
        { text: "B", voiceId: "voiceBravo456" },
      ],
    ],
    [
      "oversized text",
      [
        { text: "a".repeat(2_001), voiceId: "voiceAlpha123" },
        { text: "B", voiceId: "voiceBravo456" },
      ],
    ],
  ])("rejects %s before requesting or saving media", async (_case, invalidTurns) => {
    await expect(
      createTool().execute("call-invalid", { turns: invalidTurns } as never),
    ).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.saveMedia).not.toHaveBeenCalled();
  });

  it("fails closed when credentials are missing", async () => {
    await expect(
      createTool({ talk: { providers: { elevenlabs: {} } } }).execute("call-no-key", {
        turns,
      } as never),
    ).rejects.toThrow("ElevenLabs API key missing");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.saveMedia).not.toHaveBeenCalled();
  });

  it("does not request or save media for a retired invocation", async () => {
    const assertInvocationCurrent = vi.fn(() => {
      throw new Error("invocation retired");
    });
    const tool = createElevenLabsDialogueTool({ assertInvocationCurrent } as never, () => ({
      talk: { providers: { elevenlabs: { apiKey: "xi-fixture-key" } } },
    }));

    await expect(tool.execute("call-retired", { turns } as never)).rejects.toThrow(
      "invocation retired",
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.saveMedia).not.toHaveBeenCalled();
  });

  it("registers the optional tool through the versioned invocation contract", () => {
    const registerTool =
      vi.fn<(definition: AnyAgentTool | OpenClawPluginToolFactory, options?: unknown) => void>();
    register.register({
      runtime: { config: { current: () => ({}) } },
      registerTool,
      registerSpeechProvider: vi.fn(),
      registerMediaUnderstandingProvider: vi.fn(),
      registerRealtimeTranscriptionProvider: vi.fn(),
    } as never);

    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ contextVersion: 2, create: expect.any(Function) }),
      { name: "elevenlabs_dialogue", optional: true, workspaceAccess: false },
    );
  });
});
