import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { getResolvedSpeechProviderConfig, resolveTtsConfig } from "./tts.js";

describe("resolveTtsConfig", () => {
  it("merges per-agent provider overrides over global defaults", () => {
    const cfg = {
      messages: {
        tts: {
          auto: "always",
          provider: "openai",
          providers: {
            openai: {
              voice: "alloy",
            },
          },
        },
      },
      agents: {
        list: [
          {
            id: "voicey",
            tts: {
              providers: {
                openai: {
                  voice: "ash",
                },
              },
            },
          },
        ],
      },
    } as OpenClawConfig;

    const defaultConfig = resolveTtsConfig(cfg);
    const agentConfig = resolveTtsConfig(cfg, "voicey");

    expect(getResolvedSpeechProviderConfig(defaultConfig, "openai", cfg)).toMatchObject({
      voice: "alloy",
    });
    expect(getResolvedSpeechProviderConfig(agentConfig, "openai", cfg)).toMatchObject({
      voice: "ash",
    });
  });
});
