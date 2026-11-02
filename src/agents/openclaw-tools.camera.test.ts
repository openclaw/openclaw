import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
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
const PHOTO = { ...JPG_PAYLOAD, format: "jpeg" };

function executeNodes(
  input: Record<string, unknown>,
  options?: { modelHasVision?: boolean; allowMediaInvokeCommands?: boolean },
) {
  return createNodesTool(options).execute("call1", { node: NODE_ID, ...input });
}
type NodesToolResult = Awaited<ReturnType<typeof executeNodes>>;

function setupNodeInvokeMock(options: {
  commands?: string[];
  remoteIp?: string;
  onInvoke?: (params: unknown) => { payload: unknown };
  invokePayload?: unknown;
}) {
  callGateway.mockImplementation(
    async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === "node.list") {
        return {
          nodes: [{ nodeId: NODE_ID, commands: options.commands, remoteIp: options.remoteIp }],
        };
      }
      if (method === "node.invoke") {
        return options.onInvoke
          ? options.onInvoke(params)
          : { payload: options.invokePayload !== undefined ? options.invokePayload : {} };
      }
      throw new Error(`unexpected method: ${method}`);
    },
  );
}

function mockInvoke(
  command: string,
  input: Record<string, unknown>,
  payload: unknown,
  commands?: string[],
) {
  setupNodeInvokeMock({
    commands,
    onInvoke: (params) => {
      expect(params).toMatchObject({ nodeId: NODE_ID, command, params: input });
      return { payload };
    },
  });
}

async function expectNodeError(input: Record<string, unknown>, error: string | RegExp) {
  await expect(executeNodes(input)).rejects.toThrow(error);
}

async function expectNoPublication(input: Record<string, unknown>, error: string | RegExp) {
  const rename = vi.spyOn(fs, "rename");
  try {
    await expectNodeError(input, error);
    expect(rename).not.toHaveBeenCalled();
  } finally {
    const paths = rename.mock.calls.map(([, destination]) => String(destination));
    rename.mockRestore();
    await Promise.all(paths.map((file) => fs.unlink(file).catch(() => {})));
  }
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
  setRuntimeConfigSnapshot({});
  callGateway.mockReset();
  setupNodeInvokeMock({});
  vi.unstubAllGlobals();
});
afterEach(() => clearRuntimeConfigSnapshot());

it("camera_snap uses front/high-quality defaults and includes images for vision models", async () => {
  mockInvoke("camera.snap", { facing: "front", maxWidth: 1600, quality: 0.95 }, JPG_PAYLOAD);
  const result = await executeNodes({ action: "camera_snap" }, { modelHasVision: true });
  expect(result.content?.filter((block) => block.type === "image")).toEqual([
    { type: "image", data: JPG_PAYLOAD.base64, mimeType: "image/jpeg" },
  ]);
});

it.each([
  [1, { ...JPG_PAYLOAD, base64: "not-base64!" }, /invalid base64/i, 2],
  [0, { ...JPG_PAYLOAD, format: "webp" }, /unsupported camera\.snap format/i, 1],
] as const)(
  "does not publish partial captures when camera %s is invalid",
  async (index, invalid, error, count) => {
    let captures = 0;
    setupNodeInvokeMock({
      onInvoke: () => ({
        payload: captures++ === index ? invalid : JPG_PAYLOAD,
      }),
    });
    await expectNoPublication({ action: "camera_snap", facing: "both" }, error);
    expect(captures).toBe(count);
  },
);

it.each([
  [
    "camera_snap",
    { format: "jpg", url: "https://198.51.100.42/snap.jpg", width: 1, height: 1 },
    "url-image",
  ],
  [
    "camera_clip",
    { format: "mp4", url: "https://198.51.100.42/clip.mp4", durationMs: 1200, hasAudio: false },
    "url-clip",
  ],
] as const)(
  "downloads %s URL payloads from the node remoteIp",
  async (action, invokePayload, text) => {
    stubFetchTextResponse(text);
    setupNodeInvokeMock({ remoteIp: "198.51.100.42", invokePayload });
    const result = await executeNodes({ action, facing: "front" });
    const mediaUrl =
      action === "camera_snap"
        ? firstMediaUrl(result)
        : firstText(result)
            .replace(/^FILE:/, "")
            .trim();
    if (action === "camera_snap") {
      expect(result.content).toStrictEqual([
        { type: "text", text: `Camera photo saved to ${mediaUrl}.` },
      ]);
    }
    await expect(readFileUtf8AndCleanup(mediaUrl)).resolves.toBe(text);
  },
);

it.each([
  [{ photos: {} }, "invalid photos.latest payload"],
  [{ photos: [PHOTO, PHOTO] }, "photos.latest returned 2 photos; requested at most 1"],
] as const)("rejects invalid photo collections: %j", async (invokePayload, error) => {
  setupNodeInvokeMock({ invokePayload });
  await expectNodeError({ action: "photos_latest" }, error);
});

it("rejects an unsupported second photo before writing the first", async () => {
  setupNodeInvokeMock({ invokePayload: { photos: [PHOTO, { ...PHOTO, format: "webp" }] } });
  await expectNoPublication(
    { action: "photos_latest", limit: 2 },
    /unsupported photos\.latest format/i,
  );
});

it("returns an explicit model-facing result when no photos are available", async () => {
  mockInvoke("photos.latest", { limit: 1, maxWidth: 1600, quality: 0.85 }, { photos: [] });
  const result = await executeNodes({ action: "photos_latest" }, { modelHasVision: false });
  expect(result.content).toStrictEqual([{ type: "text", text: "No photos found." }]);
  expect(result.details).toStrictEqual([]);
});

it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
  ["device.status", { action: "device_status" }, {}],
  [
    "notifications.actions",
    {
      action: "notifications_action",
      notificationKey: "n1",
      notificationAction: "reply",
      notificationReplyText: " On it ",
    },
    { key: "n1", action: "reply", replyText: "On it" },
  ],
  [
    "location.get",
    {
      action: "location_get",
      maxAgeMs: 12_000,
      desiredAccuracy: "balanced",
      locationTimeoutMs: 4_500,
    },
    { maxAgeMs: 12_000, desiredAccuracy: "balanced", timeoutMs: 4_500 },
  ],
])(
  "routes %s with normalized parameters and returns its payload",
  async (command, input, params) => {
    const payload = { fixture: "node reply" };
    mockInvoke(command, params, payload, [command]);
    expect(JSON.parse(firstText(await executeNodes(input)))).toStrictEqual(payload);
  },
);

it("blocks media invoke commands to avoid base64 context bloat", async () => {
  await expectNodeError(
    { action: "invoke", invokeCommand: "photos.latest", invokeParamsJson: '{"limit":1}' },
    /use action="photos_latest"/i,
  );
});

it("allows media invoke commands when explicitly enabled", async () => {
  const payload = { photos: [{ format: "jpg", base64: "aGVsbG8=", width: 1, height: 1 }] };
  mockInvoke("photos.latest", { limit: 1 }, payload);
  const result = await executeNodes(
    { action: "invoke", invokeCommand: "photos.latest", invokeParamsJson: '{"limit":1}' },
    { allowMediaInvokeCommands: true },
  );
  expect(result.details).toStrictEqual({ payload });
});
