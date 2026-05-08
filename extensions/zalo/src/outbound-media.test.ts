import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetPluginBlobStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "openclaw-zalo-outbound-media-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    resetPluginBlobStoreForTests();
    await clearHostedZaloMediaForTest();
    loadOutboundMediaFromUrlMock.mockReset();
    loadOutboundMediaFromUrlMock.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/png",
      fileName: "photo.png",
    });
  });

  afterEach(async () => {
    await clearHostedZaloMediaForTest();
    resetPluginBlobStoreForTests();
    vi.unstubAllEnvs();
    await rm(stateDir, { recursive: true, force: true });
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

  it("passes proxy-aware fetch options into hosted media downloads", async () => {
    await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
      proxyUrl: "http://proxy.example:8080",
    });

    expect(loadOutboundMediaFromUrlMock).toHaveBeenCalledWith("https://example.com/photo.png", {
      maxBytes: 1024,
      proxyUrl: "http://proxy.example:8080",
    });
  });

  it("stores hosted media in the OpenClaw SQLite database", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
    });

    if (process.platform === "win32") {
      expect(hostedUrl).toContain("/zalo-webhook/media/");
      return;
    }

    const { pathname } = new URL(hostedUrl);
    const id = pathname.split("/").pop();
    if (!id) {
      throw new Error("expected hosted Zalo media id");
    }
    expect(id).toEqual(expect.stringMatching(/^[a-f0-9-]+$/));

    const dbStats = await stat(join(stateDir, "state", "openclaw.sqlite"));
    expect(dbStats.isFile()).toBe(true);
    await expect(
      stat(join(stateDir, "openclaw-zalo-outbound-media", `${id}.json`)),
    ).rejects.toThrow();
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

  it("rejects malformed hosted media ids before touching disk", async () => {
    const response = createMockResponse();

    const handled = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: "/zalo-webhook/media/not-a-valid-hex-id?token=wrong",
      } as never,
      response.res as never,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(404);
    expect(response.res.end).toHaveBeenCalledWith("Not Found");
  });
});
