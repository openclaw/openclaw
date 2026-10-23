import type {
  pollProviderOperationJson,
  postJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { afterEach, assert, expect, it, vi } from "vitest";
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

it("preserves configured task headers and proxy through submission and polling", async () => {
  const intercepted = new Error("synthetic polling intercepted");
  postMock.mockResolvedValue({ id: "synthetic-task" });
  pollMock.mockRejectedValue(intercepted);

  await expect(
    buildBytePlusVideoGenerationProvider().generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "a synthetic lobster",
      cfg: {
        models: {
          providers: {
            byteplus: {
              baseUrl: "https://relay.example.test",
              models: [],
              request: {
                headers: { "X-Relay": "synthetic-route" },
                proxy: { mode: "explicit-proxy", url: "http://proxy.example:8080" },
                allowPrivateNetwork: true,
              },
            },
          },
        },
      },
    }),
  ).rejects.toBe(intercepted);

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
  postMock.mockResolvedValue({ id: "synthetic-task" });
  pollMock.mockImplementation(actual.pollProviderOperationJson);
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unguarded synthetic poll reached fetch"));

  await expect(
    buildBytePlusVideoGenerationProvider().generateVideo({
      provider: "byteplus",
      model: "seedance-1-0-pro-250528",
      prompt: "a synthetic lobster",
      cfg: {
        models: {
          providers: {
            byteplus: { baseUrl: "http://127.0.0.1:9", models: [] },
          },
        },
      },
    }),
  ).rejects.toMatchObject({ name: "SsrFBlockedError" });
  expect(postMock).toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});
