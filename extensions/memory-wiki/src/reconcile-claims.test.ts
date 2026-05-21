import { describe, expect, it } from "vitest";
import { reconcileClaims, type ReconcileClaimInput } from "./reconcile-claims.js";

const now = new Date("2026-05-21T12:00:00.000Z");

function claim(overrides: Partial<ReconcileClaimInput>): ReconcileClaimInput {
  return {
    claim_id: "claim.default",
    claim_key: "repo.openclaw.candidate.active",
    statement: "Candidate A is active.",
    source_class: "operator",
    authority_tier: 1,
    asserted_at: "2026-05-20T00:00:00.000Z",
    extracted_at: "2026-05-20T00:00:00.000Z",
    valid_from: "2026-05-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("reconcileClaims", () => {
  it("marks expired claims stale", () => {
    const [expired] = reconcileClaims({
      claims: [
        claim({
          claim_id: "claim.expired",
          valid_until: "2026-05-20T23:59:59.000Z",
        }),
      ],
      now,
    });

    expect(expired?.status).toBe("stale");
  });

  it("supersedes older lower-authority claims with newer higher-authority claims", () => {
    const reconciled = reconcileClaims({
      claims: [
        claim({
          claim_id: "claim.old",
          statement: "Candidate A is active.",
          authority_tier: 1,
          asserted_at: "2026-05-01T00:00:00.000Z",
          valid_from: "2026-05-01T00:00:00.000Z",
        }),
        claim({
          claim_id: "claim.new",
          statement: "Candidate B is active.",
          authority_tier: 3,
          asserted_at: "2026-05-21T00:00:00.000Z",
          valid_from: "2026-05-21T00:00:00.000Z",
        }),
      ],
      now,
    });

    const oldClaim = reconciled.find((entry) => entry.claim_id === "claim.old");
    const newClaim = reconciled.find((entry) => entry.claim_id === "claim.new");
    expect(oldClaim?.status).toBe("superseded");
    expect(oldClaim?.superseded_by).toEqual(["claim.new"]);
    expect(newClaim?.status).toBe("current");
    expect(newClaim?.supersedes).toEqual(["claim.old"]);
  });

  it("marks same-authority disagreements contested", () => {
    const reconciled = reconcileClaims({
      claims: [
        claim({ claim_id: "claim.left", statement: "Candidate A is active.", authority_tier: 2 }),
        claim({ claim_id: "claim.right", statement: "Candidate B is active.", authority_tier: 2 }),
      ],
      now,
    });

    expect(reconciled.map((entry) => entry.status).toSorted()).toEqual(["contested", "contested"]);
  });
});
