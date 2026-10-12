import crypto from "node:crypto";
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cameraTempPath } from "../cli/nodes-camera.js";
import {
  readFileUtf8AndCleanup,
  stubFetchTextResponse,
} from "../test-utils/camera-url-test-helpers.js";
import { createNodesTool } from "./tools/nodes-tool.js";

const { callGateway } = vi.hoisted(() => ({ callGateway: vi.fn() }));
vi.mock("../gateway/call.js", () => ({ callGateway }));
vi.mock("../media/media-services.js", () => ({
  buildImageResizeSideGrid: vi.fn(() => [1600]),
  getImageMetadata: vi.fn(async () => ({ width: 1, height: 1 })),
  IMAGE_REDUCE_QUALITY_STEPS: [85],
  isImageProcessorUnavailableError: vi.fn(() => false),
  MAX_IMAGE_INPUT_PIXELS: 25_000_000,
  readImageMetadataFromHeader: vi.fn(() => ({ width: 1, height: 1 })),
  resizeToJpeg: vi.fn(async () => Buffer.from("jpeg")),
}));

const NODE_ID = "mac-1";
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EFBABAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z";
const JPG_PAYLOAD = { format: "jpg", base64: TINY_JPEG_BASE64, width: 1, height: 1 };
const PHOTO = { ...JPG_PAYLOAD, format: "jpeg", createdAt: "2026-03-04T00:00:00Z" };

function executeNodes(
  input: Record<string, unknown>,
  options?: { modelHasVision?: boolean; allowMediaInvokeCommands?: boolean },
) {
  return createNodesTool(options).execute("call1", { node: NODE_ID, ...input });
}
type NodesToolResult = Awaited<ReturnType<typeof executeNodes>>;
type GatewayMockResult = Record<string, unknown> | null | undefined;

function setupNodeInvokeMock(options: {
  commands?: string[];
  remoteIp?: string;
  onInvoke?: (params: unknown) => GatewayMockResult | Promise<GatewayMockResult>;
  invokePayload?: unknown;
}) {
  callGateway.mockImplementation(
    async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === "node.list") {
        return {
          nodes: [
            {
              nodeId: NODE_ID,
              ...(options.commands ? { commands: options.commands } : {}),
              ...(options.remoteIp ? { remoteIp: options.remoteIp } : {}),
            },
          ],
        };
      }
      if (method === "node.invoke") {
        return options.onInvoke
          ? await options.onInvoke(params)
          : { payload: options.invokePayload !== undefined ? options.invokePayload : {} };
      }
      throw new Error(`unexpected method: ${method}`);
    },
  );
}

function expectInvoke(params: unknown, command: string, input: Record<string, unknown>) {
  expect(params).toMatchObject({ nodeId: NODE_ID, command, params: input });
}

function firstMediaUrl(result: NodesToolResult): string {
  const details = result.details as { media?: { mediaUrls?: string[] } } | undefined;
  const mediaUrl = details?.media?.mediaUrls?.[0];
  expect(typeof mediaUrl).toBe("string");
  return mediaUrl ?? "";
}

function firstText(result: NodesToolResult): string {
  const first = result.content?.[0];
  expect(first?.type).toBe("text");
  return first?.type === "text" ? first.text : "";
}

beforeEach(() => {
  callGateway.mockReset();
  setupNodeInvokeMock({});
  vi.unstubAllGlobals();
});

describe("nodes camera_snap", () => {
  it("uses front/high-quality defaults and includes images for vision models", async () => {
    setupNodeInvokeMock({
      onInvoke: (params) => {
        expectInvoke(params, "camera.snap", { facing: "front", maxWidth: 1600, quality: 0.95 });
        return { payload: JPG_PAYLOAD };
      },
    });
    const result = await executeNodes({ action: "camera_snap" }, { modelHasVision: true });
    expect(result.content?.filter((block) => block.type === "image")).toEqual([
      { type: "image", data: JPG_PAYLOAD.base64, mimeType: "image/jpeg" },
    ]);
  });

  it("rejects facing both when deviceId is provided", async () => {
    await expect(
      executeNodes({ action: "camera_snap", facing: "both", deviceId: "cam-123" }),
    ).rejects.toThrow(/facing=both is not allowed when deviceId is set/i);
  });

  it("does not publish the front camera when the back camera returns malformed image data", async () => {
    let captures = 0;
    setupNodeInvokeMock({
      onInvoke: () => ({
        payload: captures++ === 0 ? JPG_PAYLOAD : { ...JPG_PAYLOAD, base64: "not-base64!" },
      }),
    });
    const rename = vi.spyOn(fs, "rename");
    try {
      await expect(executeNodes({ action: "camera_snap", facing: "both" })).rejects.toThrow(
        /invalid base64/i,
      );
      expect(rename).not.toHaveBeenCalled();
    } finally {
      const publishedPaths = rename.mock.calls.map(([, destination]) => String(destination));
      rename.mockRestore();
      await Promise.all(publishedPaths.map((filePath) => fs.unlink(filePath).catch(() => {})));
    }
  });

  it("does not activate the back camera after the front returns an unsupported format", async () => {
    let captures = 0;
    setupNodeInvokeMock({
      onInvoke: () => ({
        payload: captures++ === 0 ? { ...JPG_PAYLOAD, format: "webp" } : JPG_PAYLOAD,
      }),
    });
    await expect(executeNodes({ action: "camera_snap", facing: "both" })).rejects.toThrow(
      /unsupported camera\.snap format/i,
    );
    expect(captures).toBe(1);
  });

  it("downloads camera_snap url payloads when node remoteIp is available", async () => {
    stubFetchTextResponse("url-image");
    setupNodeInvokeMock({
      remoteIp: "198.51.100.42",
      invokePayload: { format: "jpg", url: "https://198.51.100.42/snap.jpg", width: 1, height: 1 },
    });
    const result = await executeNodes({ action: "camera_snap", facing: "front" });
    const mediaUrl = firstMediaUrl(result);
    expect(result.content).toStrictEqual([
      { type: "text", text: `Camera photo saved to ${mediaUrl}.` },
    ]);
    await expect(readFileUtf8AndCleanup(mediaUrl)).resolves.toBe("url-image");
  });
});

describe("nodes camera_clip", () => {
  it("downloads camera_clip url payloads when node remoteIp is available", async () => {
    stubFetchTextResponse("url-clip");
    setupNodeInvokeMock({
      remoteIp: "198.51.100.42",
      invokePayload: {
        format: "mp4",
        url: "https://198.51.100.42/clip.mp4",
        durationMs: 1200,
        hasAudio: false,
      },
    });
    const result = await executeNodes({ action: "camera_clip", facing: "front" });
    await expect(
      readFileUtf8AndCleanup(
        firstText(result)
          .replace(/^FILE:/, "")
          .trim(),
      ),
    ).resolves.toBe("url-clip");
  });
});

describe("nodes photos_latest", () => {
  it("rejects a non-array photos collection instead of reporting an empty photo library", async () => {
    setupNodeInvokeMock({ invokePayload: { photos: {} } });
    await expect(executeNodes({ action: "photos_latest" })).rejects.toThrow(
      "invalid photos.latest payload",
    );
  });

  it("rejects more photos than the node was asked to return", async () => {
    setupNodeInvokeMock({ invokePayload: { photos: [PHOTO, PHOTO] } });
    await expect(executeNodes({ action: "photos_latest" })).rejects.toThrow(
      "photos.latest returned 2 photos; requested at most 1",
    );
  });

  it("rejects an unsupported second photo before writing the first", async () => {
    setupNodeInvokeMock({ invokePayload: { photos: [PHOTO, { ...PHOTO, format: "webp" }] } });
    const firstPhotoId = "00000000-0000-4000-8000-000000000022";
    const secondPhotoId = "00000000-0000-4000-8000-000000000033";
    const firstPhotoPath = cameraTempPath({ kind: "snap", ext: "jpg", id: firstPhotoId });
    const secondPhotoPath = cameraTempPath({ kind: "snap", ext: "jpg", id: secondPhotoId });
    const randomUUID = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce(firstPhotoId)
      .mockReturnValueOnce(secondPhotoId);
    try {
      await expect(executeNodes({ action: "photos_latest", limit: 2 })).rejects.toThrow(
        /unsupported photos\.latest format/i,
      );
      await expect(fs.stat(firstPhotoPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      randomUUID.mockRestore();
      await fs.unlink(firstPhotoPath).catch(() => undefined);
      await fs.unlink(secondPhotoPath).catch(() => undefined);
    }
  });

  it("returns an explicit model-facing result when no photos are available", async () => {
    setupNodeInvokeMock({
      onInvoke: (params) => {
        expectInvoke(params, "photos.latest", { limit: 1, maxWidth: 1600, quality: 0.85 });
        return { payload: { photos: [] } };
      },
    });
    const result = await executeNodes({ action: "photos_latest" }, { modelHasVision: false });
    expect(result.content).toStrictEqual([{ type: "text", text: "No photos found." }]);
    expect(result.details).toStrictEqual([]);
  });

  it("returns media paths and no inline images when model has no vision", async () => {
    setupNodeInvokeMock({ invokePayload: { photos: [PHOTO] }, remoteIp: "198.51.100.42" });
    const result = await executeNodes({ action: "photos_latest" }, { modelHasVision: false });
    const mediaUrl = firstMediaUrl(result);
    expect(mediaUrl).toMatch(/openclaw-camera-snap-.*\.jpg$/);
    expect(result.details).toMatchObject({
      photos: [{ width: 1, height: 1, createdAt: "2026-03-04T00:00:00Z" }],
    });
    expect(result.content).toStrictEqual([
      { type: "text", text: `Library photo saved to ${mediaUrl}.` },
    ]);
  });
});

describe("nodes command actions", () => {
  it("routes device_status and returns its payload", async () => {
    const payload = { battery: { state: "charging", lowPowerModeEnabled: false } };
    setupNodeInvokeMock({
      commands: ["device.status"],
      onInvoke: (params) => {
        expectInvoke(params, "device.status", {});
        return { payload };
      },
    });
    const result = await executeNodes({ action: "device_status" });
    expect(JSON.parse(firstText(result))).toStrictEqual(payload);
  });

  it("routes notification replies with trimmed reply text", async () => {
    const payload = { ok: true, key: "n1", action: "reply" };
    setupNodeInvokeMock({
      commands: ["notifications.actions"],
      onInvoke: (params) => {
        expectInvoke(params, "notifications.actions", {
          key: "n1",
          action: "reply",
          replyText: "On it",
        });
        return { payload };
      },
    });
    const result = await executeNodes({
      action: "notifications_action",
      notificationKey: "n1",
      notificationAction: "reply",
      notificationReplyText: " On it ",
    });
    expect(JSON.parse(firstText(result))).toStrictEqual(payload);
  });

  it("routes location_get with its parameters and returns its payload", async () => {
    const payload = {
      latitude: 37.3346,
      longitude: -122.009,
      accuracyMeters: 18,
      provider: "network",
    };
    setupNodeInvokeMock({
      commands: ["location.get"],
      onInvoke: (params) => {
        expectInvoke(params, "location.get", {
          maxAgeMs: 12_000,
          desiredAccuracy: "balanced",
          timeoutMs: 4_500,
        });
        return { payload };
      },
    });
    const result = await executeNodes({
      action: "location_get",
      maxAgeMs: 12_000,
      desiredAccuracy: "balanced",
      locationTimeoutMs: 4_500,
    });
    expect(JSON.parse(firstText(result))).toStrictEqual(payload);
  });
});

describe("nodes invoke", () => {
  it("blocks media invoke commands to avoid base64 context bloat", async () => {
    await expect(
      executeNodes({
        action: "invoke",
        invokeCommand: "photos.latest",
        invokeParamsJson: '{"limit":1}',
      }),
    ).rejects.toThrow(/use action="photos_latest"/i);
  });

  it("allows media invoke commands when explicitly enabled", async () => {
    const payload = { photos: [{ format: "jpg", base64: "aGVsbG8=", width: 1, height: 1 }] };
    setupNodeInvokeMock({
      onInvoke: (params) => {
        expectInvoke(params, "photos.latest", { limit: 1 });
        return { payload };
      },
    });
    const result = await executeNodes(
      { action: "invoke", invokeCommand: "photos.latest", invokeParamsJson: '{"limit":1}' },
      { allowMediaInvokeCommands: true },
    );
    expect(result.details).toStrictEqual({ payload });
  });
});
