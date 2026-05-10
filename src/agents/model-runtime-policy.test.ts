import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";

const ORIGINAL_BUILD_PRIVATE_QA = process.env.OPENCLAW_BUILD_PRIVATE_QA;
const ORIGINAL_QA_FORCE_RUNTIME = process.env.OPENCLAW_QA_FORCE_RUNTIME;

vi.mock("./agent-scope.js", () => ({
  listAgentEntries: () => [],
  resolveSessionAgentIds: () => ({ sessionAgentId: undefined }),
}));

function restoreEnv(
  name: "OPENCLAW_BUILD_PRIVATE_QA" | "OPENCLAW_QA_FORCE_RUNTIME",
  value: string | undefined,
): void {
  if (value == null) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function makeProviderRuntimeConfig(runtime: string): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.example/v1",
          agentRuntime: { id: runtime },
          models: [],
        },
      },
    },
  } as OpenClawConfig;
}

afterEach(() => {
  restoreEnv("OPENCLAW_BUILD_PRIVATE_QA", ORIGINAL_BUILD_PRIVATE_QA);
  restoreEnv("OPENCLAW_QA_FORCE_RUNTIME", ORIGINAL_QA_FORCE_RUNTIME);
});

describe("resolveModelRuntimePolicy", () => {
  it("ignores the QA force-runtime override when the private QA gate is unset", () => {
    delete process.env.OPENCLAW_BUILD_PRIVATE_QA;
    process.env.OPENCLAW_QA_FORCE_RUNTIME = "pi";

    expect(
      resolveModelRuntimePolicy({
        config: makeProviderRuntimeConfig("codex"),
        provider: "openai",
        modelId: "gpt-5.5",
      }),
    ).toEqual({
      policy: { id: "codex" },
      source: "provider",
    });
  });

  it("respects the QA force-runtime override when the private QA gate is set", () => {
    process.env.OPENCLAW_BUILD_PRIVATE_QA = "1";
    process.env.OPENCLAW_QA_FORCE_RUNTIME = "pi";

    expect(
      resolveModelRuntimePolicy({
        config: makeProviderRuntimeConfig("codex"),
        provider: "openai",
        modelId: "gpt-5.5",
      }),
    ).toEqual({
      policy: { id: "pi" },
      source: "model",
    });
  });

  it("ignores invalid QA force-runtime values even when the private QA gate is set", () => {
    process.env.OPENCLAW_BUILD_PRIVATE_QA = "1";
    process.env.OPENCLAW_QA_FORCE_RUNTIME = "bogus";

    expect(
      resolveModelRuntimePolicy({
        config: makeProviderRuntimeConfig("codex"),
        provider: "openai",
        modelId: "gpt-5.5",
      }),
    ).toEqual({
      policy: { id: "codex" },
      source: "provider",
    });
  });
});
