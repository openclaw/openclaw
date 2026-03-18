import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTelegramApiBase, resolveTelegramApiHostname } from "./api-base.js";

describe("resolveTelegramApiBase", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns default when TELEGRAM_BOT_API_HOST is not set", () => {
    vi.stubEnv("TELEGRAM_BOT_API_HOST", "");
    expect(resolveTelegramApiBase()).toBe("https://api.telegram.org");
  });

  it("returns custom host with https:// when full URL is provided", () => {
    vi.stubEnv("TELEGRAM_BOT_API_HOST", "https://my-bot-api.example.com");
    expect(resolveTelegramApiBase()).toBe("https://my-bot-api.example.com");
  });

  it("adds https:// when only a hostname is provided", () => {
    vi.stubEnv("TELEGRAM_BOT_API_HOST", "my-bot-api.example.com");
    expect(resolveTelegramApiBase()).toBe("https://my-bot-api.example.com");
  });

  it("strips trailing slashes", () => {
    vi.stubEnv("TELEGRAM_BOT_API_HOST", "https://my-bot-api.example.com/");
    expect(resolveTelegramApiBase()).toBe("https://my-bot-api.example.com");
  });

  it("accepts http:// scheme", () => {
    vi.stubEnv("TELEGRAM_BOT_API_HOST", "http://localhost:8080");
    expect(resolveTelegramApiBase()).toBe("http://localhost:8080");
  });

  it("trims whitespace from env value", () => {
    vi.stubEnv("TELEGRAM_BOT_API_HOST", "  https://my-bot-api.example.com  ");
    expect(resolveTelegramApiBase()).toBe("https://my-bot-api.example.com");
  });

  it("accepts env object override for testing", () => {
    expect(resolveTelegramApiBase({ TELEGRAM_BOT_API_HOST: "custom.host.io" })).toBe(
      "https://custom.host.io",
    );
  });
});

describe("resolveTelegramApiHostname", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns default hostname when not configured", () => {
    vi.stubEnv("TELEGRAM_BOT_API_HOST", "");
    expect(resolveTelegramApiHostname()).toBe("api.telegram.org");
  });

  it("extracts hostname from custom URL", () => {
    vi.stubEnv("TELEGRAM_BOT_API_HOST", "https://my-bot-api.example.com");
    expect(resolveTelegramApiHostname()).toBe("my-bot-api.example.com");
  });

  it("extracts hostname when only a hostname is provided", () => {
    vi.stubEnv("TELEGRAM_BOT_API_HOST", "my-bot-api.example.com");
    expect(resolveTelegramApiHostname()).toBe("my-bot-api.example.com");
  });

  it("accepts env object override for testing", () => {
    expect(resolveTelegramApiHostname({ TELEGRAM_BOT_API_HOST: "custom.host.io" })).toBe(
      "custom.host.io",
    );
  });
});
