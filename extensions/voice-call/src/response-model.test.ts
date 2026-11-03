// Voice Call tests cover response model plugin behavior.
import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { VoiceCallConfigSchema } from "./config.js";
import { resolveVoiceResponseModel } from "./response-model.js";

const agentRuntime = {
  defaults: {
    provider: "together",
    model: "Qwen/Qwen2.5-7B-Instruct-Turbo",
  },
} as unknown as OpenClawPluginApi["runtime"]["agent"];

describe("resolveVoiceResponseModel", () => {
  it("keeps legacy single-segment overrides on the runtime default provider", () => {
    expect(
      resolveVoiceResponseModel({
        cfg: {},
        agentId: "main",
        voiceConfig: VoiceCallConfigSchema.parse({
          responseModel: "gpt-5.4-mini",
        }),
        agentRuntime,
      }),
    ).toEqual({
      modelRef: "gpt-5.4-mini",
      provider: "together",
      model: "gpt-5.4-mini",
    });
  });

  it("keeps explicit provider/model overrides verbatim", () => {
    expect(
      resolveVoiceResponseModel({
        cfg: { agents: { entries: { main: { model: "anthropic/claude-opus-5-5" } } } },
        agentId: "main",
        voiceConfig: VoiceCallConfigSchema.parse({
          responseModel: "openai/gpt-5.4-mini",
        }),
        agentRuntime,
      }),
    ).toEqual({
      modelRef: "openai/gpt-5.4-mini",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
  });

  it("inherits the call agent's configured model when responseModel is unset", () => {
    expect(
      resolveVoiceResponseModel({
        cfg: {
          agents: {
            entries: {
              support: { model: "anthropic/claude-opus-5-5" },
            },
          },
        },
        agentId: "support",
        voiceConfig: VoiceCallConfigSchema.parse({}),
        agentRuntime,
      }),
    ).toEqual({
      modelRef: "anthropic/claude-opus-5-5",
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
  });

  it("inherits the global configured default when the call agent sets no model", () => {
    expect(
      resolveVoiceResponseModel({
        cfg: {
          agents: {
            entries: { support: {} },
            defaults: { model: { primary: "anthropic/claude-opus-5-5" } },
          },
        },
        agentId: "support",
        voiceConfig: VoiceCallConfigSchema.parse({}),
        agentRuntime,
      }),
    ).toEqual({
      modelRef: "anthropic/claude-opus-5-5",
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
  });

  it("falls back to the compiled-in runtime default when nothing is configured", () => {
    expect(
      resolveVoiceResponseModel({
        cfg: {},
        agentId: "main",
        voiceConfig: VoiceCallConfigSchema.parse({}),
        agentRuntime,
      }),
    ).toEqual({
      modelRef: "openai/gpt-6-astra",
      provider: "openai",
      model: "gpt-6-astra",
    });
  });
});
