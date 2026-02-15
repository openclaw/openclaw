import { describe, expect, it } from "vitest";
import { classifyComplexity, resolveModelRoutingConfig, routeMessage } from "./model-routing.js";

describe("resolveModelRoutingConfig", () => {
  it("returns defaults with enabled=false", () => {
    const config = resolveModelRoutingConfig();
    expect(config.enabled).toBe(false);
    expect(config.models.simple).toBe("anthropic/claude-haiku");
    expect(config.models.medium).toBe("anthropic/claude-sonnet-4-5");
    expect(config.models.complex).toBe("anthropic/claude-opus-4-6");
    expect(config.opusPlanMode).toBe(false);
  });

  it("respects explicit config", () => {
    const config = resolveModelRoutingConfig({
      agents: {
        defaults: {
          modelRouting: {
            enabled: true,
            opusPlanMode: true,
            models: {
              simple: "openai/gpt-5-mini",
            },
          },
        },
      },
    } as never);
    expect(config.enabled).toBe(true);
    expect(config.opusPlanMode).toBe(true);
    expect(config.models.simple).toBe("openai/gpt-5-mini");
    // Others should still be defaults
    expect(config.models.medium).toBe("anthropic/claude-sonnet-4-5");
  });
});

describe("classifyComplexity", () => {
  describe("simple messages", () => {
    it("classifies greetings as simple", () => {
      expect(classifyComplexity("hi")).toBe("simple");
      expect(classifyComplexity("hello")).toBe("simple");
      expect(classifyComplexity("hey")).toBe("simple");
      expect(classifyComplexity("good morning")).toBe("simple");
      expect(classifyComplexity("What's up")).toBe("simple");
    });

    it("classifies status checks as simple", () => {
      expect(classifyComplexity("status")).toBe("simple");
      expect(classifyComplexity("how are you")).toBe("simple");
      expect(classifyComplexity("are you there")).toBe("simple");
    });

    it("classifies commands as simple", () => {
      expect(classifyComplexity("/help")).toBe("simple");
      expect(classifyComplexity("/version")).toBe("simple");
      expect(classifyComplexity("/model")).toBe("simple");
    });

    it("classifies very short messages as simple", () => {
      expect(classifyComplexity("ok")).toBe("simple");
      expect(classifyComplexity("yes")).toBe("simple");
      expect(classifyComplexity("thanks")).toBe("simple");
    });

    it("classifies empty messages as simple", () => {
      expect(classifyComplexity("")).toBe("simple");
      expect(classifyComplexity("  ")).toBe("simple");
    });
  });

  describe("complex messages", () => {
    it("classifies multi-step requests as complex", () => {
      expect(
        classifyComplexity(
          "First search for all TypeScript files, then update the imports, finally run the tests",
        ),
      ).toBe("complex");
    });

    it("classifies planning requests as complex", () => {
      expect(classifyComplexity("Plan the architecture for a new microservice system")).toBe(
        "complex",
      );
      expect(classifyComplexity("Refactor the entire authentication module")).toBe("complex");
    });

    it("classifies multi-tool requests as complex", () => {
      expect(classifyComplexity("Search for all usages of deprecated API and fix them")).toBe(
        "complex",
      );
    });

    it("classifies long multi-sentence messages as complex", () => {
      const longMessage =
        "I need you to review the pull request. Check the code quality. " +
        "Look for security vulnerabilities. Verify the test coverage. " +
        "Make sure the documentation is updated. Run the full test suite.";
      expect(classifyComplexity(longMessage)).toBe("complex");
    });
  });

  describe("medium messages", () => {
    it("classifies normal requests as medium", () => {
      expect(classifyComplexity("What does the function calculateTotal do?")).toBe("medium");
      expect(classifyComplexity("Show me the contents of package.json")).toBe("medium");
    });
  });
});

describe("routeMessage", () => {
  const config = resolveModelRoutingConfig();

  it("routes simple messages to haiku", () => {
    const result = routeMessage({ message: "hi", config });
    expect(result.complexity).toBe("simple");
    expect(result.model).toBe("anthropic/claude-haiku");
    expect(result.overridden).toBe(false);
  });

  it("routes complex messages to opus", () => {
    const result = routeMessage({
      message: "Plan the architecture for a new real-time notification system",
      config,
    });
    expect(result.complexity).toBe("complex");
    expect(result.model).toBe("anthropic/claude-opus-4-6");
    expect(result.overridden).toBe(false);
  });

  it("routes medium messages to sonnet", () => {
    const result = routeMessage({
      message: "What does this function do?",
      config,
    });
    expect(result.complexity).toBe("medium");
    expect(result.model).toBe("anthropic/claude-sonnet-4-5");
    expect(result.overridden).toBe(false);
  });

  it("explicit override takes precedence", () => {
    const result = routeMessage({
      message: "hi",
      config,
      explicitModelOverride: "google/gemini-3-pro-preview",
    });
    expect(result.model).toBe("google/gemini-3-pro-preview");
    expect(result.overridden).toBe(true);
  });

  it("opus plan mode routes thinking to opus", () => {
    const planConfig = { ...config, opusPlanMode: true };
    const result = routeMessage({
      message: "What does this do?",
      config: planConfig,
      isThinkingMode: true,
    });
    expect(result.model).toBe("anthropic/claude-opus-4-6");
    expect(result.reason).toContain("plan mode");
  });

  it("opus plan mode does not affect non-thinking messages", () => {
    const planConfig = { ...config, opusPlanMode: true };
    const result = routeMessage({
      message: "hi",
      config: planConfig,
      isThinkingMode: false,
    });
    expect(result.model).toBe("anthropic/claude-haiku");
  });
});
