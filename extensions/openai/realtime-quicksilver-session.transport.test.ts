// Only a real socket proves the rejection reaches the client before release.
import { postRawWebhook, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_QUICKSILVER_OFFER_PATH } from "./realtime-quicksilver-session.js";
import { createBroker } from "./realtime-quicksilver.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GPT-Live offer transport", () => {
  it("delivers a rejected offer's response before releasing the connection", async () => {
    const { realtime } = createBroker();
    try {
      await withServer(
        (req, res) => {
          void realtime.handler(req, res);
        },
        async (baseUrl) => {
          const url = `${baseUrl}${OPENAI_QUICKSILVER_OFFER_PATH}`;
          // Offer credentials are single-use, so every request needs its own reservation.
          const offerHeaders = async (): Promise<Record<string, string>> => {
            const reservation = await realtime.broker.createBrowserSession(
              {
                providerConfig: {},
                model: "gpt-live-1",
                runAgentConsult: vi.fn(async () => ({ text: "Done" })),
              },
              { type: "api-key", token: "platform-key" },
            );
            if (reservation.transport !== "webrtc") {
              throw new Error("Expected WebRTC reservation");
            }
            return {
              authorization: `Bearer ${reservation.clientSecret}`,
              "content-type": "application/sdp",
            };
          };

          // Reject from the header while the browser is still mid-upload.
          const declared = await postRawWebhook({
            url,
            body: "v=offer",
            contentLength: 300 * 1024,
            headers: await offerHeaders(),
            idleTimeoutMs: 500,
          });
          expect(declared).toMatchObject({
            statusLine: "HTTP/1.1 413 Payload Too Large",
            body: "Payload too large",
            closedByServer: true,
          });

          // Without a declared length, count the arriving bytes instead.
          const streamed = await postRawWebhook({
            url,
            body: "v".repeat(300 * 1024),
            headers: await offerHeaders(),
            chunkedEncoding: true,
            chunk: { bytes: 32 * 1024, intervalMs: 5 },
            idleTimeoutMs: 500,
          });
          expect(streamed).toMatchObject({
            statusLine: "HTTP/1.1 413 Payload Too Large",
            closedByServer: true,
          });

          // Control: an under-cap offer retains its connection.
          const withinCap = await postRawWebhook({
            url,
            body: "   ",
            headers: await offerHeaders(),
            idleTimeoutMs: 500,
          });
          expect(withinCap.statusLine).toBe("HTTP/1.1 400 Bad Request");
          expect(withinCap.body).toContain("SDP offer is required");
          expect(withinCap.closedByServer).toBe(false);
        },
      );
    } finally {
      await realtime.cleanup();
    }
  });
});
