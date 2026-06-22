import { describe, expect, it } from "vitest";
import { vi } from "vitest";

// Force the realtime-transcription resolver to find nothing so the streaming
// path cannot resolve an STT provider.
vi.mock("./realtime-transcription.runtime.js", () => ({
  getRealtimeTranscriptionProvider: () => undefined,
  listRealtimeTranscriptionProviders: () => [],
}));

import type { VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import type { CallManager } from "./manager.js";
import { wireMsteamsRuntime } from "./msteams.runtime.js";
import { MsteamsProvider } from "./providers/msteams.js";

describe("wireMsteamsRuntime (fail-fast)", () => {
  it("throws when streaming is enabled but no usable STT provider resolves", async () => {
    const provider = new MsteamsProvider({});
    const config = {
      streaming: { enabled: true, provider: "nonexistent", providers: {} },
    } as unknown as VoiceCallConfig;

    await expect(
      wireMsteamsRuntime({
        config,
        coreConfig: {} as unknown as CoreConfig,
        fullConfig: {} as unknown as Parameters<typeof wireMsteamsRuntime>[0]["fullConfig"],
        agentRuntime: {} as unknown as CoreAgentDeps,
        manager: {} as unknown as CallManager,
        provider,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/no usable realtime transcription provider/);

    await provider.stop();
  });
});
