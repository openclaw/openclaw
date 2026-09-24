import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest as requireFirstRecordArg,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const { canonicalizeBase64 } = await import("@openclaw/media-core/base64");
  return {
    canonicalizeBase64,
    transcodeAudioBufferToOpus: vi.fn(),
  };
});

const { postJsonRequestMock } = getProviderHttpMocks();

let buildGoogleSpeechProvider: typeof import("./speech-provider.js").buildGoogleSpeechProvider;

beforeAll(async () => {
  ({ buildGoogleSpeechProvider } = await import("./speech-provider.js"));
});

installProviderHttpMockCleanup();

function installGoogleTtsRequestMock() {
  postJsonRequestMock.mockImplementation(async () => ({
    response: Response.json({
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "audio",
              mime_type: "audio/l16",
              data: Buffer.from([1, 0, 2, 0]).toString("base64"),
            },
          ],
        },
      ],
    }),
    release: vi.fn(async () => {}),
  }));
  return postJsonRequestMock;
}

describe("Google speech dialogue", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/media-runtime");
    vi.resetModules();
  });

  it("sends a labeled Gemini 3.8 dialogue as two conversational speakers", async () => {
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();

    await provider.synthesize({
      text: [
        "Puck: Headphones on. <laugh> We opened it.",
        "Kore: It is waiting at the maintainer gate.",
      ].join("\n"),
      cfg: {},
      providerConfig: {
        apiKey: "***",
        model: "gemini-3.8-flash-tts",
        audioProfile: "Keep it brief.",
        speakers: [
          { speaker: "Puck", voice: "Puck", style: "bright" },
          { speaker: "Kore", voice: "Kore", style: "whispered" },
        ],
      },
      target: "audio-file",
      timeoutMs: 10_000,
    });

    expect(requireFirstRecordArg(requestMock, "Google 3.8 dialogue request")).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/interactions",
      body: {
        model: "gemini-3.8-flash-tts",
        store: false,
        input: [
          {
            type: "user_input",
            content: [
              {
                type: "text",
                text: "Headphones on. <laugh> We opened it.",
                annotations: [
                  {
                    type: "speech_metadata",
                    speaker: "Puck",
                    style: "bright\n\nKeep it brief.",
                  },
                ],
              },
              {
                type: "text",
                text: "It is waiting at the maintainer gate.",
                annotations: [
                  {
                    type: "speech_metadata",
                    speaker: "Kore",
                    style: "whispered\n\nKeep it brief.",
                  },
                ],
              },
            ],
          },
        ],
        generation_config: {
          speech_config: {
            mode: "conversational",
            speakers: [
              { speaker: "Puck", voice: "Puck" },
              { speaker: "Kore", voice: "Kore" },
            ],
          },
        },
      },
    });
  });

  it("keeps an unlabeled transcript on the single-voice Gemini 3.8 path", async () => {
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();

    await provider.synthesize({
      text: "Just one voice for this sentence.",
      cfg: {},
      providerConfig: {
        apiKey: "***",
        model: "gemini-3.8-flash-tts",
        voiceName: "Leda",
        speakers: [
          { speaker: "Puck", voice: "Puck" },
          { speaker: "Kore", voice: "Kore" },
        ],
      },
      target: "audio-file",
      timeoutMs: 10_000,
    });

    expect(requireFirstRecordArg(requestMock, "Google 3.8 single-voice request")).toMatchObject({
      body: {
        input: [
          {
            type: "user_input",
            content: [{ type: "text", text: "Just one voice for this sentence." }],
          },
        ],
        generation_config: {
          speech_config: [{ voice: "Leda" }],
        },
      },
    });
  });

  it("rejects a two-speaker dialogue on Gemini 3.1 preview TTS", async () => {
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();

    await expect(
      provider.synthesize({
        text: "Puck: Hello.\nKore: Hello.",
        cfg: {},
        providerConfig: {
          apiKey: "***",
          model: "gemini-3.1-flash-tts-preview",
          speakers: [
            { speaker: "Puck", voice: "Puck" },
            { speaker: "Kore", voice: "Kore" },
          ],
        },
        target: "audio-file",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/gemini-3\.8-flash-tts/u);

    expect(requestMock).not.toHaveBeenCalled();
  });

  it("speaks unlabeled text before the first speaker label", async () => {
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();

    await provider.synthesize({
      text: ["Intro.", "Puck: Hello.", "Kore: Hi."].join("\n"),
      cfg: {},
      providerConfig: {
        apiKey: "test-key",
        model: "gemini-3.8-flash-tts",
        speakers: [
          { speaker: "Puck", voice: "Puck" },
          { speaker: "Kore", voice: "Kore" },
        ],
      },
      target: "audio-file",
      timeoutMs: 10_000,
    });

    expect(requireFirstRecordArg(requestMock, "Google 3.8 preamble request")).toMatchObject({
      body: {
        input: [
          {
            type: "user_input",
            content: [
              {
                type: "text",
                text: "Intro. Hello.",
                annotations: [{ type: "speech_metadata", speaker: "Puck" }],
              },
              {
                type: "text",
                text: "Hi.",
                annotations: [{ type: "speech_metadata", speaker: "Kore" }],
              },
            ],
          },
        ],
      },
    });
  });
});
