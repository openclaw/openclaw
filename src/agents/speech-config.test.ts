import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAgentSpeechConfig, resolveSessionSpeechConfig } from "./speech-config.js";

describe("resolveAgentSpeechConfig", () => {
  it("returns the original config when the agent has no speech overrides", () => {
    const cfg: OpenClawConfig = {
      messages: {
        tts: {
          provider: "openai",
        },
      },
      agents: {
        list: [{ id: "main" }],
      },
    };

    expect(resolveAgentSpeechConfig(cfg, "main")).toBe(cfg);
  });

  it("merges per-agent tts overrides onto messages.tts", () => {
    const cfg: OpenClawConfig = {
      messages: {
        tts: {
          provider: "openai",
          auto: "always",
          providers: {
            openai: {
              voice: "alloy",
              model: "gpt-4o-mini-tts",
            },
          },
        },
      },
      agents: {
        list: [
          {
            id: "spanish",
            tts: {
              auto: "inbound",
              providers: {
                openai: {
                  voice: "coral",
                },
              },
            },
          },
        ],
      },
    };

    const resolved = resolveAgentSpeechConfig(cfg, "spanish");

    expect(resolved.messages?.tts).toEqual({
      provider: "openai",
      auto: "inbound",
      providers: {
        openai: {
          voice: "coral",
          model: "gpt-4o-mini-tts",
        },
      },
    });
  });

  it("merges per-agent stt overrides onto tools.media.audio", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          audio: {
            language: "en",
            prompt: "Default prompt",
            models: [
              {
                provider: "openai",
                model: "gpt-4o-transcribe",
              },
            ],
          },
        },
      },
      agents: {
        list: [
          {
            id: "spanish",
            stt: {
              language: "es",
              models: [
                {
                  provider: "deepgram",
                  model: "nova-3",
                },
              ],
            },
          },
        ],
      },
    };

    const resolved = resolveAgentSpeechConfig(cfg, "spanish");

    expect(resolved.tools?.media?.audio).toEqual({
      language: "es",
      prompt: "Default prompt",
      models: [
        {
          provider: "deepgram",
          model: "nova-3",
        },
      ],
    });
  });
});

describe("resolveSessionSpeechConfig", () => {
  it("resolves the agent from the session key before merging speech config", () => {
    const cfg: OpenClawConfig = {
      messages: {
        tts: {
          auto: "always",
        },
      },
      agents: {
        list: [
          {
            id: "voice",
            tts: {
              auto: "tagged",
            },
          },
        ],
      },
    };

    const resolved = resolveSessionSpeechConfig({
      cfg,
      sessionKey: "agent:voice:main",
    });

    expect(resolved.messages?.tts?.auto).toBe("tagged");
  });
});
