import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createCacheFetchMock,
  createCapturingStreamFn,
  fetchInit,
  makeGoogleModel,
  makeSessionManager,
  preparePromptCacheStream,
} from "./google-prompt-cache.test-support.js";

describe("Google prompt-cache credential routing", () => {
  it.each(['{"token":"","projectId":"demo"}', "{not-json}"])(
    "uses API key auth for %j",
    async (apiKey) => {
      const fetchMock = createCacheFetchMock({
        name: "cachedContents/auth-fallback",
        expireTime: new Date(2_000_000).toISOString(),
      });
      const { streamFn } = createCapturingStreamFn();
      const wrapped = expectDefined(
        await preparePromptCacheStream({
          apiKey,
          fetchMock,
          now: 1_000_000,
          sessionManager: makeSessionManager(),
          streamFn,
        }),
        "cache wrapper",
      );

      await wrapped(
        makeGoogleModel(),
        { systemPrompt: `Follow policy.${SYSTEM_PROMPT_CACHE_BOUNDARY}`, messages: [] },
        {},
      );

      const headers = new Headers(fetchInit(fetchMock).headers);
      expect(headers.get("x-goog-api-key")).toBe(apiKey);
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.get("Content-Type")).toBe("application/json");
    },
  );
});
