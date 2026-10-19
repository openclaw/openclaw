// Verifies OpenAI model selections route between OpenClaw and Codex runtimes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import type { ModelApi } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  modelSelectionShouldEnsureCodexPlugin,
  resolveOpenAIImplicitAgentRuntime,
} from "./openai-routing.js";

function implicit(params: Parameters<typeof resolveOpenAIImplicitAgentRuntime>[0] = {}) {
  return resolveOpenAIImplicitAgentRuntime({ provider: "openai", env: {}, ...params });
}

function ensure(config?: OpenClawConfigWithLegacyRoster, agentId?: string) {
  return modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config, agentId });
}

function providerConfig(baseUrl: string, api?: ModelApi): OpenClawConfig {
  return { models: { providers: { openai: { baseUrl, api, models: [] } } } };
}

describe("OpenAI runtime routing policy", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_BASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses Codex by default for official OpenAI agent model selections", () => {
    expect(implicit()).toBe("codex");
    expect(implicit({ modelId: "gpt-5.4-nano" })).toBe("codex");
    expect(ensure({})).toBe(true);
  });

  it.each([["thinking", { thinking: "xhigh" }]])(
    "keeps Codex for model-scoped %s controls",
    (_label, params) => {
      const config: OpenClawConfig = {
        agents: { defaults: { models: { "openai/gpt-5.6-sol": { params } } } },
      };
      expect(implicit({ modelId: "gpt-5.6-sol", config })).toBe("codex");
    },
  );

  it("maps provider route facts onto a closed implicit runtime", () => {
    expect(implicit({ modelId: "gpt-5.6" })).toBe("codex");
    expect(
      implicit({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex/responses",
      }),
    ).toBe("codex");
    expect(
      implicit({
        modelId: "gpt-5.5",
        config: providerConfig("https://api.openai.com/v1", "openai-completions"),
      }),
    ).toBe("openclaw");
    expect(implicit({ baseUrl: "https://direct.example.test/v1" })).toBe("openclaw");
  });

  it("fails closed to OpenClaw when the provider artifact is unavailable", () => {
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    expect(resolveOpenAIImplicitAgentRuntime({ provider: "openai", modelId: "gpt-5.5" })).toBe(
      "openclaw",
    );
    expect(ensure()).toBe(false);
  });

  it("does not force Codex for custom OpenAI-compatible base URLs", () => {
    // A custom baseUrl means the provider key is only OpenAI-compatible, not official OpenAI.
    const config = providerConfig("https://example.test/v1");

    expect(resolveOpenAIImplicitAgentRuntime({ provider: "openai", config })).toBe("openclaw");
    expect(ensure(config)).toBe(false);
  });

  it("uses the configured fixed-store owner for agent-scoped request parameters", () => {
    const config = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "research" } },
        entries: {
          ops: {},
          research: { params: { store: false } },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      implicit({
        modelId: "gpt-5.5",
        config,
        sessionKey: "global",
      }),
    ).toBe("openclaw");
    expect(() =>
      implicit({
        modelId: "gpt-5.5",
        config,
        agentId: "ops",
        sessionKey: "global",
      }),
    ).toThrow(/belongs to "research"/);
  });

  it("honors explicit model runtime policy before the OpenAI base URL default", () => {
    const customCodexConfig = {
      ...providerConfig("https://example.test/v1"),
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const officialOpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(ensure(customCodexConfig)).toBe(true);
    expect(ensure(officialOpenClawConfig)).toBe(false);
  });

  it("honors the deprecated whole-agent OpenClaw runtime opt-out", () => {
    const config = {
      agents: {
        defaults: { agentRuntime: { id: "openclaw" } },
        entries: { worker: { agentRuntime: { id: "openclaw" } } },
      },
    } satisfies OpenClawConfigWithLegacyRoster;

    expect(ensure(config)).toBe(false);
    expect(ensure(config, "worker")).toBe(false);
  });

  it("keeps per-model auto policy above the whole-agent OpenClaw opt-out", () => {
    const config = {
      agents: {
        defaults: {
          agentRuntime: { id: "openclaw" },
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "auto" } },
          },
        },
      },
    } satisfies OpenClawConfigWithLegacyRoster;

    expect(ensure(config)).toBe(true);
  });
});
