import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginCommandDefinition } from "../../test/helpers/extensions/plugin-command.js";
import { createPluginRuntimeMock } from "../../test/helpers/extensions/plugin-runtime-mock.js";
import register from "./index.js";

function createHarness(config: Record<string, unknown>) {
  let command: OpenClawPluginCommandDefinition | undefined;
  const runtime = createPluginRuntimeMock({
    config: {
      loadConfig: vi.fn(() => config),
      writeConfigFile: vi.fn().mockResolvedValue(undefined),
    },
    tts: {
      listVoices: vi.fn(),
    },
  });
  const api = {
    runtime,
    registerCommand: vi.fn((definition: OpenClawPluginCommandDefinition) => {
      command = definition;
    }),
  };
  register.register(api as never);
  if (!command) {
    throw new Error("talk-voice command not registered");
  }
  return { command, runtime };
}

function createCommandContext(
  args: string,
  channel: string = "discord",
  gatewayClientScopes?: string[],
) {
  return {
    args,
    channel,
    channelId: channel,
    isAuthorizedSender: true,
    gatewayClientScopes,
    commandBody: args ? `/voice ${args}` : "/voice",
    config: {},
    requestConversationBinding: vi.fn(),
    detachConversationBinding: vi.fn(),
    getCurrentConversationBinding: vi.fn(),
  };
}

describe("talk-voice plugin", () => {
  it("reports active provider status", async () => {
    const { command } = createHarness({
      talk: {
        provider: "microsoft",
        providers: {
          microsoft: {
            voiceId: "en-US-AvaNeural",
            apiKey: "secret-token",
          },
        },
      },
    });

    const result = await command.handler(createCommandContext(""));

    expect(result).toEqual({
      text:
        "Talk voice status:\n" +
        "- provider: microsoft\n" +
        "- talk.voiceId: en-US-AvaNeural\n" +
        "- microsoft.apiKey: secret…",
    });
  });

  it("lists voices from the active provider", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "sk-eleven",
            baseUrl: "https://voices.example.test",
          },
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([
      { id: "voice-a", name: "Claudia", category: "general" },
      { id: "voice-b", name: "Bert" },
    ]);

    const result = await command.handler(createCommandContext("list 1"));

    expect(runtime.tts.listVoices).toHaveBeenCalledWith({
      provider: "elevenlabs",
      cfg: {
        talk: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: {
              apiKey: "sk-eleven",
              baseUrl: "https://voices.example.test",
            },
          },
        },
      },
      apiKey: "sk-eleven",
      baseUrl: "https://voices.example.test",
    });
    expect(result).toEqual({
      text:
        "ElevenLabs voices: 2\n\n" +
        "- Claudia · general\n" +
        "  id: voice-a\n\n" +
        "(showing first 1)",
    });
  });

  it("surfaces richer provider voice metadata when available", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "microsoft",
        providers: {
          microsoft: {},
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([
      {
        id: "en-US-AvaNeural",
        name: "Ava",
        category: "General",
        locale: "en-US",
        gender: "Female",
        personalities: ["Friendly", "Positive"],
        description: "Friendly, Positive",
      },
    ]);

    const result = await command.handler(createCommandContext("list"));

    expect(result).toEqual({
      text:
        "Microsoft voices: 1\n\n" +
        "- Ava · General\n" +
        "  id: en-US-AvaNeural\n" +
        "  meta: en-US · Female · Friendly, Positive\n" +
        "  note: Friendly, Positive",
    });
  });

  it("writes canonical talk provider config and legacy elevenlabs voice id", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "sk-eleven",
          },
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([{ id: "voice-a", name: "Claudia" }]);

    const result = await command.handler(createCommandContext("set Claudia"));

    expect(runtime.config.writeConfigFile).toHaveBeenCalledWith({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "sk-eleven",
            voiceId: "voice-a",
          },
        },
        voiceId: "voice-a",
      },
    });
    expect(result).toEqual({
      text: "✅ ElevenLabs Talk voice set to Claudia\nvoice-a",
    });
  });

  it("writes provider voice id without legacy top-level field for microsoft", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "microsoft",
        providers: {
          microsoft: {},
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([{ id: "en-US-AvaNeural", name: "Ava" }]);

    await command.handler(createCommandContext("set Ava"));

    expect(runtime.config.writeConfigFile).toHaveBeenCalledWith({
      talk: {
        provider: "microsoft",
        providers: {
          microsoft: {
            voiceId: "en-US-AvaNeural",
          },
        },
      },
    });
  });

  it("rejects /voice set from gateway client with only operator.write scope", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "sk-eleven",
          },
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([{ id: "voice-a", name: "Claudia" }]);

    const result = await command.handler(
      createCommandContext("set Claudia", "webchat", ["operator.write"]),
    );

    expect(result.text).toContain("requires operator.admin");
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });

  it("allows /voice set from gateway client with operator.admin scope", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "sk-eleven",
          },
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([{ id: "voice-a", name: "Claudia" }]);

    const result = await command.handler(
      createCommandContext("set Claudia", "webchat", ["operator.admin"]),
    );

    expect(runtime.config.writeConfigFile).toHaveBeenCalled();
    expect(result.text).toContain("voice-a");
  });

  it("rejects /voice set from webchat channel with no scopes (TUI/internal)", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "sk-eleven",
          },
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([{ id: "voice-a", name: "Claudia" }]);

    // gatewayClientScopes omitted — simulates internal webchat session without scopes
    const result = await command.handler(createCommandContext("set Claudia", "webchat"));

    expect(result.text).toContain("requires operator.admin");
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });

  it("allows /voice set from non-gateway channels without scope check", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "sk-eleven",
          },
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockResolvedValue([{ id: "voice-a", name: "Claudia" }]);

    const result = await command.handler(createCommandContext("set Claudia", "telegram"));

    expect(runtime.config.writeConfigFile).toHaveBeenCalled();
    expect(result.text).toContain("voice-a");
  });

  it("returns provider lookup errors cleanly", async () => {
    const { command, runtime } = createHarness({
      talk: {
        provider: "microsoft",
        providers: {
          microsoft: {},
        },
      },
    });
    vi.mocked(runtime.tts.listVoices).mockRejectedValue(
      new Error("speech provider microsoft does not support voice listing"),
    );

    const result = await command.handler(createCommandContext("list"));

    expect(result).toEqual({
      text: "Microsoft voice list failed: speech provider microsoft does not support voice listing",
    });
  });
});
