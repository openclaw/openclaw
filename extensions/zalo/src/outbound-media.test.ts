import { beforeEach, describe, expect, it, vi } from "vitest";

const loadOutboundMediaFromUrlMock = vi.fn();

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: (...args: unknown[]) => loadOutboundMediaFromUrlMock(...args),
}));

import {
  clearHostedZaloMediaForTest,
  prepareHostedZaloMediaUrl,
  resolveHostedZaloMediaRoutePrefix,
  tryHandleHostedZaloMediaRequest,
} from "./outbound-media.js";

function createMockResponse() {
  const headers = new Map<string, string>();
  return {
    headers,
    res: {
      statusCode: 200,
      setHeader(name: string, value: string) {
        headers.set(name, value);
      },
      end: vi.fn(),
    },
  };
}

describe("zalo outbound hosted media", () => {
  beforeEach(() => {
    clearHostedZaloMediaForTest();
    loadOutboundMediaFromUrlMock.mockReset();
    loadOutboundMediaFromUrlMock.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/png",
      fileName: "photo.png",
    });
  });

  it("loads outbound media under OpenClaw control and returns a hosted URL", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
    });

    expect(loadOutboundMediaFromUrlMock).toHaveBeenCalledWith("https://example.com/photo.png", {
      maxBytes: 1024,
    });
    expect(hostedUrl).toMatch(
      /^https:\/\/gateway\.example\.com\/zalo-webhook\/media\/[a-f0-9]+\?token=[a-f0-9]+$/,
    );
  });

  it("preserves the root webhook path when deriving the hosted media route", () => {
    expect(
      resolveHostedZaloMediaRoutePrefix({
        webhookUrl: "https://gateway.example.com/",
      }),
    ).toBe("/media");
  });

  it("serves hosted media once when the route token matches", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
    });
    const { pathname, search } = new URL(hostedUrl);
    const response = createMockResponse();

    const handled = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: `${pathname}${search}`,
      } as never,
      response.res as never,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.res.end).toHaveBeenCalledWith(Buffer.from("image-bytes"));

    const secondResponse = createMockResponse();
    const handledAgain = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: `${pathname}${search}`,
      } as never,
      secondResponse.res as never,
    );

    expect(handledAgain).toBe(true);
    expect(secondResponse.res.statusCode).toBe(404);
  });

  it("rejects hosted media requests with the wrong token", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/custom/zalo",
      webhookPath: "/custom/zalo-hook",
      maxBytes: 1024,
    });
    const pathname = new URL(hostedUrl).pathname;
    const response = createMockResponse();

    const handled = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: `${pathname}?token=wrong`,
      } as never,
      response.res as never,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(401);
    expect(response.res.end).toHaveBeenCalledWith("Unauthorized");
  });
});
