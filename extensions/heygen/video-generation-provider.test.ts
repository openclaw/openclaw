import { beforeAll, describe, expect, it, vi } from "vitest";
import { expectExplicitVideoGenerationCapabilities } from "../../test/helpers/media-generation/provider-capability-assertions.js";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "../../test/helpers/media-generation/provider-http-mocks.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildHeyGenVideoGenerationProvider: typeof import("./video-generation-provider.js").buildHeyGenVideoGenerationProvider;

beforeAll(async () => {
  ({ buildHeyGenVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

function mockCreateSession(
  params: {
    sessionId?: string;
    videoId?: string | null;
    status?: string;
  } = {},
) {
  const videoId = "videoId" in params ? params.videoId : "vid_xyz";
  postJsonRequestMock.mockResolvedValue({
    response: {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          session_id: params.sessionId ?? "sess_abc",
          status: params.status ?? "generating",
          video_id: videoId,
          created_at: 1_700_000_000,
        },
      }),
    },
    release: vi.fn(async () => {}),
  });
}

function mockVideoCompleted(params: { videoId?: string; videoUrl?: string } = {}) {
  const videoId = params.videoId ?? "vid_xyz";
  const videoUrl = params.videoUrl ?? "https://files.heygen.ai/v/vid_xyz.mp4";
  fetchWithTimeoutMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          id: videoId,
          status: "completed",
          video_url: videoUrl,
          thumbnail_url: "https://files.heygen.ai/t/vid_xyz.jpg",
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
  return { videoId, videoUrl };
}

describe("heygen video agent provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildHeyGenVideoGenerationProvider());
  });

  it("creates a video-agents session, polls the video, and downloads the output", async () => {
    mockCreateSession();
    const { videoId, videoUrl } = mockVideoCompleted();

    const provider = buildHeyGenVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "heygen",
      model: "video_agent_v3",
      prompt: "Welcome new agents to HeyGen.",
      cfg: {},
      aspectRatio: "16:9",
      providerOptions: {
        avatar_id: "avatar_demo_1",
        voice_id: "voice_demo_1",
      },
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.heygen.com/v3/video-agents",
        body: expect.objectContaining({
          prompt: "Welcome new agents to HeyGen.",
          avatar_id: "avatar_demo_1",
          voice_id: "voice_demo_1",
          orientation: "landscape",
        }),
      }),
    );
    const body = postJsonRequestMock.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(body.body).not.toHaveProperty("aspect_ratio");
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      `https://api.heygen.com/v3/videos/${videoId}`,
      expect.objectContaining({ method: "GET" }),
      120000,
      fetch,
    );
    expect(result.videos).toHaveLength(1);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        sessionId: "sess_abc",
        videoId,
        videoUrl,
        videoStatus: "completed",
      }),
    );
  });

  it("always sends mode: 'generate' unless caller explicitly asks for 'chat'", async () => {
    mockCreateSession();
    mockVideoCompleted();
    const provider = buildHeyGenVideoGenerationProvider();
    await provider.generateVideo({
      provider: "heygen",
      model: "video_agent_v3",
      prompt: "one-shot",
      cfg: {},
      aspectRatio: "16:9",
      providerOptions: { avatar_id: "a", voice_id: "v" },
    });
    const body = postJsonRequestMock.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(body.body).toMatchObject({ mode: "generate" });

    postJsonRequestMock.mockClear();
    fetchWithTimeoutMock.mockClear();
    mockCreateSession();
    mockVideoCompleted();
    await provider.generateVideo({
      provider: "heygen",
      model: "video_agent_v3",
      prompt: "chat",
      cfg: {},
      aspectRatio: "16:9",
      providerOptions: { avatar_id: "a", voice_id: "v", mode: "chat" },
    });
    const chatBody = postJsonRequestMock.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(chatBody.body).toMatchObject({ mode: "chat" });
  });

  it("maps 16:9 and 9:16 aspect ratios to landscape and portrait orientations", async () => {
    const provider = buildHeyGenVideoGenerationProvider();
    const providerOptions = { avatar_id: "a1", voice_id: "v1" };

    mockCreateSession({ videoId: "vid_landscape" });
    mockVideoCompleted({ videoId: "vid_landscape" });
    await provider.generateVideo({
      provider: "heygen",
      model: "video_agent_v3",
      prompt: "hello",
      aspectRatio: "16:9",
      cfg: {},
      providerOptions,
    });
    const landscape = postJsonRequestMock.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(landscape.body).toMatchObject({ orientation: "landscape" });

    postJsonRequestMock.mockClear();
    fetchWithTimeoutMock.mockClear();
    mockCreateSession({ videoId: "vid_portrait" });
    mockVideoCompleted({ videoId: "vid_portrait" });
    await provider.generateVideo({
      provider: "heygen",
      model: "video_agent_v3",
      prompt: "hello",
      aspectRatio: "9:16",
      cfg: {},
      providerOptions,
    });
    const portrait = postJsonRequestMock.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(portrait.body).toMatchObject({ orientation: "portrait" });
  });

  it("rejects 1:1 aspect ratio (HeyGen Video Agent only supports landscape/portrait)", async () => {
    const provider = buildHeyGenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "video_agent_v3",
        prompt: "hello",
        cfg: {},
        aspectRatio: "1:1",
        providerOptions: { avatar_id: "a1", voice_id: "v1" },
      }),
    ).rejects.toThrow(/does not support aspect ratio 1:1/u);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("converts local image buffers into AssetBase64 file attachments", async () => {
    mockCreateSession();
    mockVideoCompleted();

    const provider = buildHeyGenVideoGenerationProvider();
    await provider.generateVideo({
      provider: "heygen",
      model: "video_agent_v3",
      prompt: "Use this slide as scene context.",
      cfg: {},
      aspectRatio: "9:16",
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      providerOptions: {
        voice_id: "voice_demo_1",
      },
    });

    const request = postJsonRequestMock.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(request.body).toMatchObject({
      files: [
        {
          type: "base64",
          media_type: "image/png",
          data: expect.stringMatching(/^[A-Za-z0-9+/=]+$/u),
        },
      ],
    });
  });

  it("rejects video reference inputs (HeyGen Video Agent has no video-to-video mode)", async () => {
    const provider = buildHeyGenVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "video_agent_v3",
        prompt: "restyle this clip",
        cfg: {},
        inputVideos: [{ url: "https://example.com/in.mp4" }],
        providerOptions: { avatar_id: "a1", voice_id: "v1" },
      }),
    ).rejects.toThrow("HeyGen video generation does not support video reference inputs.");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported aspect ratios", async () => {
    const provider = buildHeyGenVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "video_agent_v3",
        prompt: "hello",
        cfg: {},
        aspectRatio: "21:9",
        providerOptions: { avatar_id: "a1", voice_id: "v1" },
      }),
    ).rejects.toThrow(/does not support aspect ratio 21:9/u);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("falls back to cfg.plugins.entries.heygen.config defaults when providerOptions omit avatar/voice/style", async () => {
    mockCreateSession();
    mockVideoCompleted();

    const provider = buildHeyGenVideoGenerationProvider();
    await provider.generateVideo({
      provider: "heygen",
      model: "video_agent_v3",
      prompt: "hello",
      aspectRatio: "16:9",
      cfg: {
        plugins: {
          entries: {
            heygen: {
              config: {
                defaultAvatarId: "cfg_avatar",
                defaultVoiceId: "cfg_voice",
                defaultStyleId: "cfg_style",
              },
            } as never,
          },
        },
      },
      providerOptions: {},
    });

    const body = postJsonRequestMock.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(body.body).toMatchObject({
      avatar_id: "cfg_avatar",
      voice_id: "cfg_voice",
      style_id: "cfg_style",
    });
  });

  it("prefers providerOptions over cfg defaults when both are set", async () => {
    mockCreateSession();
    mockVideoCompleted();

    const provider = buildHeyGenVideoGenerationProvider();
    await provider.generateVideo({
      provider: "heygen",
      model: "video_agent_v3",
      prompt: "hello",
      aspectRatio: "16:9",
      cfg: {
        plugins: {
          entries: {
            heygen: {
              config: {
                defaultAvatarId: "cfg_avatar",
                defaultVoiceId: "cfg_voice",
              },
            } as never,
          },
        },
      },
      providerOptions: { avatar_id: "req_avatar", voice_id: "req_voice" },
    });

    const body = postJsonRequestMock.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(body.body).toMatchObject({
      avatar_id: "req_avatar",
      voice_id: "req_voice",
    });
  });

  it("translates 401 create responses into an authentication error", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        ok: false,
        status: 401,
        text: async () => "unauthorized",
        json: async () => ({}),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildHeyGenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "video_agent_v3",
        prompt: "hello",
        cfg: {},
        aspectRatio: "16:9",
        providerOptions: { avatar_id: "a1", voice_id: "v1" },
      }),
    ).rejects.toThrow("HeyGen API key missing or invalid");
  });

  it("translates 402 create responses into a credit limit error", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        ok: false,
        status: 402,
        text: async () => "payment required",
        json: async () => ({}),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildHeyGenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "video_agent_v3",
        prompt: "hello",
        cfg: {},
        aspectRatio: "16:9",
        providerOptions: { avatar_id: "a1", voice_id: "v1" },
      }),
    ).rejects.toThrow("HeyGen credit limit reached");
  });

  it("polls the session endpoint when video_id is null on create", async () => {
    mockCreateSession({ videoId: null, status: "thinking" });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            session_id: "sess_abc",
            status: "generating",
            video_id: "vid_late",
            progress: 30,
            created_at: 1_700_000_000,
          },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            id: "vid_late",
            status: "completed",
            video_url: "https://files.heygen.ai/v/vid_late.mp4",
            duration: 8,
          },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("mp4"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildHeyGenVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "heygen",
      model: "video_agent_v3",
      prompt: "hello",
      cfg: {},
      aspectRatio: "16:9",
      providerOptions: { avatar_id: "a1", voice_id: "v1" },
    });

    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.heygen.com/v3/video-agents/sess_abc",
      expect.objectContaining({ method: "GET" }),
      120000,
      fetch,
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      2,
      "https://api.heygen.com/v3/videos/vid_late",
      expect.objectContaining({ method: "GET" }),
      120000,
      fetch,
    );
    expect(result.metadata).toMatchObject({ videoId: "vid_late" });
  });

  it("fast-fails in generate mode when session stays in 'thinking' past the threshold", async () => {
    mockCreateSession({ videoId: null, status: "thinking" });
    const thinkingPayload = {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          session_id: "sess_stuck",
          status: "thinking",
          video_id: null,
          created_at: 1_700_000_000,
        },
      }),
      headers: new Headers(),
    };
    for (let i = 0; i < 10; i += 1) {
      fetchWithTimeoutMock.mockResolvedValueOnce(thinkingPayload);
    }

    const provider = buildHeyGenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "video_agent_v3",
        prompt: "hello",
        cfg: {},
        aspectRatio: "16:9",
        providerOptions: { avatar_id: "a1", voice_id: "v1" },
      }),
    ).rejects.toThrow(/stuck in 'thinking' after \d+ polls in generate mode/u);
    expect(fetchWithTimeoutMock.mock.calls.length).toBeLessThanOrEqual(9);
  });

  it("does not fast-fail in chat mode even if session stays in 'thinking'", async () => {
    mockCreateSession({ videoId: null, status: "thinking" });
    // Chat mode: after 8 thinking polls, still must not fast-fail; return video_id on the 9th poll.
    const thinkingPayload = {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          session_id: "sess_chat",
          status: "thinking",
          video_id: null,
          created_at: 1_700_000_000,
        },
      }),
      headers: new Headers(),
    };
    for (let i = 0; i < 10; i += 1) {
      fetchWithTimeoutMock.mockResolvedValueOnce(thinkingPayload);
    }
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            session_id: "sess_chat",
            status: "generating",
            video_id: "vid_chat_late",
            created_at: 1_700_000_000,
          },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            id: "vid_chat_late",
            status: "completed",
            video_url: "https://files.heygen.ai/v/vid_chat_late.mp4",
          },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("mp4"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildHeyGenVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "heygen",
      model: "video_agent_v3",
      prompt: "hello",
      cfg: {},
      aspectRatio: "16:9",
      providerOptions: { avatar_id: "a1", voice_id: "v1", mode: "chat" },
    });
    expect(result.metadata).toMatchObject({ videoId: "vid_chat_late" });
  });

  it("rejects when the session poll returns waiting_for_input (chat mode)", async () => {
    mockCreateSession({ videoId: null, status: "thinking" });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          session_id: "sess_chat",
          status: "waiting_for_input",
          video_id: null,
          created_at: 1_700_000_000,
        },
      }),
      headers: new Headers(),
    });

    const provider = buildHeyGenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "video_agent_v3",
        prompt: "hello",
        cfg: {},
        aspectRatio: "16:9",
        providerOptions: { avatar_id: "a1", voice_id: "v1" },
      }),
    ).rejects.toThrow(/waiting for input/u);
  });

  it("sends User-Agent and X-HeyGen-Source attribution headers on the create call", async () => {
    mockCreateSession();
    mockVideoCompleted();

    const provider = buildHeyGenVideoGenerationProvider();
    await provider.generateVideo({
      provider: "heygen",
      model: "video_agent_v3",
      prompt: "hello",
      cfg: {},
      aspectRatio: "16:9",
      providerOptions: { avatar_id: "a1", voice_id: "v1" },
    });

    const createCall = postJsonRequestMock.mock.calls[0]?.[0] as {
      headers: Headers;
    };
    expect(createCall.headers.get("user-agent")).toMatch(/^OpenClaw-HeyGen-Provider\//u);
    expect(createCall.headers.get("x-heygen-source")).toBe("openclaw-plugin");
  });

  it("surfaces failure_message when the video poll returns a failed status", async () => {
    mockCreateSession({ videoId: "vid_fail" });
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

    const provider = buildHeyGenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "video_agent_v3",
        prompt: "hello",
        cfg: {},
        aspectRatio: "16:9",
        providerOptions: { avatar_id: "a1", voice_id: "v1" },
      }),
    ).rejects.toThrow("Avatar is temporarily unavailable");
  });

  it("routes session poll, video poll, and download through the guarded transport", async () => {
    const { fetchWithTimeoutGuardedMock, resolveProviderHttpRequestConfigMock } =
      getProviderHttpMocks();
    resolveProviderHttpRequestConfigMock.mockReturnValueOnce({
      baseUrl: "https://api.heygen.com",
      allowPrivateNetwork: true,
      headers: new Headers({ "X-Api-Key": "test-key" }),
      dispatcherPolicy: { kind: "trust-env-proxy" } as never,
    });
    mockCreateSession({ videoId: null, status: "thinking" });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            session_id: "sess_abc",
            status: "generating",
            video_id: "vid_guarded",
            created_at: 1_700_000_000,
          },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            id: "vid_guarded",
            status: "completed",
            video_url: "https://files.heygen.ai/v/vid_guarded.mp4",
          },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("mp4"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildHeyGenVideoGenerationProvider();
    await provider.generateVideo({
      provider: "heygen",
      model: "video_agent_v3",
      prompt: "hello",
      cfg: {},
      aspectRatio: "16:9",
      providerOptions: { avatar_id: "a1", voice_id: "v1" },
    });

    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledTimes(3);
    for (const call of fetchWithTimeoutGuardedMock.mock.calls) {
      const opts = call[4] as
        | {
            ssrfPolicy?: { allowPrivateNetwork?: boolean };
            dispatcherPolicy?: { kind?: string };
            auditContext?: string;
          }
        | undefined;
      expect(opts?.ssrfPolicy?.allowPrivateNetwork).toBe(true);
      expect(opts?.dispatcherPolicy).toEqual({ kind: "trust-env-proxy" });
      expect(opts?.auditContext).toMatch(/^heygen-/u);
    }
  });

  it("does not classify a 400 'insufficient parameters' error as a credit limit", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        ok: false,
        status: 400,
        text: async () => "insufficient parameters: avatar_id is required",
        json: async () => ({}),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildHeyGenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "video_agent_v3",
        prompt: "hello",
        cfg: {},
        aspectRatio: "16:9",
        providerOptions: { avatar_id: "a1", voice_id: "v1" },
      }),
    ).rejects.toThrow(/status 400/u);
  });

  it("fails fast when session poll returns HTTP 200 with a top-level error envelope", async () => {
    mockCreateSession({ videoId: null, status: "generating" });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        error: { code: "session_expired", message: "session has expired" },
      }),
      headers: new Headers(),
    });

    const provider = buildHeyGenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "video_agent_v3",
        prompt: "hello",
        cfg: {},
        aspectRatio: "16:9",
        providerOptions: { avatar_id: "a1", voice_id: "v1" },
      }),
    ).rejects.toThrow(/session has expired/u);
    expect(fetchWithTimeoutMock.mock.calls.length).toBe(1);
  });

  it("fails fast when video poll returns HTTP 200 with a top-level error envelope", async () => {
    mockCreateSession();
    fetchWithTimeoutMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        error: { code: "video_not_found", message: "video id invalid" },
      }),
      headers: new Headers(),
    });

    const provider = buildHeyGenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "video_agent_v3",
        prompt: "hello",
        cfg: {},
        aspectRatio: "16:9",
        providerOptions: { avatar_id: "a1", voice_id: "v1" },
      }),
    ).rejects.toThrow(/video id invalid/u);
    expect(fetchWithTimeoutMock.mock.calls.length).toBe(1);
  });

  it("fails fast when poll returns an error envelope with a code but no message", async () => {
    mockCreateSession({ videoId: null, status: "generating" });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ error: { code: "session_expired" } }),
      headers: new Headers(),
    });

    const provider = buildHeyGenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "video_agent_v3",
        prompt: "hello",
        cfg: {},
        aspectRatio: "16:9",
        providerOptions: { avatar_id: "a1", voice_id: "v1" },
      }),
    ).rejects.toThrow(/HeyGen returned error code session_expired/u);
    expect(fetchWithTimeoutMock.mock.calls.length).toBe(1);
  });

  it("fails fast when poll returns an empty error envelope with no code or message", async () => {
    mockCreateSession({ videoId: null, status: "generating" });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ error: {} }),
      headers: new Headers(),
    });

    const provider = buildHeyGenVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "heygen",
        model: "video_agent_v3",
        prompt: "hello",
        cfg: {},
        aspectRatio: "16:9",
        providerOptions: { avatar_id: "a1", voice_id: "v1" },
      }),
    ).rejects.toThrow(/HeyGen returned an error envelope without a message/u);
    expect(fetchWithTimeoutMock.mock.calls.length).toBe(1);
  });
});
