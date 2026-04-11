import { describe, expect, it } from "vitest";
import { resolveSTTConfig } from "./stt.js";

describe("resolveSTTConfig", () => {
  it("returns null when no STT config is present", () => {
    expect(resolveSTTConfig({})).toBeNull();
  });

  it("returns null when channels.qqbot.stt is disabled", () => {
    const cfg = {
      channels: {
        qqbot: {
          stt: { enabled: false, baseUrl: "https://api.example.com", apiKey: "key" },
        },
      },
    };
    expect(resolveSTTConfig(cfg)).toBeNull();
  });

  it("resolves STT config from channel-specific settings", () => {
    const cfg = {
      channels: {
        qqbot: {
          stt: {
            enabled: true,
            baseUrl: "https://stt.example.com/v1",
            apiKey: "stt-key-123",
            model: "whisper-1",
          },
        },
      },
    };
    const result = resolveSTTConfig(cfg);
    expect(result).toEqual({
      baseUrl: "https://stt.example.com/v1",
      apiKey: "stt-key-123",
      model: "whisper-1",
    });
  });

  it("falls back to provider config when channel STT omits baseUrl/apiKey", () => {
    const cfg = {
      channels: {
        qqbot: {
          stt: { enabled: true, provider: "openai" },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-test",
          },
        },
      },
    };
    const result = resolveSTTConfig(cfg);
    expect(result).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "whisper-1",
    });
  });

  it("strips trailing slashes from baseUrl", () => {
    const cfg = {
      channels: {
        qqbot: {
          stt: {
            enabled: true,
            baseUrl: "https://stt.example.com/v1///",
            apiKey: "key",
          },
        },
      },
    };
    const result = resolveSTTConfig(cfg);
    expect(result?.baseUrl).toBe("https://stt.example.com/v1");
  });

  it("defaults model to whisper-1 when not specified", () => {
    const cfg = {
      channels: {
        qqbot: {
          stt: { enabled: true, baseUrl: "https://stt.example.com", apiKey: "key" },
        },
      },
    };
    const result = resolveSTTConfig(cfg);
    expect(result?.model).toBe("whisper-1");
  });

  it("resolves STT from framework-level audio model config", () => {
    const cfg = {
      tools: {
        media: {
          audio: {
            models: [
              {
                provider: "openai",
                model: "whisper-3",
              },
            ],
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-framework",
          },
        },
      },
    };
    const result = resolveSTTConfig(cfg);
    expect(result).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-framework",
      model: "whisper-3",
    });
  });

  it("prefers channel-specific config over framework-level config", () => {
    const cfg = {
      channels: {
        qqbot: {
          stt: {
            enabled: true,
            baseUrl: "https://channel-stt.example.com",
            apiKey: "channel-key",
            model: "channel-model",
          },
        },
      },
      tools: {
        media: {
          audio: {
            models: [
              {
                provider: "openai",
                baseUrl: "https://framework-stt.example.com",
                apiKey: "framework-key",
              },
            ],
          },
        },
      },
    };
    const result = resolveSTTConfig(cfg);
    expect(result?.baseUrl).toBe("https://channel-stt.example.com");
    expect(result?.apiKey).toBe("channel-key");
    expect(result?.model).toBe("channel-model");
  });

  it("returns null when neither channel nor framework config has baseUrl", () => {
    const cfg = {
      channels: {
        qqbot: {
          stt: { enabled: true },
        },
      },
    };
    expect(resolveSTTConfig(cfg)).toBeNull();
  });

  it("returns null when framework audio models is not an array", () => {
    const cfg = {
      tools: {
        media: {
          audio: {
            models: "not-an-array",
          },
        },
      },
    };
    expect(resolveSTTConfig(cfg)).toBeNull();
  });
});
