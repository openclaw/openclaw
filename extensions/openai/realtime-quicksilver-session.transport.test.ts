// Only a real socket proves the rejection reaches the client before release.
import { postRawWebhook, withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { OPENAI_QUICKSILVER_OFFER_PATH } from "./realtime-quicksilver-session.js";
import { createBroker } from "./realtime-quicksilver.test-helpers.js";

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
        const offer = async (
          body: string,
          upload: Pick<
            Parameters<typeof postRawWebhook>[0],
            "contentLength" | "chunk" | "chunkedEncoding"
          > = {},
        ) => {
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
          return postRawWebhook({
            url,
            body,
            idleTimeoutMs: 500,
            ...upload,
            headers: {
              authorization: `Bearer ${reservation.clientSecret}`,
              "content-type": "application/sdp",
            },
          });
        };

        // Reject from the header while the browser is still mid-upload.
        const declared = await offer("v=offer", { contentLength: 300 * 1024 });
        expect(declared).toMatchObject({
          statusLine: "HTTP/1.1 413 Payload Too Large",
          body: "Payload too large",
          closedByServer: true,
        });

        // Without a declared length, count the arriving bytes instead.
        const streamed = await offer("v".repeat(300 * 1024), {
          chunkedEncoding: true,
          chunk: { bytes: 32 * 1024, intervalMs: 5 },
        });
        expect(streamed).toMatchObject({
          statusLine: "HTTP/1.1 413 Payload Too Large",
          closedByServer: true,
        });

        // Control: an under-cap offer retains its connection.
        expect(await offer("   ")).toMatchObject({
          statusLine: "HTTP/1.1 400 Bad Request",
          body: expect.stringContaining("SDP offer is required"),
          closedByServer: false,
        });
      },
    );
  } finally {
    await realtime.cleanup();
  }
});
