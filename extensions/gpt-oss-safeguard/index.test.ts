import { describe, expect, it } from "vitest";
import {
  buildSafeguardPrompt,
  parseSafeguardResponse,
  DEFAULT_POLICY,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_OUTPUT_FORMAT,
} from "./index.js";

describe("buildSafeguardPrompt", () => {
  const testPolicy = "Test safety policy: check for harmful content.";

  it("builds prompt with binary output format", () => {
    const { systemPrompt, userPrompt } = buildSafeguardPrompt(
      "Test content",
      testPolicy,
      "medium",
      "binary",
    );

    expect(systemPrompt).toContain(testPolicy);
    expect(systemPrompt).toContain("Reasoning effort: medium");
    expect(systemPrompt).toContain("Respond with exactly 0 (safe) or 1 (violation)");
    expect(userPrompt).toContain("Evaluate the following content:");
    expect(userPrompt).toContain("Test content");
  });

  it("builds prompt with json output format", () => {
    const { systemPrompt, userPrompt } = buildSafeguardPrompt(
      "Test content",
      testPolicy,
      "low",
      "json",
    );

    expect(systemPrompt).toContain("Reasoning effort: low");
    expect(systemPrompt).toContain(
      '{"violation": 0|1, "policy_category": "category name or null"}',
    );
    expect(userPrompt).toContain("Test content");
  });

  it("builds prompt with rich output format", () => {
    const { systemPrompt, userPrompt } = buildSafeguardPrompt(
      "Test content",
      testPolicy,
      "high",
      "rich",
    );

    expect(systemPrompt).toContain("Reasoning effort: high");
    expect(systemPrompt).toContain('"confidence": "low|medium|high"');
    expect(systemPrompt).toContain('"rationale": "brief explanation"');
    expect(userPrompt).toContain("Test content");
  });

  it("uses default policy correctly", () => {
    const { systemPrompt } = buildSafeguardPrompt(
      "content",
      DEFAULT_POLICY,
      DEFAULT_REASONING_EFFORT,
      DEFAULT_OUTPUT_FORMAT,
    );

    expect(systemPrompt).toContain("prompt injection");
    expect(systemPrompt).toContain("secrets");
    expect(systemPrompt).toContain("Otherwise classify as safe");
  });
});

describe("parseSafeguardResponse", () => {
  describe("binary format", () => {
    it("parses 0 as safe", () => {
      const result = parseSafeguardResponse("0", "binary");

      expect(result.safe).toBe(true);
      expect(result.violation).toBe(false);
    });

    it("parses 1 as violation", () => {
      const result = parseSafeguardResponse("1", "binary");

      expect(result.safe).toBe(false);
      expect(result.violation).toBe(true);
    });

    it("handles whitespace around binary response", () => {
      const result = parseSafeguardResponse("  0  \n", "binary");

      expect(result.safe).toBe(true);
      expect(result.violation).toBe(false);
    });

    it("treats response starting with 1 as violation", () => {
      const result = parseSafeguardResponse("1 - violation detected", "binary");

      expect(result.safe).toBe(false);
      expect(result.violation).toBe(true);
    });
  });

  describe("json format", () => {
    it("parses safe JSON response", () => {
      const result = parseSafeguardResponse('{"violation": 0, "policy_category": null}', "json");

      expect(result.safe).toBe(true);
      expect(result.violation).toBe(false);
      expect(result.policyCategory).toBeUndefined();
    });

    it("parses violation JSON response", () => {
      const result = parseSafeguardResponse(
        '{"violation": 1, "policy_category": "Hate speech"}',
        "json",
      );

      expect(result.safe).toBe(false);
      expect(result.violation).toBe(true);
      expect(result.policyCategory).toBe("Hate speech");
    });

    it("parses boolean violation value", () => {
      const result = parseSafeguardResponse(
        '{"violation": true, "policy_category": "Violence"}',
        "json",
      );

      expect(result.safe).toBe(false);
      expect(result.violation).toBe(true);
      expect(result.policyCategory).toBe("Violence");
    });

    it("extracts JSON from markdown code block", () => {
      const response = '```json\n{"violation": 1, "policy_category": "Illegal"}\n```';
      const result = parseSafeguardResponse(response, "json");

      expect(result.safe).toBe(false);
      expect(result.violation).toBe(true);
      expect(result.policyCategory).toBe("Illegal");
    });

    it("handles extra text around JSON", () => {
      const response =
        'Based on my analysis:\n{"violation": 0, "policy_category": null}\nThis is safe.';
      const result = parseSafeguardResponse(response, "json");

      expect(result.safe).toBe(true);
      expect(result.violation).toBe(false);
    });
  });

  describe("rich format", () => {
    it("parses full rich response", () => {
      const response = JSON.stringify({
        violation: 1,
        policy_category: "Harmful content",
        confidence: "high",
        rationale: "Contains instructions for illegal activities",
      });
      const result = parseSafeguardResponse(response, "rich");

      expect(result.safe).toBe(false);
      expect(result.violation).toBe(true);
      expect(result.policyCategory).toBe("Harmful content");
      expect(result.confidence).toBe("high");
      expect(result.rationale).toBe("Contains instructions for illegal activities");
    });

    it("parses safe rich response", () => {
      const response = JSON.stringify({
        violation: 0,
        policy_category: null,
        confidence: "high",
        rationale: "Content is appropriate",
      });
      const result = parseSafeguardResponse(response, "rich");

      expect(result.safe).toBe(true);
      expect(result.violation).toBe(false);
      expect(result.confidence).toBe("high");
      expect(result.rationale).toBe("Content is appropriate");
    });
  });

  describe("fallback parsing", () => {
    it("handles malformed JSON with violation indicator", () => {
      const result = parseSafeguardResponse('violation: 1, category: "bad"', "json");

      expect(result.safe).toBe(false);
      expect(result.violation).toBe(true);
    });

    it("handles malformed JSON without violation indicator", () => {
      const result = parseSafeguardResponse("This content appears safe", "json");

      expect(result.safe).toBe(true);
      expect(result.violation).toBe(false);
    });

    it("handles empty response", () => {
      const result = parseSafeguardResponse("", "json");

      expect(result.safe).toBe(true);
      expect(result.violation).toBe(false);
    });

    it("detects violation:true pattern", () => {
      const result = parseSafeguardResponse("The violation: true for this content", "json");

      expect(result.safe).toBe(false);
      expect(result.violation).toBe(true);
    });
  });
});

describe("default constants", () => {
  it("has correct default provider", () => {
    expect(DEFAULT_PROVIDER).toBe("ollama");
  });

  it("has correct default model", () => {
    expect(DEFAULT_MODEL).toBe("openai/gpt-oss-safeguard-120b");
  });

  it("has correct default reasoning effort", () => {
    expect(DEFAULT_REASONING_EFFORT).toBe("medium");
  });

  it("has correct default output format", () => {
    expect(DEFAULT_OUTPUT_FORMAT).toBe("json");
  });

  it("default policy contains expected categories", () => {
    expect(DEFAULT_POLICY).toContain("prompt injection");
    expect(DEFAULT_POLICY).toContain("secrets, credentials, API keys");
    expect(DEFAULT_POLICY).toContain("illegal, violent, self-harm");
    expect(DEFAULT_POLICY).toContain("sensitive personal data");
    expect(DEFAULT_POLICY).toContain("tool use, code execution");
  });
});
