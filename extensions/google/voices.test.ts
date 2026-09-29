import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest as requireFirstRecordArg,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithTimeoutMock, fetchWithTimeoutGuardedMock, postJsonRequestMock } =
  getProviderHttpMocks();

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
  it("keeps the static catalog when the project list fails", async () => {
    fetchWithTimeoutMock.mockRejectedValue(
      Object.assign(
        new Error(
          "ProviderHttpError: Google voices request failed (503): The service is currently unavailable. [code=UNAVAILABLE]",
        ),
        { status: 503, statusCode: 503, code: "UNAVAILABLE" },
      ),
    );
    const provider = buildGoogleSpeechProvider();
    const voices = await provider.listVoices?.({
      providerConfig: { apiKey: "***" },
      timeoutMs: 5_000,
    });
    expect(voices?.some((voice) => voice.id === "Achernar")).toBe(true);
    expect(voices?.some((voice) => voice.id === "Kore")).toBe(true);
    expect(voices?.projectListingIncomplete).toBe(true);
  });

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
    expect(voices?.[0]).toEqual({
      id: "voice_stored",
      name: "Dry Lab Assistant",
      category: "prompted",
      stored: true,
      locale: "en-US",
    });
    expect(voices?.filter((voice) => voice.id === "Achernar")).toEqual([
      { id: "Achernar", name: "Achernar", category: "prebuilt", stored: false },
    ]);
    expect(voices?.some((voice) => voice.id === "Kore")).toBe(true);
    const firstUrl = String(fetchWithTimeoutMock.mock.calls[0]?.[0]);
    const secondUrl = String(fetchWithTimeoutMock.mock.calls[1]?.[0]);
    expect(firstUrl).toContain("/v1beta/voices?");
    expect(firstUrl).toContain("page_size=100");
    expect(secondUrl).toContain("page_token=page-2");
  });

  it.each([true, false])(
    "preserves the capped catalog when the last page has more results: %s",
    async (hasMore) => {
      for (let page = 1; page <= 10; page += 1) {
        fetchWithTimeoutMock.mockResolvedValueOnce(
          jsonResponse({
            voices: [{ id: `voice_${page}`, display_name: `Stored ${page}`, type: "prompted" }],
            ...(page < 10 || hasMore ? { next_page_token: `page-${page + 1}` } : {}),
          }),
        );
      }
      const provider = buildGoogleSpeechProvider();
      const voices = await provider.listVoices?.({
        providerConfig: { apiKey: "test-key" },
        timeoutMs: 5_000,
      });
      expect(voices?.filter((voice) => voice.stored).map((voice) => voice.id)).toEqual([
        "voice_1",
        "voice_2",
        "voice_3",
        "voice_4",
        "voice_5",
        "voice_6",
        "voice_7",
        "voice_8",
        "voice_9",
        "voice_10",
      ]);
      expect(voices?.some((voice) => voice.id === "Kore")).toBe(true);
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(10);
      expect(voices?.projectListingIncomplete === true).toBe(hasMore);
    },
  );

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
    if (!designed || designed.outcome === "uncertain") {
      throw new Error("Expected a stored voice");
    }
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
    const sourceAudio = Buffer.from("source-wav");
    const consentAudio = Buffer.from("consent-wav");
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: jsonResponse({
        id: "voice_replicated",
        display_name: "Bobby",
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
    if (!replicated || replicated.outcome === "uncertain") {
      throw new Error("Expected a stored voice");
    }
    expect(replicated?.id).toBe("voice_replicated");
    expect(replicated?.name).toBe("Bobby");
    expect(replicated?.previewAudio.equals(Buffer.alloc(0))).toBe(true);
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

  it("does not retry a 503 CreateVoice POST", async () => {
    const sourceAudio = Buffer.from("source-wav");
    const consentAudio = Buffer.from("consent-wav");
    const busy = Object.assign(
      new Error(
        "ProviderHttpError: Google voices request failed (503): The service is currently unavailable. [code=UNAVAILABLE]",
      ),
      { status: 503, statusCode: 503, code: "UNAVAILABLE" },
    );
    postJsonRequestMock.mockRejectedValue(busy);
    const provider = buildGoogleSpeechProvider();
    await expect(
      provider.replicateVoice?.({
        providerConfig: { apiKey: "***" },
        displayName: "Bobby",
        sourceAudio,
        consentAudio,
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ outcome: "uncertain" });
    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
  });

  it.each([502, 504, "malformed-json", "malformed-preview"])(
    "keeps ambiguous CreateVoice %s outcomes uncertain",
    async (failure) => {
      postJsonRequestMock.mockResolvedValue({
        response:
          typeof failure === "number"
            ? new Response("upstream failure", { status: failure })
            : failure === "malformed-json"
              ? new Response("{", { headers: { "content-type": "application/json" } })
              : jsonResponse({
                  id: "voice_created",
                  sample_audio: { data: "not base64!", mime_type: "audio/wav" },
                }),
        release: vi.fn(async () => {}),
      });
      const result = await buildGoogleSpeechProvider().replicateVoice?.({
        providerConfig: { apiKey: "test-key" },
        displayName: "Test",
        sourceAudio: Buffer.from("source"),
        consentAudio: Buffer.from("consent"),
        timeoutMs: 5000,
      });
      expect(result).toMatchObject({ outcome: "uncertain" });
      expect(postJsonRequestMock).toHaveBeenCalledOnce();
    },
  );

  it("retries a 503 list once, then returns project voices", async () => {
    const busy = Object.assign(
      new Error(
        "ProviderHttpError: Google voices request failed (503): The service is currently unavailable. [code=UNAVAILABLE]",
      ),
      { status: 503, statusCode: 503, code: "UNAVAILABLE" },
    );
    fetchWithTimeoutMock.mockRejectedValueOnce(busy).mockResolvedValueOnce(
      jsonResponse({
        voices: [{ id: "voice_stored", display_name: "Dry Lab Assistant", type: "prompted" }],
      }),
    );
    const provider = buildGoogleSpeechProvider();
    const voices = await provider.listVoices?.({
      providerConfig: { apiKey: "***" },
      timeoutMs: 5_000,
    });
    expect(voices?.[0]).toEqual({
      id: "voice_stored",
      name: "Dry Lab Assistant",
      category: "prompted",
      stored: true,
    });
    expect(voices?.some((voice) => voice.id === "Kore")).toBe(true);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
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

  it("rejects a revoked writer before posting store:true", async () => {
    const sourceAudio = Buffer.from("source-wav");
    const consentAudio = Buffer.from("consent-wav");
    const provider = buildGoogleSpeechProvider();
    await expect(
      provider.replicateVoice?.({
        providerConfig: { apiKey: "***" },
        displayName: "Bobby",
        sourceAudio,
        consentAudio,
        timeoutMs: 5_000,
        assertCurrent: () => {
          throw Object.assign(new Error("TTS voice-store caller is no longer authorized."), {
            name: "SessionMutationAuthorizationChangedError",
          });
        },
      }),
    ).rejects.toMatchObject({ name: "SessionMutationAuthorizationChangedError" });
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("rejects a writer revoked during CreateVoice HTTP preparation", async () => {
    const sourceAudio = Buffer.from("source-wav");
    const consentAudio = Buffer.from("consent-wav");
    const fetchImpl = vi.fn(async () => new Response("should-not-send"));
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
      "openclaw/plugin-sdk/provider-http",
    );
    postJsonRequestMock.mockImplementation((params) => actual.postJsonRequest(params as never));
    fetchWithTimeoutGuardedMock.mockImplementation((...args) =>
      actual.fetchWithTimeoutGuarded(
        ...(args as Parameters<typeof actual.fetchWithTimeoutGuarded>),
      ),
    );
    vi.stubGlobal("fetch", fetchImpl);
    let checks = 0;
    const provider = buildGoogleSpeechProvider();
    try {
      await expect(
        provider.replicateVoice?.({
          providerConfig: { apiKey: "***" },
          displayName: "Bobby",
          sourceAudio,
          consentAudio,
          timeoutMs: 5_000,
          assertCurrent: () => {
            checks += 1;
            if (checks > 1) {
              throw Object.assign(new Error("TTS voice-store caller is no longer authorized."), {
                name: "SessionMutationAuthorizationChangedError",
              });
            }
          },
        }),
      ).rejects.toMatchObject({ name: "SessionMutationAuthorizationChangedError" });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(checks).toBeGreaterThan(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
