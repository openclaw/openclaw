import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

describe("prepared primary route inheritance", () => {
  it.each([
    { primary: "metered", runtime: "openclaw" },
    { primary: "gpt-5.5", runtime: "openclaw" },
    { primary: "metered@openai:platform", runtime: "codex" },
    { primary: "openai/gpt-5.5", runtime: "openclaw" },
    { primary: "openai/gpt-5.5@openai:platform", runtime: "codex" },
    { primary: "gpt-5.5@openai:platform", runtime: "openclaw", profileMetadata: false },
    {
      primary: "metered@openai:platform",
      runtime: "codex",
      profileMetadata: false,
      observedResponses: true,
    },
  ])(
    "preserves the API route inherited from $primary (metadata: $profileMetadata)",
    ({ primary, runtime, profileMetadata, observedResponses }) => {
      const config: OpenClawConfig = {
        agents: {
          entries: { assistant: {} },
          defaults: {
            model: primary,
            models: {
              "openai/gpt-5.5": { alias: "metered", agentRuntime: { id: runtime } },
            },
            heartbeat: { model: "openai/gpt-5.4-mini" },
          },
        },
        auth:
          profileMetadata === false
            ? undefined
            : {
                profiles: {
                  "openai:platform": { provider: "openai", mode: "api_key" },
                  "openai:chatgpt": { provider: "openai", mode: "oauth" },
                },
              },
        models: observedResponses
          ? undefined
          : {
              providers: {
                openai: {
                  api: "openai-completions",
                  baseUrl: "https://api.openai.com/v1",
                  models: [],
                },
              },
            },
      };
      const authProfileStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:platform": { type: "api_key", provider: "openai", key: "fixture-key" },
          "openai:chatgpt": {
            type: "oauth",
            provider: "openai",
            access: "fixture-access",
            refresh: "fixture-refresh",
            expires: Date.now() + 60_000,
          },
        },
      };
      const prepared = prepareAgentRuntimeAuth({
        config,
        agentId: "assistant",
        provider: "openai",
        modelId: "gpt-5.4-mini",
        ...(observedResponses
          ? { modelApi: "openai-responses", modelBaseUrl: "https://api.openai.com/v1" }
          : {}),
        authProfileStore,
        env: {},
      });
      expect(prepared.plan).toMatchObject({
        forwardedAuthProfileId: "openai:platform",
        modelRoute: { authRequirement: "api-key" },
      });
      expect(config.agents?.defaults?.model).toBe(primary);
    },
  );
});
