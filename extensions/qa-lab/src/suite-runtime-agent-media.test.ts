import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fetchJsonMock = vi.hoisted(() => vi.fn());
const patchConfigMock = vi.hoisted(() =>
  vi.fn<typeof import("./suite-runtime-gateway.js").patchConfig>(async () => undefined),
);
const readConfigSnapshotMock = vi.hoisted(() =>
  vi.fn(async () => ({ hash: "hash", config: { plugins: { allow: [] as string[] } } })),
);

vi.mock("./suite-runtime-gateway.js", () => ({
  fetchJson: fetchJsonMock,
  patchConfig: patchConfigMock,
  readConfigSnapshot: readConfigSnapshotMock,
  waitForGatewayHealthy: vi.fn(async () => undefined),
  waitForTransportReady: vi.fn(async () => undefined),
}));

import {
  ensureImageGenerationConfigured,
  extractMediaPathFromText,
  resolveGeneratedImagePath,
} from "./suite-runtime-agent-media.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();

function resolveImage(tempRoot: string) {
  return resolveGeneratedImagePath({
    env: { mock: { baseUrl: "http://127.0.0.1:9999" }, gateway: { tempRoot } } as never,
    promptSnippet: "prompt snippet",
    startedAtMs: Date.now(),
    timeoutMs: 2_000,
  });
}
async function writeImage(tempRoot: string, name: string) {
  const file = path.join(tempRoot, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "png", "utf8");
  return file;
}
function request(mediaPath: string, allInputText = "prompt snippet") {
  return {
    allInputText,
    toolOutput: JSON.stringify({ details: { media: { mediaUrls: [mediaPath] } } }),
  };
}

afterEach(cleanup);

beforeEach(() => {
  fetchJsonMock.mockReset();
  patchConfigMock.mockClear();
  readConfigSnapshotMock.mockReset();
  readConfigSnapshotMock.mockResolvedValue({ hash: "hash", config: { plugins: { allow: [] } } });
});

it.each([
  [
    '{"details":{"media":{"mediaUrls":[null," ",false],"attachments":[null,[],false,{},{"path":" /tmp/from-attachment.png "}]}}}',
    "/tmp/from-attachment.png",
  ],
  [undefined, undefined],
  ["done", undefined],
  ["null", undefined],
  [
    '{"details":{"media":{"mediaUrl":false,"path":" ","filePath":0,"mediaUrls":[null,false,""],"attachments":[null,[],{},{"path":false}]}}}',
    undefined,
  ],
])("extracts the media path from %j", (text, expected) => {
  expect(extractMediaPathFromText(text)).toBe(expected);
});

it("resolves generated image paths from mock request logs first", async () => {
  const tempRoot = await makeTempDir("qa-generated-image-request-");
  const mediaPath = await writeImage(tempRoot, "generated.png");
  fetchJsonMock.mockResolvedValue([request("/tmp/other.png", "irrelevant"), request(mediaPath)]);

  await expect(resolveImage(tempRoot)).resolves.toBe(mediaPath);
  expect(fetchJsonMock.mock.calls).toEqual([[expect.any(String), expect.any(Number)]]);
  expect(fetchJsonMock.mock.calls[0]?.[1]).toBeLessThanOrEqual(2_000);
});

it.each(["missing", "stale"] as const)(
  "ignores %s generated media paths returned by matching mock requests",
  async (artifactState) => {
    const tempRoot = await makeTempDir("qa-generated-image-invalid-request-");
    const freshMediaPath = await writeImage(tempRoot, "state/media/outbound/fresh-generated.png");
    const invalidMediaPath = path.join(tempRoot, `invalid-${artifactState}.png`);
    if (artifactState === "stale") {
      await writeImage(tempRoot, `invalid-${artifactState}.png`);
      const staleTimestamp = new Date(Date.now() - 60_000);
      await fs.utimes(invalidMediaPath, staleTimestamp, staleTimestamp);
    }
    fetchJsonMock.mockResolvedValue([request(invalidMediaPath)]);

    await expect(resolveImage(tempRoot)).resolves.toBe(freshMediaPath);
  },
);

it("falls back to generated image files when mock request logs are unavailable", async () => {
  fetchJsonMock.mockRejectedValue(new Error("mock debug unavailable"));
  const tempRoot = await makeTempDir("qa-generated-image-");
  const mediaPath = await writeImage(tempRoot, "state/media/tool-image-generation/generated.png");

  await expect(resolveImage(tempRoot)).resolves.toBe(mediaPath);
});
it("preserves plugins already allowed by the gateway when configuring media", async () => {
  readConfigSnapshotMock.mockResolvedValue({
    hash: "hash",
    config: { plugins: { allow: ["acpx", "openai", "anthropic", "qa-channel"] } },
  });

  await ensureImageGenerationConfigured({
    gateway: { runtimeEnv: {} },
    providerMode: "mock-openai",
    mock: { baseUrl: "http://127.0.0.1:9999" },
    transport: { requiredPluginIds: ["qa-channel"] },
  } as never);

  expect(patchConfigMock).toHaveBeenCalledTimes(1);
  expect(patchConfigMock.mock.calls[0]?.[0].patch.plugins).toStrictEqual(
    expect.objectContaining({
      allow: ["memory-core", "acpx", "openai", "anthropic", "qa-channel"],
    }),
  );
});
