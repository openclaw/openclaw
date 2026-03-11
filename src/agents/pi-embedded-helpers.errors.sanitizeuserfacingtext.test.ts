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
});
