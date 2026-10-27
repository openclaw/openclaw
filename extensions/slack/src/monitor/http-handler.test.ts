import { request } from "node:http";
import { text } from "node:stream/consumers";
import { HTTPReceiver } from "@slack/bolt";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createSlackHttpRequestHandler } from "./http-handler.js";

type HttpResult = {
  statusCode: number | undefined;
  body: string;
};

async function withSlackHttpServer(
  use: (port: number, requestCount: () => number) => Promise<void>,
  receiver: Parameters<typeof createSlackHttpRequestHandler>[0]["receiver"] = new HTTPReceiver({
    signingSecret: "test-secret",
    endpoints: "/slack/events",
  }),
) {
  const handler = createSlackHttpRequestHandler({ receiver, accountId: "default" });
  let requestCount = 0;
  await withServer(
    (req, res) => {
      requestCount += 1;
      void handler(req, res);
    },
    async (baseUrl) => use(Number(new URL(baseUrl).port), () => requestCount),
  );
}

function openChunkedRequest(port: number): ReturnType<typeof request> {
  const req = request({
    host: "127.0.0.1",
    port,
    path: "/slack/events",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "transfer-encoding": "chunked",
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": "v0=invalid",
    },
  });
  req.on("error", () => {});
  return req;
}

function readResponse(req: ReturnType<typeof request>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    req.once("response", (res) => {
      void text(res).then((body) => resolve({ statusCode: res.statusCode, body }), reject);
    });
    req.once("error", reject);
  });
}

describe("createSlackHttpRequestHandler", () => {
  it.each([
    ["oversized", 413, "Payload too large"],
    ["stalled", 408, "Request body timeout"],
  ] as const)(
    "rejects a %s body before Bolt signature verification",
    async (kind, statusCode, body) => {
      await withSlackHttpServer(async (port) => {
        const req = openChunkedRequest(port);
        const response = readResponse(req);
        try {
          if (kind === "oversized") {
            req.write(Buffer.alloc(768 * 1024, 0x61));
            req.end(Buffer.alloc(768 * 1024, 0x62));
          } else {
            req.write("{");
          }
          await expect(response).resolves.toEqual({ statusCode, body });
        } finally {
          req.destroy();
        }
      });
    },
  );
  it("bounds concurrent requests before another pre-auth body read starts", async () => {
    const receiver = { requestListener: vi.fn() };
    await withSlackHttpServer(async (port, requestCount) => {
      const stalled = Array.from({ length: 8 }, () => openChunkedRequest(port));
      for (const req of stalled) {
        req.write("{");
      }
      await vi.waitFor(() => expect(requestCount()).toBe(8));
      const competing = openChunkedRequest(port);
      const response = readResponse(competing);
      competing.end("{}");
      await expect(response).resolves.toEqual({
        statusCode: 429,
        body: "Too Many Requests",
      });
      expect(receiver.requestListener).not.toHaveBeenCalled();
      for (const req of stalled) {
        req.destroy();
      }
    }, receiver);
  });
});
