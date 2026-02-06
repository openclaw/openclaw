import { describe, expect, it } from "vitest";
import { classifyFailoverReason, isModelNotFoundErrorMessage } from "./pi-embedded-helpers.js";
import { DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const _makeFile = (overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});
describe("classifyFailoverReason", () => {
  it("returns a stable reason", () => {
    expect(classifyFailoverReason("invalid api key")).toBe("auth");
    expect(classifyFailoverReason("no credentials found")).toBe("auth");
    expect(classifyFailoverReason("no api key found")).toBe("auth");
    expect(classifyFailoverReason("429 too many requests")).toBe("rate_limit");
    expect(classifyFailoverReason("resource has been exhausted")).toBe("rate_limit");
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ),
    ).toBe("rate_limit");
    expect(classifyFailoverReason("invalid request format")).toBe("format");
    expect(classifyFailoverReason("credit balance too low")).toBe("billing");
    expect(classifyFailoverReason("deadline exceeded")).toBe("timeout");
    expect(classifyFailoverReason("string should match pattern")).toBe("format");
    expect(classifyFailoverReason("bad request")).toBeNull();
    expect(
      classifyFailoverReason(
        "messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels",
      ),
    ).toBeNull();
    expect(classifyFailoverReason("image exceeds 5 MB maximum")).toBeNull();
  });
  it("classifies OpenAI usage limit errors as rate_limit", () => {
    expect(classifyFailoverReason("You have hit your ChatGPT usage limit (plus plan)")).toBe(
      "rate_limit",
    );
  });

  it("classifies unknown model errors as model_not_found", () => {
    expect(classifyFailoverReason("Unknown model: anthropic/claude-opus-4-6")).toBe(
      "model_not_found",
    );
    expect(classifyFailoverReason("Unknown model: openai/gpt-6")).toBe("model_not_found");
    expect(classifyFailoverReason("Model not found: xai/grok-5")).toBe("model_not_found");
    expect(classifyFailoverReason("model not found in catalog")).toBe("model_not_found");
  });
});

describe("isModelNotFoundErrorMessage", () => {
  it("returns true for unknown model errors", () => {
    expect(isModelNotFoundErrorMessage("Unknown model: anthropic/claude-opus-4-6")).toBe(true);
    expect(isModelNotFoundErrorMessage("Unknown model: openai/gpt-6")).toBe(true);
    expect(isModelNotFoundErrorMessage("UNKNOWN MODEL: test/model")).toBe(true);
  });

  it("returns true for model not found errors", () => {
    expect(isModelNotFoundErrorMessage("Model not found: xai/grok-5")).toBe(true);
    expect(isModelNotFoundErrorMessage("model not found in catalog")).toBe(true);
    expect(isModelNotFoundErrorMessage("MODEL NOT FOUND")).toBe(true);
  });

  it("returns false for empty or unrelated messages", () => {
    expect(isModelNotFoundErrorMessage("")).toBe(false);
    expect(isModelNotFoundErrorMessage("invalid api key")).toBe(false);
    expect(isModelNotFoundErrorMessage("rate limit exceeded")).toBe(false);
    expect(isModelNotFoundErrorMessage("bad request")).toBe(false);
  });
});
