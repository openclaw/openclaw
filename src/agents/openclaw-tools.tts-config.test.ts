import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  textToSpeech: vi.fn(async () => ({
    success: true,
    audioPath: "/tmp/openclaw/tts-config-test.opus",
    provider: "microsoft",
    voiceCompatible: true,
  })),
}));

vi.mock("../tts/tts.js", () => ({
  textToSpeech: mocks.textToSpeech,
}));

describe("createOpenClawTools TTS config wiring", () => {
  beforeEach(() => {
    mocks.textToSpeech.mockClear();
  });

  it("passes the resolved shared config into the tts tool", async () => {
    const injectedConfig = {
      messages: {
        tts: {
          auto: "always",
          provider: "microsoft",
          providers: {
            microsoft: {
              voice: "en-US-AvaNeural",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const { __testing, createOpenClawTools } = await import("./openclaw-tools.js");
    __testing.setDepsForTest({ config: injectedConfig });

    try {
      const tool = createOpenClawTools({
        disableMessageTool: true,
        disablePluginTools: true,
      }).find((candidate) => candidate.name === "tts");

      if (!tool) {
        throw new Error("missing tts tool");
      }

      await tool.execute("call-1", { text: "hello from config" });

      expect(mocks.textToSpeech).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "hello from config",
          cfg: injectedConfig,
        }),
      );
    } finally {
      __testing.setDepsForTest();
    }
  });
});
