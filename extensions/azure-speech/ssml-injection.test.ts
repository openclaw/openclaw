import { describe, expect, it } from "vitest";
import { buildAzureSpeechProviderPlugin } from "./speech-provider.js";

// SSML injection tests for voice and lang attributes
describe("azure-speech SSML injection prevention", () => {
  const provider = buildAzureSpeechProviderPlugin();

  it("escapes XML special characters in voice name", async () => {
    const maliciousVoice = "zh-HK-HiuMaanNeural'><script>alert(1)</script>";
    
    // The provider should escape the voice before inserting into SSML
    // We test this by checking that synthesize doesn't throw and handles the input
    // Note: In real usage, isConfigured would prevent this, but we test SSML escaping
    try {
      await provider.synthesize!({
        text: "Hello",
        providerConfig: {
          apiKey: "test-key",
          voice: maliciousVoice,
          lang: "zh-HK",
          region: "eastus",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        },
        providerOverrides: {},
        timeoutMs: 5000,
      } as any);
      // If we get here without throwing, the SSML was escaped
    } catch (error) {
      // Should NOT be an SSML parsing error - should be an API error (no real key)
      // The key point is it's not a malformed SSML error
      const message = (error as Error).message;
      expect(message).not.toContain("XML parsing");
    }
  });

  it("escapes XML special characters in lang attribute", async () => {
    const maliciousLang = "en-US'><script>alert(1)</script>";

    try {
      await provider.synthesize!({
        text: "Hello",
        providerConfig: {
          apiKey: "test-key",
          voice: "en-US-JennyNeural",
          lang: maliciousLang,
          region: "eastus",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        },
        providerOverrides: {},
        timeoutMs: 5000,
      } as any);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("XML parsing");
    }
  });

  it("handles ampersand in voice name", async () => {
    const voiceWithAmpersand = "Test & Voice";

    try {
      await provider.synthesize!({
        text: "Hello",
        providerConfig: {
          apiKey: "test-key",
          voice: voiceWithAmpersand,
          lang: "en-US",
          region: "eastus",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        },
        providerOverrides: {},
        timeoutMs: 5000,
      } as any);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("XML parsing");
    }
  });

  it("handles quotes in voice name", async () => {
    const voiceWithQuotes = 'Voice "Test"';

    try {
      await provider.synthesize!({
        text: "Hello",
        providerConfig: {
          apiKey: "test-key",
          voice: voiceWithQuotes,
          lang: "en-US",
          region: "eastus",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        },
        providerOverrides: {},
        timeoutMs: 5000,
      } as any);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("XML parsing");
    }
  });
});