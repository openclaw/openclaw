// Unit tests for the HeyGen video generation provider.
// Pattern mirrored from extensions/runway/video-generation-provider.test.ts.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { expectExplicitVideoGenerationCapabilities } from "../../test/helpers/media-generation/provider-capability-assertions.js";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "../../test/helpers/media-generation/provider-http-mocks.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildHeygenVideoGenerationProvider: typeof import("./video-generation-provider.js").buildHeygenVideoGenerationProvider;

beforeAll(async () => {
  ({ buildHeygenVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

describe("heygen video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildHeygenVideoGenerationProvider());
  });

  it("submits a video-agents job, polls it, and downloads the output", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            session_id: "sess_abc",
            video_id: "vid_xyz",
            status: "generating",
          },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            id: "vid_xyz",
            status: "completed",
            video_url: "https://files.heygen.com/video/vid_xyz.mp4",
            duration: 12.5,
          },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildHeygenVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "heygen",
      model: "avatar_iv",
      prompt: "Ken welcomes new agents to HeyGen.",
      cfg: {},
      aspectRatio: "16:9",
      providerOptions: {
        avatar_id: "avatar_demo_123",
        voice_id: "voice_demo_456",
      },
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.heygen.com/v3/video-agents",
        body: expect.objectContaining({
          prompt: "Ken welcomes new agents to HeyGen.",
          avatar_id: "avatar_demo_123",
          voice_id: "voice_demo_456",
          aspect_ratio: "16:9",
          orientation: "landscape",
        }),
      }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.heygen.com/v3/videos/vid_xyz",
      expect.objectContaining({ method: "GET" }),
      120000,
      fetch,
    );
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual(
      expect.objectContaining({
        videoId: "vid_xyz",
        sessionId: "sess_abc",
        status: "completed",
        videoUrl: "https://files.heygen.com/video/vid_xyz.mp4",
      }),
    );
  });

  it("maps aspect ratios to HeyGen orientations", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        json: async () => ({
          data: { session_id: "s", video_id: "v", status: "generating" },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { id: "v", status: "completed", video_url: "https://example.com/v.mp4" },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("mp4"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildHeygenVideoGenerationProvider();
    await provider.generateVideo({
      provider: "heygen",
      model: "avatar_iv",
      prompt: "portrait phone explainer",
      cfg: {},
      aspectRatio: "9:16",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          aspect_ratio: "9:16",
          orientation: "portrait",
        }),
      }),
    );
  });

  it("accepts a single input image by converting it to a base64 file input", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        json: async () => ({
          data: { session_id: "s2", video_id: "v2", status: "generating" },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { id: "v2", status: "completed", video_url: "https://example.com/v2.mp4" },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("mp4"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildHeygenVideoGenerationProvider();
    await provider.generateVideo({
      provider: "heygen",
      model: "avatar_iv",
      prompt: "use this slide as context",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      aspectRatio: "1:1",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          aspect_ratio: "1:1",
          orientation: "square",
          files: [
            expect.objectContaining({
              type: "base64",
              media_type: "image/png",
              data: expect.stringMatching(/^[A-Za-z0-9+/=]+$/u),
            }),
          ],
        }),
      }),
    );
  });

  it("rejects video inputs (videoToVideo not supported)", async () => {
    const provider = buildHeygenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "avatar_iv",
        prompt: "restyle this clip",
        cfg: {},
        inputVideos: [{ url: "https://example.com/input.mp4" }],
      }),
    ).rejects.toThrow("HeyGen video generation does not support video inputs.");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported aspect ratios", async () => {
    const provider = buildHeygenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "avatar_iv",
        prompt: "ultrawide explainer",
        cfg: {},
        aspectRatio: "21:9",
      }),
    ).rejects.toThrow(/does not support aspect ratio 21:9/u);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("translates 401 responses into an auth error", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        ok: false,
        status: 401,
        text: async () => "unauthorized",
        json: async () => ({}),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildHeygenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "avatar_iv",
        prompt: "anything",
        cfg: {},
      }),
    ).rejects.toThrow("HeyGen API key missing or invalid");
  });

  it("translates 402 responses into a credit-limit error", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        ok: false,
        status: 402,
        text: async () => "payment required",
        json: async () => ({}),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildHeygenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "avatar_iv",
        prompt: "anything",
        cfg: {},
      }),
    ).rejects.toThrow("HeyGen credit limit reached");
  });

  it("surfaces failed status with failure_message", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        json: async () => ({
          data: { session_id: "s", video_id: "vid_fail", status: "generating" },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          id: "vid_fail",
          status: "failed",
          failure_code: "avatar_unavailable",
          failure_message: "Avatar is temporarily unavailable",
        },
      }),
      headers: new Headers(),
    });

    const provider = buildHeygenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "avatar_iv",
        prompt: "anything",
        cfg: {},
      }),
    ).rejects.toThrow("Avatar is temporarily unavailable");
  });
});
