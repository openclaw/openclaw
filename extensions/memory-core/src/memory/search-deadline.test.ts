import { describe, expect, it } from "vitest";
import { createMemorySearchDeadlineError, isMemorySearchDeadlineError } from "./search-deadline.js";

describe("memory search deadline error provenance", () => {
  it("cannot be branded by copying the marker off the abort reason", () => {
    // Providers receive the deadline as signal.reason, so a copied property
    // cannot establish that a provider failure came from the deadline owner.
    const deadline = createMemorySearchDeadlineError("memory search timed out");
    const forged = new Error("openai-compatible embeddings query failed");
    for (const key of Object.getOwnPropertySymbols(deadline)) {
      Object.defineProperty(forged, key, { value: true });
    }

    expect(isMemorySearchDeadlineError(deadline)).toBe(true);
    expect(isMemorySearchDeadlineError(forged)).toBe(false);
  });
});
