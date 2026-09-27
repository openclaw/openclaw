// Xai tests cover how the xAI OAuth refresh grant decodes token response bytes.
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
import { refreshXaiOAuthCredential } from "./xai-oauth.js";

function createXaiOAuthCredential(): OAuthCredential & { tokenEndpoint: string } {
  return {
    type: "oauth",
    provider: "xai",
    access: "access-1",
    refresh: "refresh-1",
    expires: 100,
    tokenEndpoint: "https://auth.x.ai/oauth2/token",
  };
}

/** Streams one byte at a time so multi-byte scalars straddle decoder chunks. */
function byteStreamResponse(bytes: Buffer, init?: ResponseInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(stream) {
        for (const byte of bytes) {
          stream.enqueue(Uint8Array.of(byte));
        }
        stream.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" }, ...init },
  );
}

describe("xAI OAuth refresh response bytes", () => {
  it.each([
    { name: "a truncated multi-byte sequence", invalid: [0xe2, 0x82] },
    { name: "a lone continuation byte", invalid: [0x80] },
    { name: "an overlong encoding", invalid: [0xc0, 0xaf] },
  ])("rejects a rotated refresh token carrying $name", async ({ invalid }) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      byteStreamResponse(
        Buffer.concat([
          Buffer.from('{"access_token":"access-2","refresh_token":"refresh-2-'),
          Buffer.from(invalid),
          Buffer.from('","expires_in":120}'),
        ]),
      ),
    );

    const error = await refreshXaiOAuthCredential(createXaiOAuthCredential(), { fetchImpl }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("xAI OAuth refresh failed");
    expect((error as Error).message).not.toContain("�");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

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

    const refreshed = await refreshXaiOAuthCredential(createXaiOAuthCredential(), {
      fetchImpl,
      now: () => 1_000,
    });

    expect(refreshed.access).toBe("access-café-🚀");
    expect(refreshed.refresh).toBe("refresh-日本語");
  });

  it("still reports the OAuth error when a failed refresh response has invalid bytes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      byteStreamResponse(
        Buffer.concat([
          Buffer.from('{"error":"invalid_grant","error_description":"unknown token '),
          Buffer.from([0xe2, 0x82]),
          Buffer.from('"}'),
        ]),
        { status: 400 },
      ),
    );

    await expect(
      refreshXaiOAuthCredential(createXaiOAuthCredential(), { fetchImpl }),
    ).rejects.toThrow("invalid_grant (unknown token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
