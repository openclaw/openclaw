import { describe, expect, it } from "vitest";
import { classifyCompactionReason, resolveCompactionFailureReason } from "./compact-reasons.js";

describe("resolveCompactionFailureReason", () => {
  it("replaces generic compaction cancellation with the safeguard reason", () => {
    expect(
      resolveCompactionFailureReason({
        reason: "Compaction cancelled",
        safeguardCancelReason:
          "Compaction safeguard could not resolve an API key for anthropic/claude-opus-4-6.",
      }),
    ).toBe("Compaction safeguard could not resolve an API key for anthropic/claude-opus-4-6.");
  });

  it("preserves non-generic compaction failures", () => {
    expect(
      resolveCompactionFailureReason({
        reason: "Compaction timed out",
        safeguardCancelReason:
          "Compaction safeguard could not resolve an API key for anthropic/claude-opus-4-6.",
      }),
    ).toBe("Compaction timed out");
  });
});

describe("classifyCompactionReason", () => {
  it('classifies "nothing to compact" as a skip-like reason', () => {
    expect(classifyCompactionReason("Nothing to compact (session too small)")).toBe(
      "no_compactable_entries",
    );
  });

  it("classifies safeguard messages as guard-blocked", () => {
    expect(
      classifyCompactionReason(
        "Compaction safeguard could not resolve an API key for anthropic/claude-opus-4-6.",
      ),
    ).toBe("guard_blocked");
  });

  it("preserves unknown error messages with sanitized spaces", () => {
    expect(classifyCompactionReason("No API provider registered for api: ollama")).toBe(
      "unknown:No_API_provider_registered_for_api:_ollama",
    );
    expect(classifyCompactionReason("Some error with   multiple   spaces")).toBe(
      "unknown:Some_error_with_multiple_spaces",
    );
  });

  it("returns 'unknown' for empty/undefined reason", () => {
    expect(classifyCompactionReason(undefined)).toBe("unknown");
    expect(classifyCompactionReason("")).toBe("unknown");
  });
});
