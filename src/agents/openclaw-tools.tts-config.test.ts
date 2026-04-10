import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  textToSpeech: vi.fn(async () => ({
    success: true,
    audioPath: "/tmp/tts-config-test.opus",
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
          provider: "edge",
          edge: {
            voice: "en-US-AvaNeural",
          },
          providers: {
            microsoft: {
              voice: "en-US-AvaNeural",
            },
          },
        },
      },
    } as OpenClawConfig;

    const { __testing, createOpenClawTools } = await import("./openclaw-tools.js");
    __testing.setDepsForTest({ config: injectedConfig });

    try {
      const tool = createOpenClawTools({
        disablePluginTools: true,
        disableMessageTool: true,
      }).find((candidate) => candidate.name === "tts");

      expect(tool).toBeDefined();
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
