import type { postJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { afterEach, expect, it, vi } from "vitest";
import { buildZaiVideoGenerationProvider } from "./video-generation-provider.js";

const { postJsonResponseMock } = vi.hoisted(() => ({
  postJsonResponseMock: vi.fn<typeof postJsonResponse>(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "synthetic-zai-key" }),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  postJsonResponse: postJsonResponseMock,
}));

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "honors private polling policy without a proxy override (allowed: %s)",
  async (allowPrivateNetwork) => {
    postJsonResponseMock.mockResolvedValue({ id: "synthetic-task" });
    const intercepted = new Error("synthetic poll intercepted before network");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(intercepted);

    const pending = buildZaiVideoGenerationProvider().generateVideo({
      provider: "zai",
      model: "cogvideox-3",
      prompt: "a synthetic lobster",
      cfg: {
        models: {
          providers: {
            zai: {
              baseUrl: "http://127.0.0.1:9",
              models: [],
              request: { allowPrivateNetwork },
            },
          },
        },
      },
    });
    if (allowPrivateNetwork) {
      await expect(pending).rejects.toThrow(intercepted.message);
      expect(fetchMock).toHaveBeenCalledOnce();
    } else {
      await expect(pending).rejects.toMatchObject({ name: "SsrFBlockedError" });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  },
);
