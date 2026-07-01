// Vertex ADC tests cover bounded OAuth token response reads on refresh.
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetGoogleVertexAuthorizedUserTokenCacheForTest,
  resolveGoogleVertexAuthorizedUserHeaders,
} from "./vertex-adc.js";

function streamingOversizedTokenResponse(params: { chunkCount: number; chunkSize: number }): {
  response: Response;
  getReadCount: () => number;
} {
  let reads = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(encoder.encode("a".repeat(params.chunkSize)));
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    getReadCount: () => reads,
  };
}

describe("vertex-adc OAuth token response bounds", () => {
  afterEach(() => {
    resetGoogleVertexAuthorizedUserTokenCacheForTest();
    vi.unstubAllEnvs();
  });

  it("parses a normal token refresh response", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-oauth-bound-"));
    const credentialsPath = path.join(tempDir, "application_default_credentials.json");
    await writeFile(
      credentialsPath,
      JSON.stringify({
        type: "authorized_user",
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: "refresh-token",
      }),
      "utf8",
    );
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", credentialsPath);

    const tokenFetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ya29.normal", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(resolveGoogleVertexAuthorizedUserHeaders(tokenFetchMock)).resolves.toEqual({
      Authorization: "Bearer ya29.normal",
    });
  });

  it("rejects oversized token refresh bodies instead of buffering the whole stream", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-oauth-bound-"));
    const credentialsPath = path.join(tempDir, "application_default_credentials.json");
    await writeFile(
      credentialsPath,
      JSON.stringify({
        type: "authorized_user",
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: "refresh-token",
      }),
      "utf8",
    );
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", credentialsPath);

    const streamed = streamingOversizedTokenResponse({ chunkCount: 18, chunkSize: 1024 * 1024 });
    const tokenFetchMock = vi.fn().mockResolvedValue(streamed.response);

    await expect(resolveGoogleVertexAuthorizedUserHeaders(tokenFetchMock)).rejects.toThrow(
      /Google OAuth token response exceeds 16777216 bytes/,
    );
  });
});
