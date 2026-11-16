// Covers provider/model gates for strict agentic execution-contract activation.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isStrictAgenticExecutionContractActive } from "./execution-contract.js";

describe("isStrictAgenticExecutionContractActive", () => {
  const emptyConfig: OpenClawConfig = {
    agents: { entries: { main: {} } },
  };

  it.each([
    ["mock-openai qa", "mock-openai", "mock-openai/gpt-5.4", undefined, true],
    ["normalized provider prefix", "openai", " OPENAI:GPT-5.4 ", undefined, true],
    ["non-gpt-5 family", "openai", "gpt-50", undefined, false],
    ["explicit opt-out", "openai", "gpt-5.4", "default", false],
    ["unsupported strict override", "anthropic", "claude-opus-4-6", "strict-agentic", false],
  ] as const)(
    "resolves activation for %s",
    (_label, provider, modelId, executionContract, expected) => {
      const config: OpenClawConfig = executionContract
        ? {
            agents: {
              ...emptyConfig.agents,
              defaults: { embeddedAgent: { executionContract } },
            },
          }
        : emptyConfig;
      expect(isStrictAgenticExecutionContractActive({ config, provider, modelId })).toBe(expected);
    },
  );
});
