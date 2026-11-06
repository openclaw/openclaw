import { expect, it } from "vitest";
import * as base from "./base-url.js";

type Urls = readonly (string | undefined)[];
function expectUrls<T>(read: (url?: string) => T, expected: T, urls: Urls) {
  expect(urls.map(read)).toEqual(urls.map(() => expected));
}
const platform = "https://api.openai.com";
const chatgpt = "https://chatgpt.com/backend-api";
const proxy = "https://proxy.example.com/v1";
const plaintextApi = "http://api.openai.com/v1";
const plaintextCodex = "http://chatgpt.com/backend-api/codex";
const ftpApi = "ftp://api.openai.com/v1";
const nativePlatformUrls = ["/v1", ":443/v1", "./v1"].map((path) => platform + path);
const nativeCodexUrls = [
  ...["", "/codex"].flatMap((root) =>
    ["", "/", "/v1", "/v1/"].map((suffix) => chatgpt + root + suffix),
  ),
  chatgpt + "/codex/responses",
  "https://chatgpt.com:443/backend-api/codex",
  "https://chatgpt.com./backend-api/codex",
];
const nonCodexUrls = [
  plaintextCodex,
  "ftp://chatgpt.com/backend-api/codex",
  "https://api.openai.com/v1",
  "https://chatgpt.com",
  chatgpt + "/v2",
  chatgpt + "/codex/v2",
  undefined,
];

it.each([
  [true, [platform, platform + "/v1/", ...nativePlatformUrls]],
  [false, [plaintextApi, ftpApi, proxy, chatgpt, undefined]],
] as const)("recognizes API routes: %s", (expected, urls) => {
  expectUrls(base.isOpenAIApiBaseUrl, expected, urls);
});

it("classifies exact HTTPS native endpoints as official", () => {
  expect(base.classifyOpenAIBaseUrl(undefined)).toBe("unresolved");
  expectUrls(base.classifyOpenAIBaseUrl, "platform", nativePlatformUrls);
  expect(base.classifyOpenAIBaseUrl(chatgpt + "/codex/responses")).toBe("chatgpt");
  expect(base.classifyOpenAIBaseUrl("https://proxy.example.test/v1?tenant=one")).toBe("custom");
  expectUrls(base.classifyOpenAIBaseUrl, "invalid", [
    ftpApi,
    plaintextApi,
    plaintextCodex,
    platform + ":8443/v1",
    "http://api.openai.com:443/v1",
    "https://user@api.openai.com/v1",
    platform + "/v1/models",
    platform + "/v1?proxy=1",
    chatgpt + "/codex#fragment",
    "not a URL",
  ]);
});

it.each([
  [true, nativeCodexUrls],
  [false, nonCodexUrls],
] as const)("recognizes Codex routes: %s", (expected, urls) => {
  expectUrls(base.isOpenAICodexBaseUrl, expected, urls);
});

it("canonicalizes legacy Codex Responses base URLs", () => {
  expectUrls(
    base.canonicalizeCodexResponsesBaseUrl,
    base.OPENAI_CODEX_RESPONSES_BASE_URL,
    ["", "/v1", "/codex/v1", "/codex/responses"].map((path) => chatgpt + path),
  );
  for (const url of [plaintextCodex, proxy, undefined]) {
    expect(base.canonicalizeCodexResponsesBaseUrl(url)).toBe(url);
  }
});

it("resolves default API base URL from OPENAI_BASE_URL", () => {
  const resolve = base.resolveOpenAIDefaultBaseUrl;
  expect(resolve({})).toBe(base.OPENAI_API_BASE_URL);
  expect(resolve({ OPENAI_BASE_URL: "   " })).toBe(base.OPENAI_API_BASE_URL);
  expect(resolve({ OPENAI_BASE_URL: " https://proxy.example/v1 " })).toBe(
    "https://proxy.example/v1",
  );
});
