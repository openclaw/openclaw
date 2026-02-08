import { describe, expect, it } from "vitest";
import { classifyFailoverReason } from "./pi-embedded-helpers.js";
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

  it("classifies 'entity was not found' as not_found", () => {
    expect(classifyFailoverReason("Requested entity was not found.")).toBe("not_found");
  });

  it("classifies 'model not found' as not_found", () => {
    expect(classifyFailoverReason("The model xyz-123 was not found")).toBe("not_found");
  });

  it("classifies messages containing '404' as not_found", () => {
    expect(classifyFailoverReason("HTTP 404: resource unavailable")).toBe("not_found");
  });

  it("classifies not_found_error type as not_found", () => {
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"not_found_error","message":"Not found"}}',
      ),
    ).toBe("not_found");
  });

  it("does NOT classify 'file not found' as not_found (false positive)", () => {
    expect(classifyFailoverReason("file not found: config.json")).toBeNull();
  });

  it("does NOT classify 'module not found' as not_found (false positive)", () => {
    expect(classifyFailoverReason("module not found: @some/package")).toBeNull();
  });
});
