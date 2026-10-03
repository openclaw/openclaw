import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
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
  return new Response(
    new ReadableStream<Uint8Array>({
      start(stream) {
        for (const byte of bytes) {
          stream.enqueue(Uint8Array.of(byte));
        }
        stream.close();
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

describe("xAI OAuth refresh response bytes", () => {
  it.each([
    {
      status: 200,
      prefix: '{"access_token":"access-2","refresh_token":"refresh-2-',
      suffix: '","expires_in":120}',
      error: "xAI OAuth refresh failed",
    },
    {
      status: 400,
      prefix: '{"error":"invalid_grant","error_description":"unknown token ',
      suffix: '"}',
      error: "invalid_grant (unknown token",
    },
  ])(
    "handles invalid UTF-8 in HTTP $status without retrying",
    async ({ status, prefix, suffix, error }) => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        byteStreamResponse(
          Buffer.concat([Buffer.from(prefix), Buffer.from([0xe2, 0x82]), Buffer.from(suffix)]),
          status,
        ),
      );
      const refreshing = refreshXaiOAuthCredential(credential, { fetchImpl });
      await expect(refreshing).rejects.toThrow(error);
      if (status === 200) {
        await expect(refreshing).rejects.toBeInstanceOf(Error);
        await expect(refreshing).rejects.not.toThrow("�");
      }
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
    const refreshed = await refreshXaiOAuthCredential(credential, { fetchImpl, now: () => 1_000 });
    expect(refreshed.access).toBe("access-café-🚀");
    expect(refreshed.refresh).toBe("refresh-日本語");
  });
});
