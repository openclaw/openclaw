/**
 * Tests for readGoogleOauthTokenResponsePayload bounded body reads.
 */
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readGoogleOauthTokenResponsePayload } from "./vertex-adc.js";

const ONE_MIB = 1024 * 1024;
const SIXTEEN_MIB = 16 * ONE_MIB;

function jsonResponse(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function streamedResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("readGoogleOauthTokenResponsePayload", () => {
  it("parses a valid token response", async () => {
    const payload = await readGoogleOauthTokenResponsePayload(
      jsonResponse({ access_token: "ya29.token123", expires_in: 3600 }),
    );
    expect(payload?.access_token).toBe("ya29.token123");
    expect(payload?.expires_in).toBe(3600);
  });

  it("returns undefined for an empty body", async () => {
    const result = await readGoogleOauthTokenResponsePayload(new Response("", { status: 200 }));
    expect(result).toBeUndefined();
  });

  it("returns undefined for invalid JSON", async () => {
    const result = await readGoogleOauthTokenResponsePayload(
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(result).toBeUndefined();
  });

  it("handles gzip-compressed token responses", async () => {
    const compressed = gzipSync(Buffer.from(JSON.stringify({ access_token: "gzip-token" })));
    const result = await readGoogleOauthTokenResponsePayload(
      new Response(compressed, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      }),
    );
    expect(result?.access_token).toBe("gzip-token");
  });

  it("parses error responses with error_description", async () => {
    const payload = await readGoogleOauthTokenResponsePayload(
      jsonResponse({ error: "invalid_grant", error_description: "Token has been revoked" }),
    );
    expect(payload?.error).toBe("invalid_grant");
    expect(payload?.error_description).toBe("Token has been revoked");
  });

  it("throws on response exceeding 16 MiB via stream", async () => {
    const oversized = new Uint8Array(SIXTEEN_MIB + 1).fill(0x41);
    await expect(readGoogleOauthTokenResponsePayload(streamedResponse(oversized))).rejects.toThrow(
      "google-vertex-adc: token response exceeds 16 MiB",
    );
  });

  it("succeeds on response just under 16 MiB via stream", async () => {
    const targetSize = SIXTEEN_MIB - 1024; // 16 MiB - 1 KiB
    const innerLen = targetSize - 12; // '{"data":"'.length(9) + '"}"'.length(3) = 12
    const bytes = new TextEncoder().encode(`{"data":"${"A".repeat(Math.max(0, innerLen))}"}`);
    expect(bytes.byteLength).toBeLessThan(SIXTEEN_MIB);

    const result = await readGoogleOauthTokenResponsePayload(streamedResponse(bytes));
    expect(result).toBeDefined();
  });

  it("handles non-streaming Response via arrayBuffer fallback", async () => {
    const fallbackResponse = new Response(JSON.stringify({ access_token: "plain-buffer" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(fallbackResponse, "body", { value: null });

    const result = await readGoogleOauthTokenResponsePayload(fallbackResponse);
    expect(result?.access_token).toBe("plain-buffer");
  });

  it("throws on non-streaming oversized response via arrayBuffer fallback", async () => {
    const oversized = new Uint8Array(SIXTEEN_MIB + 1).fill(0x42);
    const fallbackResponse = new Response(oversized, { status: 200 });
    Object.defineProperty(fallbackResponse, "body", { value: null });

    await expect(readGoogleOauthTokenResponsePayload(fallbackResponse)).rejects.toThrow(
      "google-vertex-adc: token response exceeds 16 MiB",
    );
  });

  it("throws on gzip response that decompresses past decoded cap", async () => {
    // A small compressed payload that decompresses to > 16 MiB should be
    // caught by the decoded-output cap, even though the wire payload is
    // well under the 16 MiB wire limit.
    const oversized = new Uint8Array(SIXTEEN_MIB + 1).fill(0x41);
    const compressed = gzipSync(oversized);
    expect(compressed.length).toBeLessThan(oversized.length);
    await expect(
      readGoogleOauthTokenResponsePayload(
        new Response(compressed, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
        }),
      ),
    ).rejects.toThrow("decompressed token response exceeds");
  });

  it("handles whitespace-only body gracefully", async () => {
    const result = await readGoogleOauthTokenResponsePayload(
      new Response("   \n  ", { status: 200 }),
    );
    expect(result).toBeUndefined();
  });
});
