import { describe, expect, it } from "vitest";
import { normalizeClaimKey, resolveClaimKey } from "./claim-key.js";

describe("claim-key", () => {
  it("normalizes explicit claim keys into canonical dotted subsets", () => {
    expect(normalizeClaimKey(" Repo / OpenClaw :: Candidate Active ")).toBe(
      "repo.openclaw.candidate-active",
    );
  });

  it("maps known active candidate statements to the canonical active candidate key", () => {
    expect(
      resolveClaimKey({
        statement: "The current OpenClaw meta-harness candidate is candidate-0055.",
      }),
    ).toBe("repo.openclaw.candidate.active");
  });

  it("falls back to a stable hash key for uncategorized claims", () => {
    const first = resolveClaimKey({ statement: "A local fact", pagePath: "sources/a.md" });
    const second = resolveClaimKey({ statement: "A local fact", pagePath: "sources/a.md" });
    expect(first).toBe(second);
    expect(first).toMatch(/^claim\.[a-f0-9]{16}$/);
  });
});
