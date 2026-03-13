import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    getOAuthProviders: () => [],
  };
});

import { sanitizeUserFacingText } from "./pi-embedded-helpers/errors.js";

describe("sanitizeUserFacingText special markup stripping", () => {
  it("strips leaked model special tokens", () => {
    const result = sanitizeUserFacingText("NO_REPLY +#+#+#+# assistant to=final\n\nActual reply");
    expect(result).not.toContain("#+#+#+#+#+#");
    expect(result).not.toMatch(/assistant to=final/i);
    expect(result).toContain("Actual reply");
  });

  it("strips leaked role labels only when adjacent to model markers", () => {
    const result = sanitizeUserFacingText("assistant:\nassistant to=final\n\nActual reply");
    expect(result).not.toContain("assistant to=final");
    expect(result).not.toMatch(/^assistant:\s*$/m);
    expect(result).toContain("Actual reply");
  });

  it("preserves legitimate role-label examples in normal content", () => {
    const result = sanitizeUserFacingText("Example YAML:\nassistant:\n  say: hello");
    expect(result).toContain("assistant:");
    expect(result).toContain("say: hello");
  });

  it("preserves inline assistant to markers in normal content", () => {
    const result = sanitizeUserFacingText(
      "Transcript snippet: the literal marker assistant to=final leaked into a debug log.",
    );
    expect(result).toContain("assistant to=final");
  });

  it("preserves standalone protocol-marker examples in normal content", () => {
    const result = sanitizeUserFacingText(
      "Literal marker example:\nassistant to=final\n\nKeep this line too.",
    );
    expect(result).toContain("assistant to=final");
    expect(result).toContain("Keep this line too.");
  });
});
