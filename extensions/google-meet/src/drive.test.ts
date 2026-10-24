import { describe, expect, it, vi } from "vitest";
import { listGoogleMeetCalendarEvents } from "./calendar.js";
import { exportGoogleDriveDocumentText } from "./drive.js";
import { fetchGoogleMeetSpace } from "./meet-api.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const mockFetch = vi.mocked(fetchWithSsrFGuard);
const exportDocument = () =>
  exportGoogleDriveDocumentText({ accessToken: "tok", documentId: "doc-id" });
function mockResponse(response: Response) {
  const release = vi.fn(async () => undefined);
  mockFetch.mockResolvedValueOnce({ response, finalUrl: "https://googleapis.com/", release });
  return release;
}

const googleApiRequests = [
  ["Meet", () => fetchGoogleMeetSpace({ accessToken: "tok", meeting: "abc-defg-hij" })],
  ["Calendar", () => listGoogleMeetCalendarEvents({ accessToken: "tok" })],
  ["Drive", exportDocument],
] as const;

describe.each(googleApiRequests)("%s guarded response cleanup", (_name, run) => {
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
    const release = mockResponse(response);

    await expect(run()).rejects.toThrow(
      failure === "error response" ? "failed (403): denied" : "body read failed",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});

function makeStreamResponse(sizeBytes: number): Response {
  const chunk = new Uint8Array(Math.min(sizeBytes, 65536)).fill(0x78);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let sent = 0; sent < sizeBytes; sent += chunk.length) {
        controller.enqueue(chunk.subarray(0, sizeBytes - sent));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/plain" } });
}

describe("exportGoogleDriveDocumentText bound", () => {
  it("returns document text when response is within the 16 MiB cap", async () => {
    const release = mockResponse(makeStreamResponse(256));
    expect(await exportDocument()).toBe("x".repeat(256));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects with a size error when response exceeds 16 MiB cap (fail-closed)", async () => {
    const release = mockResponse(makeStreamResponse(17 * 1024 * 1024));
    await expect(exportDocument()).rejects.toThrow(/exceeds/i);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
