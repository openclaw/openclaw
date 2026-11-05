import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClosedChunkStream } from "../test-support/streaming-error-response.js";
import { refreshXaiOAuthCredential } from "./xai-oauth.js";

const credential = {
  type: "oauth",
  provider: "xai",
  access: "access-1",
  refresh: "refresh-1",
  expires: 100,
  tokenEndpoint: "https://auth.x.ai/oauth2/token",
} satisfies OAuthCredential;

/** Streams one byte at a time so multi-byte scalars straddle decoder chunks. */
function byteStreamResponse(bytes: Buffer, status = 200): Response {
  return new Response(createClosedChunkStream(Array.from(bytes, (byte) => Uint8Array.of(byte))), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("xAI OAuth refresh response bytes", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    {
      status: 200,
      prefix: '{"access_token":"access-2","refresh_token":"refresh-2-',
      suffix: '","expires_in":120}',
    },
    {
      status: 400,
      prefix: '{"error":"invalid_grant","error_description":"unknown token ',
      suffix: '"}',
    },
  ])(
    "handles invalid UTF-8 in HTTP $status without retrying",
    async ({ status, prefix, suffix }) => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        byteStreamResponse(
          Buffer.concat([Buffer.from(prefix), Buffer.from([0xe2, 0x82]), Buffer.from(suffix)]),
          status,
        ),
      );
      vi.stubGlobal("fetch", fetchImpl);
      const refreshing = refreshXaiOAuthCredential(credential);
      await expect(refreshing).rejects.toMatchObject({
        message: "xAI OAuth refresh response could not be read",
        oauthRefreshOutcome: { version: 1, phase: "token-response", outcome: "unknown", status },
      });
      await expect(refreshing).rejects.not.toThrow("�");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("refreshes tokens whose Unicode scalars straddle response chunks", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      byteStreamResponse(
        Buffer.from(
          JSON.stringify({
            access_token: "access-café-🚀",
            refresh_token: "refresh-日本語",
            expires_in: 120,
          }),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const refreshed = await refreshXaiOAuthCredential(credential);
    expect(refreshed.access).toBe("access-café-🚀");
    expect(refreshed.refresh).toBe("refresh-日本語");
  });
});
