import { describe, expect, it } from "vitest";
import { formatRawAssistantErrorForUi } from "./pi-embedded-helpers.js";

describe("formatRawAssistantErrorForUi", () => {
  it("renders HTTP code + type + message from Anthropic payloads", () => {
    const text = formatRawAssistantErrorForUi(
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited."},"request_id":"req_123"}',
    );

    expect(text).toContain("temporarily overloaded");
  });

  it("renders a generic unknown error message when raw is empty", () => {
    expect(formatRawAssistantErrorForUi("")).toContain("unknown error");
  });

  it("formats plain HTTP status lines", () => {
    expect(formatRawAssistantErrorForUi("500 Internal Server Error")).toContain(
      "returned an error",
    );
  });
});
