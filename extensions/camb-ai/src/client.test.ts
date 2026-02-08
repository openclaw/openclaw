import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CambAiConfig } from "./config.js";
import { CambClientWrapper } from "./client.js";

function createConfig(overrides: Partial<CambAiConfig> = {}): CambAiConfig {
  return {
    enabled: true,
    apiKey: "test-api-key",
    tts: {
      model: "mars-flash",
      defaultLanguage: "en-us",
      defaultVoiceId: 123,
      outputFormat: "mp3",
    },
    voiceCloning: { enabled: false },
    soundGeneration: { enabled: false },
    pollingIntervalMs: 100, // Fast for tests
    pollingTimeoutMs: 1000,
    ...overrides,
  };
}

describe("CambClientWrapper", () => {
  describe("getClient", () => {
    it("throws error when API key is not configured", () => {
      const config = createConfig({ apiKey: undefined });
      const wrapper = new CambClientWrapper(config);

      expect(() => wrapper.getClient()).toThrow("Camb AI API key not configured");
    });

    it("creates client when API key is configured", () => {
      const config = createConfig({ apiKey: "my-api-key" });
      const wrapper = new CambClientWrapper(config);

      const client = wrapper.getClient();

      expect(client).toBeDefined();
    });

    it("returns same client instance on subsequent calls", () => {
      const config = createConfig({ apiKey: "my-api-key" });
      const wrapper = new CambClientWrapper(config);

      const client1 = wrapper.getClient();
      const client2 = wrapper.getClient();

      expect(client1).toBe(client2);
    });
  });

  describe("getSpeechModel", () => {
    it("maps mars-flash to mars-flash", () => {
      const config = createConfig({ tts: { ...createConfig().tts, model: "mars-flash" } });
      const wrapper = new CambClientWrapper(config);

      expect(wrapper.getSpeechModel()).toBe("mars-flash");
    });

    it("maps mars-pro to mars-pro", () => {
      const config = createConfig({ tts: { ...createConfig().tts, model: "mars-pro" } });
      const wrapper = new CambClientWrapper(config);

      expect(wrapper.getSpeechModel()).toBe("mars-pro");
    });

    it("maps mars-instruct to mars-instruct", () => {
      const config = createConfig({ tts: { ...createConfig().tts, model: "mars-instruct" } });
      const wrapper = new CambClientWrapper(config);

      expect(wrapper.getSpeechModel()).toBe("mars-instruct");
    });

    it("maps auto to auto", () => {
      const config = createConfig({ tts: { ...createConfig().tts, model: "auto" } });
      const wrapper = new CambClientWrapper(config);

      expect(wrapper.getSpeechModel()).toBe("auto");
    });

    it("returns undefined for unknown model", () => {
      const config = createConfig({
        tts: { ...createConfig().tts, model: "unknown-model" as any },
      });
      const wrapper = new CambClientWrapper(config);

      expect(wrapper.getSpeechModel()).toBeUndefined();
    });
  });

  describe("pollForCompletion", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns result when status is SUCCESS", async () => {
      const config = createConfig();
      const wrapper = new CambClientWrapper(config);

      const checkStatus = vi.fn().mockResolvedValue({ status: "SUCCESS", run_id: 42 });
      const getResult = vi.fn().mockResolvedValue({ audio: "base64data" });

      const resultPromise = wrapper.pollForCompletion(checkStatus, getResult);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual({ audio: "base64data" });
      expect(getResult).toHaveBeenCalledWith(42);
    });

    it("throws error when status is FAILED", async () => {
      const config = createConfig();
      const wrapper = new CambClientWrapper(config);

      const checkStatus = vi.fn().mockResolvedValue({ status: "FAILED" });
      const getResult = vi.fn();

      // Attach rejection handler immediately to prevent unhandled rejection
      const resultPromise = wrapper.pollForCompletion(checkStatus, getResult).catch((e) => e);
      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("Task failed");
      expect(getResult).not.toHaveBeenCalled();
    });

    it("polls until SUCCESS", async () => {
      const config = createConfig({ pollingIntervalMs: 100 });
      const wrapper = new CambClientWrapper(config);

      const checkStatus = vi
        .fn()
        .mockResolvedValueOnce({ status: "PENDING" })
        .mockResolvedValueOnce({ status: "PROCESSING" })
        .mockResolvedValueOnce({ status: "SUCCESS", run_id: 99 });
      const getResult = vi.fn().mockResolvedValue({ done: true });

      const resultPromise = wrapper.pollForCompletion(checkStatus, getResult);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual({ done: true });
      expect(checkStatus).toHaveBeenCalledTimes(3);
    });

    it("times out after pollingTimeoutMs", async () => {
      const config = createConfig({ pollingIntervalMs: 100, pollingTimeoutMs: 250 });
      const wrapper = new CambClientWrapper(config);

      const checkStatus = vi.fn().mockResolvedValue({ status: "PENDING" });
      const getResult = vi.fn();

      // Attach rejection handler immediately to prevent unhandled rejection
      const resultPromise = wrapper.pollForCompletion(checkStatus, getResult).catch((e) => e);
      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/timed out/i);
    });
  });
});
