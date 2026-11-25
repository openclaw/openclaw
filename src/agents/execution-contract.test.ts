// Covers provider/model gates for strict agentic execution-contract activation.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isStrictAgenticExecutionContractActive } from "./execution-contract.js";

describe("isStrictAgenticExecutionContractActive", () => {
  const supportedProvider = "openai";
  const unsupportedProvider = "anthropic";
  const emptyConfig: OpenClawConfig = {
    agents: { entries: { main: {} } },
  };

  describe("supported provider + model detection", () => {
    it("auto-activates on the mock-openai qa lane", () => {
      expect(
        isStrictAgenticExecutionContractActive({
          config: emptyConfig,
          provider: "mock-openai",
          modelId: "mock-openai/gpt-5.4",
        }),
      ).toBe(true);
    });

    it("auto-activates on normalized provider-prefixed model ids", () => {
      // Regression for the adversarial review finding: prefixed model ids
      // must strip the provider prefix before matching the regex.
      expect(
        isStrictAgenticExecutionContractActive({
          config: emptyConfig,
          provider: supportedProvider,
          modelId: " OPENAI:GPT-5.4 ",
        }),
      ).toBe(true);
    });

    it("does not match non-gpt-5 family ids", () => {
      expect(
        isStrictAgenticExecutionContractActive({
          config: emptyConfig,
          provider: supportedProvider,
          modelId: "gpt-50",
        }),
      ).toBe(false);
    });
  });

  describe("explicit override behavior", () => {
    it("honors explicit default opt-out even on the supported lane", () => {
      const config: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: {
            embeddedAgent: {
              executionContract: "default",
            },
          },
        },
      };
      expect(
        isStrictAgenticExecutionContractActive({
          config,
          provider: supportedProvider,
          modelId: "gpt-5.4",
        }),
      ).toBe(false);
    });

    it("collapses explicit strict-agentic to default on an unsupported lane", () => {
      const config: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: {
            embeddedAgent: {
              executionContract: "strict-agentic",
            },
          },
        },
      };
      expect(
        isStrictAgenticExecutionContractActive({
          config,
          provider: unsupportedProvider,
          modelId: "claude-opus-4-6",
        }),
      ).toBe(false);
    });
  });
});
