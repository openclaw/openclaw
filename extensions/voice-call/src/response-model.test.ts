// Voice Call tests cover response model plugin behavior.
import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { normalizeVoiceCallConfig } from "./config.js";
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
        voiceConfig: normalizeVoiceCallConfig({
          responseModel: "gpt-5.4-mini",
        }),
        agentRuntime,
      }),
    ).toEqual({
      provider: "together",
      model: "gpt-5.4-mini",
    });
  });

  it("keeps explicit provider/model overrides verbatim", () => {
    expect(
      resolveVoiceResponseModel({
        cfg: { agents: { entries: { main: { model: "anthropic/claude-opus-5-5" } } } },
        agentId: "main",
        voiceConfig: normalizeVoiceCallConfig({
          responseModel: "openai/gpt-5.4-mini",
        }),
        agentRuntime,
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
  });

  it("resolves configured model aliases to their target", () => {
    expect(
      resolveVoiceResponseModel({
        cfg: {
          agents: {
            defaults: {
              models: { "anthropic/claude-sonnet-5-5": { alias: "medium" } },
            },
          },
        },
        agentId: "main",
        voiceConfig: normalizeVoiceCallConfig({
          responseModel: "medium",
        }),
        agentRuntime,
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
  });

  it("keeps non-alias overrides unchanged when aliases are configured", () => {
    const cfg = {
      agents: {
        defaults: {
          models: { "anthropic/claude-sonnet-5-5": { alias: "medium" } },
        },
      },
    };
    expect(
      resolveVoiceResponseModel({
        cfg,
        agentId: "main",
        voiceConfig: normalizeVoiceCallConfig({ responseModel: "gpt-5.4-mini" }),
        agentRuntime,
      }),
    ).toEqual({ provider: "together", model: "gpt-5.4-mini" });
    expect(
      resolveVoiceResponseModel({
        cfg,
        agentId: "main",
        voiceConfig: normalizeVoiceCallConfig({ responseModel: "openai/gpt-5.4-mini" }),
        agentRuntime,
      }),
    ).toEqual({ provider: "openai", model: "gpt-5.4-mini" });
  });

  it("keeps a literal provider/model verbatim when it is also an alias target", () => {
    expect(
      resolveVoiceResponseModel({
        cfg: {
          agents: {
            defaults: {
              models: { "anthropic/claude-sonnet-5-5": { alias: "medium" } },
            },
          },
        },
        agentId: "main",
        voiceConfig: normalizeVoiceCallConfig({ responseModel: "anthropic/claude-sonnet-5-5" }),
        agentRuntime,
      }),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
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
        voiceConfig: normalizeVoiceCallConfig({}),
        agentRuntime,
      }),
    ).toEqual({
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
        voiceConfig: normalizeVoiceCallConfig({}),
        agentRuntime,
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
  });

  it("falls back to the compiled-in runtime default when nothing is configured", () => {
    expect(
      resolveVoiceResponseModel({
        cfg: {},
        agentId: "main",
        voiceConfig: normalizeVoiceCallConfig({}),
        agentRuntime,
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-6-astra",
    });
  });
});
