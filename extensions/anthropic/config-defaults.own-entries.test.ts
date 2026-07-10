import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { applyAnthropicConfigDefaults } from "./config-defaults.js";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type AgentModelEntryConfig = NonNullable<AgentDefaults["models"]>[string];

describe("Anthropic API-key default model own entries", () => {
  it("seeds an own allowlist entry when the same model ref is inherited", () => {
    const inheritedRef = "anthropic/claude-sonnet-5";
    const inheritedModels = Object.create({
      [inheritedRef]: { params: { cacheRetention: "long" } },
    }) as Record<string, AgentModelEntryConfig>;
    const models = Object.assign(inheritedModels, {
      "anthropic/claude-opus-4-6": {
        params: { cacheRetention: "short" },
      },
      "anthropic/claude-sonnet-4-6": {
        alias: "keep-own",
        params: { cacheRetention: "long" },
      },
    }) satisfies Record<string, AgentModelEntryConfig>;

    const nextConfig = applyAnthropicConfigDefaults({
      config: {
        auth: {
          profiles: {
            "anthropic:default": {
              provider: "anthropic",
              mode: "api_key",
            },
          },
        },
        agents: {
          defaults: {
            models,
          },
        },
      },
      env: {},
    });

    const nextModels = nextConfig.agents?.defaults?.models;
    expect(Object.hasOwn(nextModels ?? {}, inheritedRef)).toBe(true);
    expect(nextModels?.[inheritedRef]).toEqual({
      params: { cacheRetention: "short" },
    });
    expect(nextModels?.["anthropic/claude-sonnet-4-6"]).toEqual({
      alias: "keep-own",
      params: { cacheRetention: "long" },
    });
  });
});
