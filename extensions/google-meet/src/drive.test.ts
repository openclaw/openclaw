// Google Meet tests cover bounded Drive document export response reads.
import { describe, expect, it, vi } from "vitest";
import { listGoogleMeetCalendarEvents } from "./calendar.js";
import { exportGoogleDriveDocumentText } from "./drive.js";
import { fetchGoogleMeetSpace } from "./meet-api.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const mockFetch = vi.mocked(fetchWithSsrFGuard);

const googleApiRequests = [
  {
    name: "Meet",
    run: () => fetchGoogleMeetSpace({ accessToken: "tok", meeting: "abc-defg-hij" }),
  },
  {
    name: "Calendar",
    run: () => listGoogleMeetCalendarEvents({ accessToken: "tok" }),
  },
  {
    name: "Drive",
    run: () => exportGoogleDriveDocumentText({ accessToken: "tok", documentId: "doc-id" }),
  },
];

describe.each(googleApiRequests)("$name guarded response cleanup", ({ run }) => {
  it.each(["error response", "body read failure"])("releases after %s", async (failure) => {
    const response =
      failure === "error response"
        ? new Response("denied", { status: 403 })
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("body read failed"));
              },
            }),
          );
    const release = vi.fn(async () => undefined);
    mockFetch.mockResolvedValueOnce({ response, finalUrl: "https://googleapis.com/", release });

    await expect(run()).rejects.toThrow(
      failure === "error response" ? "failed (403): denied" : "body read failed",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});

function makeStreamResponse(sizeBytes: number, status = 200): Response {
  const chunk = new Uint8Array(Math.min(sizeBytes, 65536)).fill(0x78); // 'x'
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= sizeBytes) {
        controller.close();
        return;
      }
      const remaining = sizeBytes - sent;
      const toSend = Math.min(chunk.length, remaining);
      controller.enqueue(chunk.subarray(0, toSend));
      sent += toSend;
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

describe("exportGoogleDriveDocumentText bound", () => {
  it("returns document text when response is within the 16 MiB cap", async () => {
    const UNDER_CAP = 256;
    const response = makeStreamResponse(UNDER_CAP);
    mockFetch.mockResolvedValueOnce({
      response,
      finalUrl: "https://www.googleapis.com/drive/v3/files/doc-id/export?mimeType=text%2Fplain",
      release: vi.fn(async () => undefined),
    });

    const result = await exportGoogleDriveDocumentText({
      accessToken: "tok",
      documentId: "doc-id",
    });

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("rejects with a size error when response exceeds 16 MiB cap (fail-closed)", async () => {
    const OVER_CAP = 17 * 1024 * 1024; // 17 MiB
    const response = makeStreamResponse(OVER_CAP);
    const release = vi.fn(async () => undefined);
    mockFetch.mockResolvedValueOnce({
      response,
      finalUrl: "https://www.googleapis.com/drive/v3/files/doc-id/export?mimeType=text%2Fplain",
      release,
    });

    await expect(
      exportGoogleDriveDocumentText({ accessToken: "tok", documentId: "doc-id" }),
    ).rejects.toThrow(/exceeds/i);

    expect(release).toHaveBeenCalledTimes(1);
  });
});
