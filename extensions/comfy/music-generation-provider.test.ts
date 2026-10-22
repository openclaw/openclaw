import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildComfyConfig, fetchGuardJson, registerComfyProviders } from "./test-helpers.js";

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

  it("runs a music workflow and returns audio outputs", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(fetchGuardJson({ prompt_id: "music-job-1" }))
      .mockResolvedValueOnce(
        fetchGuardJson({
          "music-job-1": {
            outputs: { "9": { audio: [{ filename: "song.mp3", subfolder: "", type: "output" }] } },
          },
        }),
      )
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("music-bytes"), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
        release: vi.fn(async () => {}),
      });

    const result = await comfyProviders.music.generateMusic(request);

    expect(result).toEqual({
      model: "workflow",
      tracks: [
        {
          buffer: Buffer.from("music-bytes"),
          mimeType: "audio/mpeg",
          fileName: "song.mp3",
        },
      ],
      metadata: { promptId: "music-job-1", outputNodeIds: ["9"], inputImageCount: 0 },
    });
  });

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
