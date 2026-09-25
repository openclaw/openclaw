import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest as requireFirstRecordArg,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithTimeoutMock, postJsonRequestMock } = getProviderHttpMocks();

let buildGoogleSpeechProvider: typeof import("./speech-provider.js").buildGoogleSpeechProvider;

beforeAll(async () => {
  ({ buildGoogleSpeechProvider } = await import("./speech-provider.js"));
});

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GOOGLE_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

installProviderHttpMockCleanup();

function jsonResponse(body: unknown): Response {
  return Response.json(body);
}

describe("Google project voices", () => {
  it("keeps the static catalog when Google is not configured", async () => {
    const provider = buildGoogleSpeechProvider();
    const voices = await provider.listVoices?.({ providerConfig: {} });
    expect(voices?.some((voice) => voice.id === "Achernar")).toBe(true);
    expect(voices?.some((voice) => voice.id === "Kore")).toBe(true);
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("lists stored and catalog voices from the project", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        jsonResponse({
          voices: [
            {
              id: "voice_stored",
              display_name: "Dry Lab Assistant",
              type: "prompted",
              language_code: "en-US",
            },
          ],
          next_page_token: "page-2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          voices: [{ name: "Achernar", type: "prebuilt" }],
        }),
      );
    const provider = buildGoogleSpeechProvider();
    const voices = await provider.listVoices?.({
      providerConfig: { apiKey: "google-test-key" },
      timeoutMs: 5_000,
    });
    expect(voices).toEqual([
      {
        id: "voice_stored",
        name: "Dry Lab Assistant",
        category: "prompted",
        locale: "en-US",
      },
      { id: "Achernar", name: "Achernar", category: "prebuilt" },
    ]);
    const firstUrl = String(fetchWithTimeoutMock.mock.calls[0]?.[0]);
    const secondUrl = String(fetchWithTimeoutMock.mock.calls[1]?.[0]);
    expect(firstUrl).toContain("/v1beta/voices?");
    expect(firstUrl).toContain("page_size=100");
    expect(secondUrl).toContain("page_token=page-2");
  });

  it("stores a prompted voice and returns the preview", async () => {
    const preview = Buffer.from("preview-wav");
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: jsonResponse({
        id: "voice_created",
        display_name: "Night Desk",
        sample_audio: { data: preview.toString("base64"), mime_type: "audio/wav" },
      }),
      release,
    });
    const provider = buildGoogleSpeechProvider();
    const designed = await provider.designVoice?.({
      providerConfig: { apiKey: "google-test-key" },
      displayName: "Night Desk",
      prompt: "A low, dry woman in her forties. Calm, unhurried, no smile in the voice.",
      languageCode: "en-US",
      timeoutMs: 5_000,
    });
    expect(designed?.id).toBe("voice_created");
    expect(designed?.name).toBe("Night Desk");
    expect(designed?.mimeType).toBe("audio/wav");
    expect(designed?.previewAudio.equals(preview)).toBe(true);
    const request = requireFirstRecordArg(postJsonRequestMock, "Google voice design request");
    expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/voices");
    expect(request.body).toMatchObject({
      store: true,
      voice: {
        model: "gemini-3.8-flash-tts",
        type: "prompted",
        display_name: "Night Desk",
        language_code: "en-US",
        prompted: {
          input: "A low, dry woman in her forties. Calm, unhurried, no smile in the voice.",
        },
      },
    });
    expect(release).toHaveBeenCalled();
  });

  it("rejects a prompted design that is missing its description", async () => {
    const provider = buildGoogleSpeechProvider();
    await expect(
      provider.designVoice?.({
        providerConfig: { apiKey: "google-test-key" },
        displayName: "Night Desk",
        prompt: "   ",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/requires a prompt/);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("stores a replicated voice from source and consent recordings", async () => {
    const preview = Buffer.from("replicated-preview");
    const sourceAudio = Buffer.from("source-wav");
    const consentAudio = Buffer.from("consent-wav");
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: jsonResponse({
        id: "voice_replicated",
        display_name: "Bobby",
        sample_audio: { data: preview.toString("base64"), mime_type: "audio/wav" },
      }),
      release,
    });
    const provider = buildGoogleSpeechProvider();
    const replicated = await provider.replicateVoice?.({
      providerConfig: { apiKey: "google-test-key" },
      displayName: "Bobby",
      sourceAudio,
      consentAudio,
      timeoutMs: 5_000,
    });
    expect(replicated?.id).toBe("voice_replicated");
    expect(replicated?.name).toBe("Bobby");
    expect(replicated?.previewAudio.equals(preview)).toBe(true);
    const request = requireFirstRecordArg(postJsonRequestMock, "Google voice replicate request");
    expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/voices");
    expect(request.body).toMatchObject({
      store: true,
      voice: {
        model: "gemini-3.8-flash-tts",
        type: "replicated",
        display_name: "Bobby",
        replicated: {
          source_audio: { mime_type: "audio/wav", data: sourceAudio.toString("base64") },
          consent_audio: { mime_type: "audio/wav", data: consentAudio.toString("base64") },
        },
      },
    });
    expect(release).toHaveBeenCalled();
  });

  it("retries a 503 UNAVAILABLE replicate once, then stores the voice", async () => {
    const preview = Buffer.from("replicated-preview");
    const sourceAudio = Buffer.from("source-wav");
    const consentAudio = Buffer.from("consent-wav");
    const release = vi.fn(async () => {});
    const busy = Object.assign(
      new Error(
        "ProviderHttpError: Google voices request failed (503): The service is currently unavailable. [code=UNAVAILABLE]",
      ),
      { status: 503, statusCode: 503, code: "UNAVAILABLE" },
    );
    postJsonRequestMock.mockRejectedValueOnce(busy).mockResolvedValueOnce({
      response: jsonResponse({
        id: "voice_replicated",
        display_name: "Bobby",
        sample_audio: { data: preview.toString("base64"), mime_type: "audio/wav" },
      }),
      release,
    });
    const provider = buildGoogleSpeechProvider();
    const replicated = await provider.replicateVoice?.({
      providerConfig: { apiKey: "***" },
      displayName: "Bobby",
      sourceAudio,
      consentAudio,
      timeoutMs: 5_000,
    });
    expect(replicated?.id).toBe("voice_replicated");
    expect(postJsonRequestMock).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects empty replication recordings before calling Google", async () => {
    const provider = buildGoogleSpeechProvider();
    await expect(
      provider.replicateVoice?.({
        providerConfig: { apiKey: "google-test-key" },
        displayName: "Bobby",
        sourceAudio: Buffer.alloc(0),
        consentAudio: Buffer.from("consent-wav"),
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/non-empty source and consent/);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });
});
