// Shared fixtures for Vydra provider tests.
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { vi } from "vitest";
import plugin from "./index.js";

export function registerVydraProviders() {
  const captured = createCapturedPluginRegistration({ id: "test-plugin" });
  plugin.register(captured.api);
  const imageProvider = captured.imageGenerationProviders[0];
  const videoProvider = captured.videoGenerationProviders[0];
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
