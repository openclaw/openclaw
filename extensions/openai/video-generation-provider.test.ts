// Openai tests cover video generation provider plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  fetchWithTimeoutMock,
  resolveProviderHttpRequestConfigMock,
} = getProviderHttpMocks();

let buildOpenAIVideoGenerationProvider: typeof import("./video-generation-provider.js").buildOpenAIVideoGenerationProvider;

beforeAll(async () => {
  ({ buildOpenAIVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

function postJsonRequest(index = 0): Record<string, unknown> {
  const request = postJsonRequestMock.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!request) {
    throw new Error(`expected postJsonRequest call ${index}`);
  }
  return request;
}

function postMultipartRequest(index = 0): Record<string, unknown> {
  const request = postMultipartRequestMock.mock.calls[index]?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!request) {
    throw new Error(`expected postMultipartRequest call ${index}`);
  }
  return request;
}

function fetchWithTimeoutCall(index: number): [string, RequestInit | undefined, number, unknown] {
  const call = fetchWithTimeoutMock.mock.calls[index] as
    | [string, RequestInit | undefined, number, unknown]
    | undefined;
  if (!call) {
    throw new Error(`expected fetchWithTimeout call ${index}`);
  }
  return call;
}

function providerHttpConfigRequest(): Record<string, unknown> {
  const [call] = resolveProviderHttpRequestConfigMock.mock.calls;
  if (!call) {
    throw new Error("expected provider HTTP config request");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected provider HTTP config request");
  }
  return request as Record<string, unknown>;
}

function streamedVideoResponse(bytes: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bytes));
        controller.close();
      },
    }),
    { headers: { "content-type": "video/mp4" } },
  );
}

describe("openai video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildOpenAIVideoGenerationProvider());
  });

  it("does not claim size or duration controls for OpenAI video edits", () => {
    const provider = buildOpenAIVideoGenerationProvider();

    expect(provider.capabilities.videoToVideo).toEqual({
      enabled: true,
      maxVideos: 1,
      maxInputVideos: 1,
    });
  });

  it("does not advertise video generation for OAuth-only OpenAI profiles", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-openai-video-auth-"));
    const previousOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            "openai:chatgpt": {
              type: "oauth",
              provider: "openai",
              access: "chatgpt-oauth-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        }),
      );

      expect(buildOpenAIVideoGenerationProvider().isConfigured?.({ agentDir })).toBe(false);
    } finally {
      if (previousOpenAIKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAIKey;
      }
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("requires an OpenAI API key credential for direct video generation", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "chatgpt-oauth-token",
      mode: "oauth",
    } as never);

    const provider = buildOpenAIVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "openai",
        model: "sora-2",
        prompt: "A paper airplane gliding through golden hour light",
        cfg: {},
      }),
    ).rejects.toThrow("OpenAI API key missing");

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelApi: "openai-responses",
      }),
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("uses JSON for text-only Sora requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "vid_123",
          model: "sora-2",
          status: "queued",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_123",
          model: "sora-2",
          status: "completed",
          seconds: "4",
          size: "720x1280",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/webm" }),
        arrayBuffer: async () => Buffer.from("webm-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "A paper airplane gliding through golden hour light",
      cfg: {},
      durationSeconds: 4,
    });

    expect(postJsonRequest().url).toBe("https://api.openai.com/v1/videos");
    const [pollUrl, pollInit, pollTimeout, pollFetch] = fetchWithTimeoutCall(0);
    expect(pollUrl).toBe("https://api.openai.com/v1/videos/vid_123");
    expect(pollInit?.method).toBe("GET");
    expect(pollTimeout).toBe(120000);
    expect(pollFetch).toBe(fetch);
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/webm");
    expect(result.videos[0]?.fileName).toBe("video-1.webm");
    expect(result.metadata?.videoId).toBe("vid_123");
    expect(result.metadata?.status).toBe("completed");
  });

  it("rejects generated video downloads that exceed the configured media cap", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "vid_too_large",
          model: "sora-2",
          status: "queued",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_too_large",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce(streamedVideoResponse("too-large"));

    const provider = buildOpenAIVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "openai",
        model: "sora-2",
        prompt: "short video",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("OpenAI generated video download exceeds 1 bytes");
  });

  it("uses JSON input_reference.image_url for image-to-video requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "vid_456",
          model: "sora-2",
          status: "queued",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_456",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "Animate this frame",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
    });

    const createRequest = postJsonRequest();
    expect(createRequest.url).toBe("https://api.openai.com/v1/videos");
    expect((createRequest.body as Record<string, unknown>).input_reference).toEqual({
      image_url: "data:image/png;base64,cG5nLWJ5dGVz",
    });
    const [pollUrl, pollInit, pollTimeout, pollFetch] = fetchWithTimeoutCall(0);
    expect(pollUrl).toBe("https://api.openai.com/v1/videos/vid_456");
    expect(pollInit?.method).toBe("GET");
    expect(pollTimeout).toBe(120000);
    expect(pollFetch).toBe(fetch);
  });

  it("keeps configured local baseUrl private-network blocked unless explicitly enabled", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "vid_local",
          model: "sora-2",
          status: "queued",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_local",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "Render via local relay",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(providerHttpConfigRequest().baseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(providerHttpConfigRequest().request).toBeUndefined();
    const createRequest = postJsonRequest();
    expect(createRequest.url).toBe("http://127.0.0.1:44080/v1/videos");
  });

  it("uses the video edits endpoint for video-to-video uploads", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "vid_789",
          model: "sora-2",
          status: "queued",
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_789",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "Remix this clip",
      cfg: {},
      inputVideos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
    });

    expect(postJsonRequestMock).not.toHaveBeenCalled();
    const createRequest = postMultipartRequest();
    expect(createRequest.url).toBe("https://api.openai.com/v1/videos/edits");
    expect(createRequest.body).toBeInstanceOf(FormData);
    const form = createRequest.body as FormData;
    expect(form.get("prompt")).toBe("Remix this clip");
    expect(form.get("model")).toBe("sora-2");
    expect(form.get("video")).toBeInstanceOf(File);
    expect(form.get("input_reference")).toBeNull();
    expect(createRequest.timeoutMs).toBe(120000);
    expect(createRequest.fetchFn).toBe(fetch);
  });

  it("rejects multiple reference assets", async () => {
    const provider = buildOpenAIVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "openai",
        model: "sora-2",
        prompt: "Animate these",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("a"), mimeType: "image/png" }],
        inputVideos: [{ buffer: Buffer.from("b"), mimeType: "video/mp4" }],
      }),
    ).rejects.toThrow("OpenAI video generation supports at most one reference image or video.");
  });
});
