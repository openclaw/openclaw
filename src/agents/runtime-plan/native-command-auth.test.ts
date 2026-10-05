import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentHarnessPreparedAuthSupport } from "../harness/support.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";
import { prepareAuthFixture } from "./prepare-auth.test-support.js";

const config: OpenClawConfig = {
  models: {
    providers: {
      openai: {
        auth: "native-command",
        api: "openai-responses",
        baseUrl: "https://example.test/api/autodev/llm/v1",
        models: [
          {
            id: "gpt-56-reasoning-sol",
            name: "Sol",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100000,
            maxTokens: 1000,
          },
        ],
      },
    },
  },
};

describe("native command provider auth", () => {
  it("defers the custom Responses route only to an explicit Codex harness", () => {
    const prepared = prepareAuthFixture({
      provider: "openai",
      modelId: "gpt-56-reasoning-sol",
      config,
      env: {},
      authProfileStore: { version: 1, profiles: {} },
      harnessId: "codex",
      harnessRuntime: "codex",
      harnessAuthBootstrap: "harness",
    });
    expect(prepared.plan.modelRoute).toBeUndefined();
    expect(prepared.plan.deferredRouteSupport?.runtimePolicy.compatibleIds).toContain("codex");
    expect(resolveAgentHarnessPreparedAuthSupport({ plan: prepared.plan })).toEqual({
      source: "harness",
    });
  });

  it("refuses a declared key mixed with command auth", () => {
    expect(() =>
      prepareAgentRuntimeAuth({
        provider: "openai",
        modelId: "gpt-56-reasoning-sol",
        config: {
          ...config,
          models: {
            providers: {
              openai: { ...config.models!.providers!.openai!, apiKey: "synthetic-key" },
            },
          },
        },
        env: {},
        authProfileStore: { version: 1, profiles: {} },
        harnessId: "codex",
        harnessRuntime: "codex",
        harnessAuthBootstrap: "harness",
      }),
    ).toThrow("Native command auth cannot be combined");
  });
});
