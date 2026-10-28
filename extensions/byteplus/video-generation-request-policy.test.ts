import { createServer } from "node:http";
import type {
  pollProviderOperationJson,
  postJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { afterEach, assert, expect, it, vi } from "vitest";
import {
  createModelProviderConfig,
  createProxyRequestModelProviderConfig,
} from "../test-support/model-provider-config.test-support.js";
import { buildBytePlusVideoGenerationProvider } from "./video-generation-provider.js";

const { postMock, pollMock } = vi.hoisted(() => ({
  postMock: vi.fn<typeof postJsonResponse>(),
  pollMock: vi.fn<typeof pollProviderOperationJson>(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "synthetic-provider-key" }),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  postJsonResponse: postMock,
  pollProviderOperationJson: pollMock,
}));

afterEach(() => vi.restoreAllMocks());

function generateVideo(cfg: VideoGenerationRequest["cfg"] = {}) {
  postMock.mockResolvedValue({ id: "synthetic-task" });
  return buildBytePlusVideoGenerationProvider().generateVideo({
    provider: "byteplus",
    model: "seedance-1-0-pro-250528",
    prompt: "a synthetic lobster",
    cfg,
  });
}

function completeTask(url: string) {
  pollMock.mockResolvedValue({ status: "succeeded", content: { video_url: url } });
}

it("preserves configured task headers and proxy through submission and polling", async () => {
  const intercepted = new Error("synthetic polling intercepted");
  pollMock.mockRejectedValue(intercepted);

  await expect(generateVideo(createProxyRequestModelProviderConfig("byteplus"))).rejects.toBe(
    intercepted,
  );

  expect(postMock).toHaveBeenCalledOnce();
  expect(pollMock).toHaveBeenCalledOnce();
  const submitted = postMock.mock.calls[0]?.[0];
  const polled = pollMock.mock.calls[0]?.[0];
  assert(submitted);
  assert(polled);
  expect(submitted.url).toBe("https://relay.example.test/contents/generations/tasks");
  expect(polled.url).toBe("https://relay.example.test/contents/generations/tasks/synthetic-task");
  expect(submitted.allowPrivateNetwork).toBe(false);
  for (const request of [submitted, polled]) {
    const headers = typeof request.headers === "function" ? request.headers() : request.headers;
    expect(Object.fromEntries(new Headers(headers))).toMatchObject({
      authorization: "Bearer synthetic-provider-key",
      "x-relay": "synthetic-route",
    });
    expect(request.dispatcherPolicy).toMatchObject({
      mode: "explicit-proxy",
      proxyUrl: "http://proxy.example:8080",
    });
  }
});

it("denies private polling without needing a proxy override", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  pollMock.mockImplementation(actual.pollProviderOperationJson);
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unguarded synthetic poll reached fetch"));

  await expect(
    generateVideo(
      createModelProviderConfig({
        byteplus: { baseUrl: "http://127.0.0.1:9", models: [] },
      }),
    ),
  ).rejects.toMatchObject({ name: "SsrFBlockedError" });
  expect(postMock).toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("blocks generated metadata-service result URLs before connecting", async () => {
  completeTask("http://169.254.169.254/video.mp4");
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unguarded download reached fetch"));

  await expect(generateVideo()).rejects.toMatchObject({ name: "SsrFBlockedError" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("blocks a loopback result before contacting the synthetic HTTP server", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "video/mp4" }).end("synthetic video");
  });
  const claim = await acquireTestPortBlock({ offsets: [0] });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(claim.port, "127.0.0.1", resolve);
    });
    completeTask(`http://127.0.0.1:${claim.port}/video.mp4`);
    await expect(generateVideo()).rejects.toMatchObject({ name: "SsrFBlockedError" });
    expect(requests).toBe(0);
  } finally {
    try {
      if (server.listening) {
        await server[Symbol.asyncDispose]();
      }
    } finally {
      await claim.release();
    }
  }
});

it("downloads public results without forwarding task credentials", async () => {
  completeTask("http://93.184.216.34/video.mp4");
  const response = new Response("synthetic video", { headers: { "content-type": "video/mp4" } });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

  const result = await generateVideo();
  expect(result.videos[0]?.buffer?.toString()).toBe("synthetic video");
  const init = fetchMock.mock.calls[0]?.[1];
  expect(new Headers(init?.headers).has("authorization")).toBe(false);
  expect(init?.signal?.aborted).toBe(true);
});

it("reports failed download status and releases the guarded request", async () => {
  completeTask("http://93.184.216.34/missing.mp4");
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("missing synthetic video", {
      status: 404,
      headers: { "content-type": "video/mp4" },
    }),
  );

  await expect(generateVideo()).rejects.toThrow(/BytePlus generated video download failed.*404/);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
