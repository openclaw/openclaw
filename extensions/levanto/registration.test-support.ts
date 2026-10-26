import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { vi } from "vitest";
import plugin from "./index.js";

export function registerLevantoTestProvider(
  getImageMetadata: OpenClawPluginApi["runtime"]["media"]["getImageMetadata"],
) {
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  const api = createTestPluginApi({ id: "levanto", registerDecisionProvider });
  api.runtime.media = {
    getImageMetadata,
    loadWebMedia: vi.fn(),
    detectMime: vi.fn(),
    mediaKindFromMime: vi.fn(),
    isVoiceCompatibleAudio: vi.fn(),
    resizeToJpeg: vi.fn(),
  };
  plugin.register(api);
  return registerDecisionProvider.mock.calls[0]?.[0];
}
