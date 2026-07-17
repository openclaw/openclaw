// Vydra tests cover speech provider plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVydraSpeechProvider } from "./speech-provider.js";

describe("vydra speech provider", () => {
  const provider = buildVydraSpeechProvider();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reports configured when VYDRA_API_KEY is set", () => {
    vi.stubEnv("VYDRA_API_KEY", "vydra_test_key");
    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 5_000 })).toBe(true);
  });

  it("reports configured when providerConfig apiKey is set", () => {
    vi.stubEnv("VYDRA_API_KEY", "");
    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "config-key" },
        timeoutMs: 5_000,
      }),
    ).toBe(true);
  });

  it("reports not configured when no key is available", () => {
    vi.stubEnv("VYDRA_API_KEY", "");
    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 5_000 })).toBe(false);
  });

  it("rejects blank environment key before synthesis", async () => {
    vi.stubEnv("VYDRA_API_KEY", "   ");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 5_000 })).toBe(false);
    await expect(
      provider.synthesize({
        text: "test",
        cfg: {} as never,
        providerConfig: {},
        target: "audio-file",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("Vydra API key missing");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects blank config apiKey before synthesis", async () => {
    vi.stubEnv("VYDRA_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "   " },
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
    ).rejects.toThrow("Vydra API key missing");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("has correct provider metadata", () => {
    expect(provider.id).toBe("vydra");
    expect(provider.label).toBe("Vydra");
  });
});
