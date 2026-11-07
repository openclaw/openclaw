import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const LIVE = isLiveTestEnabled();
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY?.trim() ?? "";

describe.skipIf(!LIVE || !HEYGEN_API_KEY)("heygen live", () => {
  it.each(["http", "websocket"])(
    "streams speech over %s",
    async (streamTransport) => {
      const { speechProviders } = await registerProviderPlugin({
        plugin,
        id: "heygen-speech",
        name: "HeyGen Voice",
      });
      const provider = requireRegisteredProvider(speechProviders, "heygen");

      const result = await provider.streamSynthesize?.({
        text: "Hello from OpenClaw.",
        cfg: { plugins: { enabled: true } } as never,
        providerConfig: { apiKey: HEYGEN_API_KEY, streamTransport },
        target: "audio-file",
        timeoutMs: 45_000,
      });

      expect(result?.outputFormat).toBe("mp3");
      const audio = await new Response(result?.audioStream).arrayBuffer();
      expect(audio.byteLength).toBeGreaterThan(512);
    },
    60_000,
  );
});
