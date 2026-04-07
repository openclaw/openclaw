import { describe, expect, it } from "vitest";
import { formatRawAssistantErrorForUi } from "./pi-embedded-helpers.js";

describe("formatRawAssistantErrorForUi", () => {
  it("returns only the human-readable message from Anthropic payloads", () => {
    const text = formatRawAssistantErrorForUi(
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited."},"request_id":"req_123"}',
    );

    expect(text).toBe("Rate limited.");
    expect(text).not.toContain("req_123");
    expect(text).not.toContain("HTTP");
    expect(text).not.toContain("rate_limit_error");
  });

  it("renders a generic unknown error message when raw is empty", () => {
    expect(formatRawAssistantErrorForUi("")).toContain("unknown error");
  });

  it("formats plain HTTP status lines", () => {
    expect(formatRawAssistantErrorForUi("500 Internal Server Error")).toBe(
      "HTTP 500: Internal Server Error",
    );
  });
});
