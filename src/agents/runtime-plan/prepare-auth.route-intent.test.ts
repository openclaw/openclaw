import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { createModelAuthAvailabilityResolver } from "../model-auth-availability.js";
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

describe("explicit authentication before inherited billing intent", () => {
  it.each(["provider-auth", "provider-profile", "auth-order"] as const)(
    "preserves the API choice from %s for an OAuth-pinned primary",
    (choice) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "openai/gpt-5.5@openai:chatgpt-default",
            heartbeat: { model: "openai/gpt-5.4-mini" },
          },
        },
        auth: {
          profiles: {
            "openai:default": { provider: "openai", mode: "api_key" },
            "openai:chatgpt-default": { provider: "openai", mode: "oauth" },
          },
          ...(choice === "auth-order"
            ? { order: { openai: ["openai:default", "openai:chatgpt-default"] } }
            : {}),
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-completions",
              models: [],
              ...(choice === "provider-auth" ? { auth: "api-key" } : {}),
              ...(choice === "provider-profile" ? { apiKey: "openai:default" } : {}),
            },
          },
        },
      };
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "synthetic-api-key" },
          "openai:chatgpt-default": {
            type: "oauth",
            provider: "openai",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() + 600_000,
          },
        },
      };
      if (choice === "provider-profile") {
        expect(
          createModelAuthAvailabilityResolver({
            cfg: config,
            authStore: store,
            env: {},
          }).evaluateModelAuth("openai", { modelId: "gpt-5.4-mini" }),
        ).toMatchObject({
          availability: true,
          selectedProfileId: "openai:default",
          selectedRoute: { authRequirement: "api-key" },
        });
      } else {
        expect(
          prepareAgentRuntimeAuth({
            provider: "openai",
            modelId: "gpt-5.4-mini",
            config,
            authProfileStore: store,
            env: {},
          }).plan,
        ).toMatchObject({
          forwardedAuthProfileId: "openai:default",
          modelRoute: { authRequirement: "api-key" },
        });
      }
    },
  );
});
