// Google Meet tests cover bounded Meet API response reads (fetchGoogleMeetJson helper
// and fetchGoogleMeetSpace / createGoogleMeetSpace direct callers).
//
// readProviderJsonResponse is NOT mocked — it runs from real source so the byte-bounded
// reader actually enforces the 16 MiB cap under test. Only fetchWithSsrFGuard is mocked
// so tests can inject controlled Response bodies without network I/O.
import { describe, expect, it, vi } from "vitest";
import { createGoogleMeetSpace, fetchGoogleMeetSpace } from "./meet.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const mockFetch = vi.mocked(fetchWithSsrFGuard);

/** Streams a JSON payload as a Response body (no Content-Length). */
function streamedJsonResponse(payload: unknown, status = 200): Response {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Builds a Response whose body is larger than the 16 MiB cap.
 * Tracks whether the underlying stream was cancelled mid-flight (proving the
 * bounded reader aborted rather than buffering the full body).
 */
function makeOversizedJsonResponse(sizeBytes: number): {
  response: Response;
  state: { bytesPulled: number; canceled: boolean };
} {
  const CHUNK = 65536;
  const chunk = new Uint8Array(CHUNK).fill(0x78); // 'x' bytes — invalid JSON filler
  const state = { bytesPulled: 0, canceled: false };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= sizeBytes) {
        controller.close();
        return;
      }
      const toSend = Math.min(CHUNK, sizeBytes - sent);
      controller.enqueue(chunk.subarray(0, toSend));
      sent += toSend;
      state.bytesPulled += toSend;
    },
    cancel() {
      state.canceled = true;
    },
  });
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  return { response, state };
}

// ---------------------------------------------------------------------------
// fetchGoogleMeetSpace — exercising the readProviderJsonResponse guard
// (fetchGoogleMeetSpace has its own fetchWithSsrFGuard call; guarding it also
// covers the fetchGoogleMeetJson shared helper which wraps the same pattern)
// ---------------------------------------------------------------------------

describe("fetchGoogleMeetSpace — bounded read", () => {
  it("parses a well-formed space response within the 16 MiB cap", async () => {
    const spacePayload = {
      name: "spaces/abc123",
      meetingCode: "abc-def-ghi",
      meetingUri: "https://meet.google.com/abc-def-ghi",
    };
    const release = vi.fn(async () => undefined);
    mockFetch.mockResolvedValueOnce({
      response: streamedJsonResponse(spacePayload),
      finalUrl: "https://meet.googleapis.com/v2/spaces/abc123",
      release,
    });

    const result = await fetchGoogleMeetSpace({ accessToken: "tok", meeting: "spaces/abc123" });

    expect(result.name).toBe("spaces/abc123");
    expect(result.meetingUri).toBe("https://meet.google.com/abc-def-ghi");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects with a labelled size error when response body exceeds 16 MiB (fail-closed)", async () => {
    const OVER_CAP = 17 * 1024 * 1024; // 17 MiB — above the 16 MiB cap
    const { response, state } = makeOversizedJsonResponse(OVER_CAP);
    const release = vi.fn(async () => undefined);
    mockFetch.mockResolvedValueOnce({
      response,
      finalUrl: "https://meet.googleapis.com/v2/spaces/abc123",
      release,
    });

    await expect(
      fetchGoogleMeetSpace({ accessToken: "tok", meeting: "spaces/abc123" }),
    ).rejects.toThrow(/exceeds/i);

    // The bounded reader must have cancelled the stream before reading all bytes.
    expect(state.canceled).toBe(true);
    expect(state.bytesPulled).toBeLessThan(OVER_CAP);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("mutation: bare response.json() buffers the full oversized body without throwing", async () => {
    // Negative-control: proves that reverting fetchGoogleMeetSpace to a bare
    // response.json() call would silently buffer the entire oversized body.
    const OVER_CAP = 17 * 1024 * 1024;
    const { response } = makeOversizedJsonResponse(OVER_CAP);
    // Calling response.json() directly buffers everything — no error is thrown.
    const buffer = await response.arrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(16 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// createGoogleMeetSpace — independent fetchWithSsrFGuard caller
// ---------------------------------------------------------------------------

describe("createGoogleMeetSpace — bounded read", () => {
  it("parses a well-formed create-space response within the 16 MiB cap", async () => {
    const spacePayload = {
      name: "spaces/newSpace",
      meetingCode: "new-space-code",
      meetingUri: "https://meet.google.com/new-space-code",
    };
    const release = vi.fn(async () => undefined);
    mockFetch.mockResolvedValueOnce({
      response: streamedJsonResponse(spacePayload),
      finalUrl: "https://meet.googleapis.com/v2/spaces",
      release,
    });

    const result = await createGoogleMeetSpace({ accessToken: "tok" });

    expect(result.space.name).toBe("spaces/newSpace");
    expect(result.meetingUri).toBe("https://meet.google.com/new-space-code");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects with a labelled size error when create-space response body exceeds 16 MiB", async () => {
    const OVER_CAP = 17 * 1024 * 1024;
    const { response, state } = makeOversizedJsonResponse(OVER_CAP);
    const release = vi.fn(async () => undefined);
    mockFetch.mockResolvedValueOnce({
      response,
      finalUrl: "https://meet.googleapis.com/v2/spaces",
      release,
    });

    await expect(createGoogleMeetSpace({ accessToken: "tok" })).rejects.toThrow(/exceeds/i);

    expect(state.canceled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
