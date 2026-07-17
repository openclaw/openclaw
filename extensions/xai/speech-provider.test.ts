// xAI tests cover speech provider plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildXaiSpeechProvider } from "./speech-provider.js";

describe("xai speech provider", () => {
  const provider = buildXaiSpeechProvider();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reports configured when XAI_API_KEY is set", () => {
    vi.stubEnv("XAI_API_KEY", "xai_test_key");
    expect(provider.isConfigured({ providerConfig: {}, cfg: {} as never, timeoutMs: 5_000 })).toBe(
      true,
    );
  });

  it("reports configured when providerConfig apiKey is set", () => {
    vi.stubEnv("XAI_API_KEY", "");
    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "config-key" },
        cfg: {} as never,
        timeoutMs: 5_000,
      }),
    ).toBe(true);
  });

  it("reports not configured when no key is available", () => {
    vi.stubEnv("XAI_API_KEY", "");
    expect(
      provider.isConfigured({
        providerConfig: {},
        cfg: {} as never,
        timeoutMs: 5_000,
      }),
    ).toBe(false);
  });

  it("rejects blank environment key before synthesis", async () => {
    vi.stubEnv("XAI_API_KEY", "   ");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(
      provider.isConfigured({
        providerConfig: {},
        cfg: {} as never,
        timeoutMs: 5_000,
      }),
    ).toBe(false);
    await expect(
      provider.synthesize({
        text: "test",
        cfg: {} as never,
        providerConfig: {},
        target: "audio-file",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("xAI credentials missing for TTS");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects blank config apiKey before synthesis", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "   " },
        cfg: {} as never,
        timeoutMs: 5_000,
      }),
    ).toBe(false);
    await expect(
      provider.synthesize({
        text: "test",
        cfg: {} as never,
        providerConfig: { apiKey: "   " },
        target: "audio-file",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("xAI credentials missing for TTS");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("has correct provider metadata", () => {
    expect(provider.id).toBe("xai");
    expect(provider.label).toBe("xAI");
  });

  it("synthesizes with trimmed env key", async () => {
    vi.stubEnv("XAI_API_KEY", "  xai_key  ");
    const audioData = Buffer.from("mp3-audio");
    const fetchMock = vi.fn().mockResolvedValue(new Response(audioData, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await provider.synthesize({
      text: "Hello",
      cfg: {} as never,
      providerConfig: {},
      target: "audio-file",
      timeoutMs: 30_000,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer xai_key");
  });

  it("synthesizeTelephony rejects blank keys", async () => {
    vi.stubEnv("XAI_API_KEY", "   ");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const telephony = provider.synthesizeTelephony;
    if (!telephony) throw new Error("expected synthesizeTelephony");

    await expect(
      telephony({
        text: "test",
        cfg: {} as never,
        providerConfig: {},
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("xAI credentials missing for TTS");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
