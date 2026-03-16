import { describe, expect, it } from "vitest";
import {
  cleanSchemaForGigaChat,
  ensureJsonObjectStr,
  extractGigaChatErrorMessage,
  mapToolNameFromGigaChat,
  mapToolNameToGigaChat,
  parseGigachatBasicCredentials,
  sanitizeFunctionName,
} from "./gigachat-stream.js";

describe("gigachat stream helpers", () => {
  it("maps reserved tool names to and from GigaChat-safe names", () => {
    expect(mapToolNameToGigaChat("web_search")).toBe("__gpt2giga_user_search_web");
    expect(mapToolNameFromGigaChat("__gpt2giga_user_search_web")).toBe("web_search");
  });

  it("sanitizes tool names to GigaChat-compatible identifiers", () => {
    expect(sanitizeFunctionName("search-web!tool")).toBe("search_web_tool");
    expect(sanitizeFunctionName("___")).toBe("func");
  });

  it("parses basic auth credentials without truncating colon-containing passwords", () => {
    expect(parseGigachatBasicCredentials("user:p@ss:with:colons")).toEqual({
      user: "user",
      password: "p@ss:with:colons",
    });
  });

  it("cleans unsupported schema features for GigaChat", () => {
    const cleaned = cleanSchemaForGigaChat({
      type: "object",
      properties: {
        filters: {
          type: "object",
          description: "Advanced filters",
          properties: {
            level: { type: "string", enum: Array.from({ length: 25 }, (_, i) => `v${i}`) },
          },
        },
        tags: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        count: {
          type: ["integer", "null"],
          minimum: 1,
        },
      },
      additionalProperties: false,
    });

    expect(cleaned).toEqual({
      type: "object",
      properties: {
        filters: {
          type: "string",
          description: "Advanced filters (JSON object)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        count: {
          type: "integer",
        },
      },
    });
  });

  it("wraps non-object tool results as JSON objects", () => {
    expect(ensureJsonObjectStr("plain text")).toBe(JSON.stringify({ result: "plain text" }));
    expect(ensureJsonObjectStr('{"ok":true}')).toBe('{"ok":true}');
  });

  it("extracts readable API errors from GigaChat/Axios-like responses", () => {
    const err = new Error("[object Object]") as Error & {
      response?: {
        status?: number;
        data?: unknown;
        config?: { baseURL?: string; url?: string };
      };
    };
    err.response = {
      status: 401,
      data: { message: "invalid credentials" },
      config: {
        baseURL: "https://gigachat.devices.sberbank.ru/api/v1",
        url: "/chat/completions",
      },
    };

    expect(extractGigaChatErrorMessage(err)).toBe(
      "GigaChat API 401 (https://gigachat.devices.sberbank.ru/api/v1/chat/completions): invalid credentials",
    );
  });
});
