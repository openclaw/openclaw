import { describe, expect, it } from "vitest";
import {
  isOpenAIApiBaseUrl,
  isOpenAICodexBaseUrl,
  OPENAI_API_BASE_URL,
  resolveConfiguredOpenAIBaseUrl,
} from "./base-url.js";

describe("openai base url helpers", () => {
  it("resolves the configured provider base url or falls back to the native default", () => {
    expect(resolveConfiguredOpenAIBaseUrl(undefined)).toBe(OPENAI_API_BASE_URL);
    expect(
      resolveConfiguredOpenAIBaseUrl({
        models: {
          providers: {
            openai: {
              baseUrl: " https://proxy.example.com/v1 ",
            },
          },
        },
      } as never),
    ).toBe("https://proxy.example.com/v1");
  });

  it("detects native OpenAI API and Codex routes without treating proxies as native", () => {
    expect(isOpenAIApiBaseUrl("https://api.openai.com")).toBe(true);
    expect(isOpenAIApiBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isOpenAIApiBaseUrl("https://proxy.example.com/v1")).toBe(false);

    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/api")).toBe(false);
  });
});
