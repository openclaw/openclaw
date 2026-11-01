import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const request = {
  provider: "comfy",
  model: "workflow",
  prompt: "gentle ambient synth loop",
  cfg: buildComfyConfig({
    music: {
      workflow: { "6": { inputs: { text: "" } }, "9": { inputs: {} } },
      promptNodeId: "6",
      outputNodeId: "9",
    },
  }),
};

describe("comfy music-generation provider", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.clearAllMocks();
  });

  it("registers the workflow model", () => {
    expect(comfyProviders.music.defaultModel).toBe("workflow");
    expect(comfyProviders.music.models).toEqual(["workflow"]);
    expectExplicitMusicGenerationCapabilities(comfyProviders.music);
  });

  it.each([
    "audio/mpeg",
    "application/ogg",
    "application/octet-stream",
    "binary/octet-stream",
    null,
  ])("runs a music workflow and returns audio outputs (%s)", async (contentType) => {
    const download = fetchGuardResponse(
      Buffer.from("music-bytes"),
      contentType ?? "application/octet-stream",
    );
    if (contentType === null) {
      download.response.headers.delete("content-type");
    }
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(fetchGuardJson({ prompt_id: "music-job-1" }))
      .mockResolvedValueOnce(
        fetchGuardJson({
          "music-job-1": {
            outputs: { "9": { audio: [{ filename: "song.mp3", subfolder: "", type: "output" }] } },
          },
        }),
      )
      .mockResolvedValueOnce(download);

    const result = await comfyProviders.music.generateMusic(request);

    expect(result).toEqual({
      model: "workflow",
      tracks: [
        {
          buffer: Buffer.from("music-bytes"),
          mimeType: contentType ?? "application/octet-stream",
          fileName: "song.mp3",
        },
      ],
      metadata: { promptId: "music-job-1", outputNodeIds: ["9"], inputImageCount: 0 },
    });
  });

  it.each(["image/png", "video/mp4"])(
    "rejects non-audio music output before consuming it (%s)",
    async (contentType) => {
      const cancel = vi.fn();
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
        controller.close(),
      );
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("not-audio"));
          },
          pull,
          cancel,
        }),
        { headers: { "content-type": contentType } },
      );
      const release = vi.fn(async () => {});
      fetchWithSsrFGuardMock
        .mockResolvedValueOnce(fetchGuardJson({ prompt_id: "music-wrong-content" }))
        .mockResolvedValueOnce(
          fetchGuardJson({
            "music-wrong-content": {
              outputs: { "9": { audio: [{ filename: "song.mp3" }] } },
            },
          }),
        )
        .mockResolvedValueOnce({ response, release });

      await expect(comfyProviders.music.generateMusic(request)).rejects.toThrow(
        "Comfy music output download: malformed audio response",
      );
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("honors req.timeoutMs for the music workflow poll deadline", async () => {
    // Regression: music ignored timeoutMs and waited the five-minute default.
    fetchWithSsrFGuardMock.mockImplementation(async (params: { url?: string }) =>
      fetchGuardJson(params.url?.includes("/prompt") ? { prompt_id: "music-job-slow" } : {}),
    );

    await expect(
      comfyProviders.music.generateMusic({ ...request, timeoutMs: 1000 }),
    ).rejects.toThrow("Comfy workflow did not finish within 1s");
  });
});
