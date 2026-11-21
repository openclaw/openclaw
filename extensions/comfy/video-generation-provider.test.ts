import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, expect, it, vi } from "vitest";
import {
  buildComfyConfig,
  fetchGuardJson,
  fetchGuardResponse,
  registerComfyProviders,
} from "./test-helpers.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const comfyProviders = registerComfyProviders();

const videoOutput = (filename = "generated.mp4") => ({ filename, subfolder: "", type: "output" });

function generateLocalVideo(
  outputs: Record<string, unknown>,
  download: ReturnType<typeof fetchGuardResponse>,
) {
  fetchWithSsrFGuardMock
    .mockResolvedValueOnce(fetchGuardJson({ prompt_id: "local-video" }))
    .mockResolvedValueOnce(fetchGuardJson({ "local-video": { outputs } }))
    .mockResolvedValueOnce(download);
  return comfyProviders.video.generateVideo({
    provider: "comfy",
    model: "workflow",
    prompt: "animate a lobster",
    cfg: buildComfyConfig({
      video: {
        workflow: { "6": { inputs: { text: "" } }, "9": { inputs: {} } },
        promptNodeId: "6",
      },
    }),
  });
}

beforeEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

it("declares explicit mode capabilities", () => {
  expectExplicitVideoGenerationCapabilities(comfyProviders.video);
});

it.each([
  ["filename", "generated.mp4", "video/mp4"],
  ["name", "generated.WEBM", "video/webm"],
])("returns %s=%s video entries from mixed images buckets", async (key, fileName, mimeType) => {
  const result = await generateLocalVideo(
    { "2": { images: [videoOutput("generated.png")] }, "4": { images: [{ [key]: fileName }] } },
    fetchGuardResponse("video-data", mimeType),
  );

  expect(result.videos).toEqual([
    expect.objectContaining({
      buffer: Buffer.from("video-data"),
      mimeType,
      fileName,
      metadata: { nodeId: "4", promptId: "local-video" },
    }),
  ]);
  expect(result.metadata?.outputNodeIds).toEqual(["4"]);
  expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(3);
});

it.each([
  ["text/html; charset=utf-8", "<html>sign in</html>"],
  ["video/mp4", ""],
])("rejects malformed video output (%s)", async (contentType, body) => {
  await expect(
    generateLocalVideo({ "9": { gifs: [videoOutput()] } }, fetchGuardResponse(body, contentType)),
  ).rejects.toThrow("Comfy video output download: malformed video response");
});

it("releases a rejected video output download without draining its body", async () => {
  const streamed = oversizedJsonResponse({ chunkCount: 32, chunkSize: 1024 * 1024 });
  const release = vi.fn(async () => {});
  await expect(
    generateLocalVideo(
      { "9": { gifs: [videoOutput()] } },
      { response: streamed.response, release },
    ),
  ).rejects.toThrow("Comfy video output download: malformed video response");

  expect(streamed.wasCanceled()).toBe(true);
  // Draining this stream would surface the byte-cap error instead.
  expect(streamed.getReadCount()).toBeLessThanOrEqual(1);
  expect(release).toHaveBeenCalledOnce();
});
