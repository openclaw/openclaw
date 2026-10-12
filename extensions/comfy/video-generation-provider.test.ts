import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildComfyConfig, fetchGuardJson } from "./test-helpers.js";
import { buildComfyVideoGenerationProvider } from "./video-generation-provider.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

function fetchGuardParams(call: number): { url?: unknown; auditContext?: unknown } {
  const params = fetchWithSsrFGuardMock.mock.calls[call]?.[0];
  if (!params || typeof params !== "object") {
    throw new Error(`expected Comfy fetch guard call ${call}`);
  }
  return params as { url?: unknown; auditContext?: unknown };
}

function mockLocalVideoResponses(params: {
  promptId: string;
  outputs: Record<string, unknown>;
  download?: {
    body: string;
    contentType: string;
  };
}) {
  fetchWithSsrFGuardMock
    .mockResolvedValueOnce(fetchGuardJson({ prompt_id: params.promptId }))
    .mockResolvedValueOnce(
      fetchGuardJson({
        [params.promptId]: {
          outputs: params.outputs,
        },
      }),
    );

  if (params.download) {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(Buffer.from(params.download.body), {
        status: 200,
        headers: { "content-type": params.download.contentType },
      }),
      release: vi.fn(async () => {}),
    });
  }
}

function generateLocalVideo(outputNodeId?: string) {
  const provider = buildComfyVideoGenerationProvider();
  return provider.generateVideo({
    provider: "comfy",
    model: "workflow",
    prompt: "animate a lobster",
    cfg: buildComfyConfig({
      video: {
        workflow: {
          "6": { inputs: { text: "" } },
          "9": { inputs: {} },
        },
        promptNodeId: "6",
        ...(outputNodeId ? { outputNodeId } : {}),
      },
    }),
  });
}

describe("comfy video-generation provider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildComfyVideoGenerationProvider());
  });

  it("returns only MP4 video entries from mixed images buckets", async () => {
    mockLocalVideoResponses({
      promptId: "local-video-mixed",
      outputs: {
        "2": {
          images: [{ filename: "generated.png", subfolder: "", type: "output" }],
        },
        "4": {
          images: [{ filename: "generated.mp4", subfolder: "", type: "output" }],
        },
      },
      download: {
        body: "mp4-data",
        contentType: "video/mp4",
      },
    });

    const result = await generateLocalVideo();

    expect(fetchGuardParams(2).url).toBe(
      "http://127.0.0.1:8188/view?filename=generated.mp4&subfolder=&type=output",
    );
    expect(result.videos).toEqual([
      expect.objectContaining({
        buffer: Buffer.from("mp4-data"),
        mimeType: "video/mp4",
        fileName: "generated.mp4",
        metadata: {
          nodeId: "4",
          promptId: "local-video-mixed",
        },
      }),
    ]);
    expect(result.metadata?.outputNodeIds).toEqual(["4"]);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(3);
  });

  it("accepts uppercase WEBM names from the images bucket", async () => {
    mockLocalVideoResponses({
      promptId: "local-video-webm",
      outputs: {
        "9": {
          images: [{ name: "generated.WEBM", subfolder: "", type: "output" }],
        },
      },
      download: {
        body: "webm-data",
        contentType: "video/webm",
      },
    });

    const result = await generateLocalVideo();

    expect(fetchGuardParams(2).url).toBe(
      "http://127.0.0.1:8188/view?filename=generated.WEBM&subfolder=&type=output",
    );
    expect(result.videos[0]).toEqual(
      expect.objectContaining({
        buffer: Buffer.from("webm-data"),
        mimeType: "video/webm",
        fileName: "generated.WEBM",
      }),
    );
  });

  it.each([
    { name: "HTML", contentType: "text/html; charset=utf-8", body: "<html>sign in</html>" },
    { name: "empty video", contentType: "video/mp4", body: "" },
  ])(
    "rejects a successful $name output download as generated video",
    async ({ contentType, body }) => {
      mockLocalVideoResponses({
        promptId: "local-video-invalid-download",
        outputs: {
          "9": {
            gifs: [{ filename: "generated.mp4", subfolder: "", type: "output" }],
          },
        },
        download: { body, contentType },
      });

      await expect(generateLocalVideo()).rejects.toThrow(
        "Comfy video output download: malformed video response",
      );
    },
  );

  it("releases a rejected video output download without draining its body", async () => {
    let canceled = false;
    let bytesPulled = 0;
    const neverEndingJson = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          bytesPulled += 1;
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const release = vi.fn(async () => {});
    mockLocalVideoResponses({
      promptId: "local-video-tee",
      outputs: {
        "9": {
          gifs: [{ filename: "generated.mp4", subfolder: "", type: "output" }],
        },
      },
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({ response: neverEndingJson, release });

    await expect(generateLocalVideo()).rejects.toThrow(
      "Comfy video output download: malformed video response",
    );

    expect(canceled).toBe(true);
    // The stream never ends, so draining it would have surfaced the byte-cap error instead.
    expect(bytesPulled).toBeLessThanOrEqual(1);
    expect(release).toHaveBeenCalledOnce();
  });
});
