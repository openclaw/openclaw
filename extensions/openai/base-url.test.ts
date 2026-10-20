import { describe, expect, it } from "vitest";
import {
  canonicalizeCodexResponsesBaseUrl,
  classifyOpenAIBaseUrl,
  isOpenAIApiBaseUrl,
  isOpenAICodexBaseUrl,
  OPENAI_API_BASE_URL,
  OPENAI_CODEX_RESPONSES_BASE_URL,
  resolveOpenAIDefaultBaseUrl,
} from "./base-url.js";

function expectUrls<T>(read: (url?: string) => T, expected: T, urls: (string | undefined)[]) {
  for (const url of urls) {
    expect(read(url), String(url)).toBe(expected);
  }
}
const platform = "https://api.openai.com";
const chatgpt = "https://chatgpt.com/backend-api";
const nativePlatformUrls = ["/v1", ":443/v1", "./v1"].map((path) => platform + path);

describe("openai base URL helpers", () => {
  it("recognizes direct OpenAI API routes", () => {
    expect(isOpenAIApiBaseUrl("http://api.openai.com/v1")).toBe(false);
    expectUrls(isOpenAIApiBaseUrl, true, [platform, platform + "/v1/", ...nativePlatformUrls]);
  });

  it("rejects proxy or unrelated API routes", () => {
    expectUrls(isOpenAIApiBaseUrl, false, [
      "ftp://api.openai.com/v1",
      "https://proxy.example.com/v1",
      "https://chatgpt.com/backend-api",
      undefined,
    ]);
  });

  it("classifies exact HTTPS native endpoints as official", () => {
    expect(classifyOpenAIBaseUrl(undefined)).toBe("unresolved");
    expectUrls(classifyOpenAIBaseUrl, "platform", nativePlatformUrls);
    expect(classifyOpenAIBaseUrl(chatgpt + "/codex/responses")).toBe("chatgpt");
    expect(classifyOpenAIBaseUrl("https://proxy.example.test/v1?tenant=one")).toBe("custom");
    expectUrls(classifyOpenAIBaseUrl, "invalid", [
      "ftp://api.openai.com/v1",
      "http://api.openai.com/v1",
      "http://chatgpt.com/backend-api/codex",
      platform + ":8443/v1",
      "http://api.openai.com:443/v1",
      "https://user@api.openai.com/v1",
      platform + "/v1/models",
      platform + "/v1?proxy=1",
      chatgpt + "/codex#fragment",
      "not a URL",
    ]);
  });

  it("recognizes Codex ChatGPT backend routes", () => {
    expect(isOpenAICodexBaseUrl("http://chatgpt.com/backend-api/codex")).toBe(false);
    expectUrls(isOpenAICodexBaseUrl, true, [
      ...["/codex", "/codex/", "/codex/v1", "/codex/v1/", "/codex/responses"].map(
        (path) => chatgpt + path,
      ),
      "https://chatgpt.com:443/backend-api/codex",
      "https://chatgpt.com./backend-api/codex",
      ...["", "/", "/v1", "/v1/"].map((path) => chatgpt + path),
    ]);
  });

  it("rejects non-Codex backend routes", () => {
    expectUrls(isOpenAICodexBaseUrl, false, [
      "ftp://chatgpt.com/backend-api/codex",
      "https://api.openai.com/v1",
      "https://chatgpt.com",
      chatgpt + "/v2",
      chatgpt + "/codex/v2",
      undefined,
    ]);
  });

  it("canonicalizes legacy Codex Responses base URLs", () => {
    expectUrls(
      canonicalizeCodexResponsesBaseUrl,
      OPENAI_CODEX_RESPONSES_BASE_URL,
      ["", "/v1", "/codex/v1", "/codex/responses"].map((path) => chatgpt + path),
    );
    for (const url of [
      "http://chatgpt.com/backend-api/codex",
      "https://proxy.example.com/v1",
      undefined,
    ]) {
      expect(canonicalizeCodexResponsesBaseUrl(url)).toBe(url);
    }
  });

  it("resolves default API base URL from OPENAI_BASE_URL", () => {
    expect(resolveOpenAIDefaultBaseUrl({})).toBe(OPENAI_API_BASE_URL);
    expect(resolveOpenAIDefaultBaseUrl({ OPENAI_BASE_URL: "   " })).toBe(OPENAI_API_BASE_URL);
    expect(resolveOpenAIDefaultBaseUrl({ OPENAI_BASE_URL: " https://proxy.example/v1 " })).toBe(
      "https://proxy.example/v1",
    );
  });
});
