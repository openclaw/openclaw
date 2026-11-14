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
  const configuredModel = "anthropic/claude-opus-5-5";
  type Case = {
    name: string;
    cfg: Parameters<typeof resolveVoiceResponseModel>[0]["cfg"];
    agentId: string;
    responseModel?: string;
    expected: ReturnType<typeof resolveVoiceResponseModel>;
  };
  it.each<Case>([
    {
      name: "keeps legacy single-segment overrides on the runtime default provider",
      cfg: {},
      agentId: "main",
      responseModel: "gpt-5.4-mini",
      expected: { provider: "together", model: "gpt-5.4-mini" },
    },
    {
      name: "keeps explicit provider/model overrides verbatim",
      cfg: { agents: { entries: { main: { model: configuredModel } } } },
      agentId: "main",
      responseModel: "openai/gpt-5.4-mini",
      expected: { provider: "openai", model: "gpt-5.4-mini" },
    },
    {
      name: "inherits the call agent's configured model when responseModel is unset",
      cfg: { agents: { entries: { support: { model: configuredModel } } } },
      agentId: "support",
      expected: { provider: "anthropic", model: "claude-opus-5-5" },
    },
    {
      name: "inherits the global configured default when the call agent sets no model",
      cfg: {
        agents: { entries: { support: {} }, defaults: { model: { primary: configuredModel } } },
      },
      agentId: "support",
      expected: { provider: "anthropic", model: "claude-opus-5-5" },
    },
    {
      name: "falls back to the compiled-in runtime default when nothing is configured",
      cfg: {},
      agentId: "main",
      expected: { provider: "openai", model: "gpt-6-astra" },
    },
  ])("$name", ({ cfg, agentId, responseModel, expected }) => {
    expect(
      resolveVoiceResponseModel({
        cfg,
        agentId,
        voiceConfig: normalizeVoiceCallConfig(responseModel ? { responseModel } : {}),
        agentRuntime,
      }),
    ).toEqual(expected);
  });
});
