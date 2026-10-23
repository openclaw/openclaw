// Shared fixtures for Vydra provider tests.
import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import type { VideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import { vi } from "vitest";
import plugin from "./index.js";

export function registerVydraProviders() {
  const imageProviders: ImageGenerationProvider[] = [];
  const videoProviders: VideoGenerationProvider[] = [];
  plugin.register(
    createTestPluginApi({
      registerImageGenerationProvider(provider) {
        imageProviders.push(provider);
      },
      registerVideoGenerationProvider(provider) {
        videoProviders.push(provider);
      },
    }),
  );
  const imageProvider = imageProviders[0];
  const videoProvider = videoProviders[0];
  if (!imageProvider || !videoProvider) {
    throw new Error("Vydra image and video providers not registered");
  }
  return { imageProvider, videoProvider };
}

export function stubVydraApiKey(): void {
  vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "vydra-test-key",
    source: "env",
    mode: "api-key",
  });
}

export function jsonResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function binaryResponse(data: string, contentType: string): Response {
  return new Response(Buffer.from(data), {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

export function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
