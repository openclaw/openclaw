import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { discardIgnoredResponseBody, readQaJsonResponse } from "./ignored-response-body.js";

describe("discardIgnoredResponseBody", () => {
  it("swallows cancellation failures for an unread body", async () => {
    const cancel = vi.fn(() => {
      throw new Error("cancel failed");
    });
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));

    await expect(discardIgnoredResponseBody(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not cancel a body a caller already consumed", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("done"));
          controller.close();
        },
        cancel,
      }),
    );
    await response.text();

    await discardIgnoredResponseBody(response);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("readQaJsonResponse", () => {
  it.each([
    { name: "oversized", body: `{"padding":"${"x".repeat(1 << 20)}"}`, error: /exceeds 1048576/ },
    { name: "stalled", body: "[", error: /stalled for 5000ms/ },
  ])(
    "bounds $name local provider responses and releases the request",
    async ({ name, body, error }) => {
      await withServer(
        (_request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.write(body);
          if (body !== "[") {
            response.end();
          }
        },
        async (baseUrl) => {
          const release = vi.fn(async () => {});
          const response = await fetch(baseUrl);
          try {
            if (name === "stalled") {
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            }
            const reading = readQaJsonResponse(response, release, "qa response");
            // A failed deadline assertion still lets server cleanup reject the real fetch body.
            void reading.catch(() => {});
            if (name === "stalled") {
              await vi.advanceTimersByTimeAsync(0);
              expect(response.bodyUsed).toBe(true);
              await vi.advanceTimersByTimeAsync(4_999);
              expect(release).not.toHaveBeenCalled();
              await vi.advanceTimersByTimeAsync(1);
              expect(release).toHaveBeenCalledOnce();
            }
            await expect(reading).rejects.toThrow(error);
            expect(release).toHaveBeenCalledOnce();
          } finally {
            vi.useRealTimers();
          }
        },
      );
    },
  );
});
