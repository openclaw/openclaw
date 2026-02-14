import { describe, expect, it } from "vitest";
import { isCloudCodeAssistFormatError } from "./pi-embedded-helpers.js";
import { DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const _makeFile = (overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});
describe("isCloudCodeAssistFormatError", () => {
  it("matches format errors", () => {
    const samples = [
      "INVALID_REQUEST_ERROR: string should match pattern",
      "messages.1.content.1.tool_use.id",
      "tool_use.id should match pattern",
      "invalid request format",
    ];
    for (const sample of samples) {
      expect(isCloudCodeAssistFormatError(sample)).toBe(true);
    }
  });
  it("ignores unrelated errors", () => {
    expect(isCloudCodeAssistFormatError("rate limit exceeded")).toBe(false);
    expect(
      isCloudCodeAssistFormatError(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}',
      ),
    ).toBe(false);
  });
});
