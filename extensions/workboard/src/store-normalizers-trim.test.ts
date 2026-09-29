import type { WorkboardMetadata } from "@openclaw/workboard-contract";
// Workboard tests cover trimMetadataToBudget over-cap hydration fix.
// Card f3ba1664-a2cc-4e83-87d6-3dc18fefe499: over-cap cards must remain
// mutable. The trimmer must drop oldest comments BEFORE other metadata
// fields so that busy cards (50+ large comments ≈ 200KB) can still be
// hydrated and written back within the 24KB metadata budget.
import { describe, expect, it } from "vitest";
import { MAX_CARD_METADATA_BYTES } from "./store-constants.js";
import { trimMetadataToBudget } from "./store-normalizers.js";

function makeMetadata(overrides: Partial<WorkboardMetadata> = {}): WorkboardMetadata {
  return {
    ...overrides,
  };
}

describe("trimMetadataToBudget — comment-first trim for over-cap cards", () => {
  it("trims oldest comments before other fields when comments alone exceed budget", () => {
    // Build a card with 10 large comments (~4KB each = ~40KB), well over
    // the 24KB budget. Pre-fix, the trimmer would exhaust attempts/diagnostics/
    // notifications/proof/artifacts/attachments/workerLogs/links before
    // touching comments, then still fail because comments alone exceed
    // the budget. Post-fix, comments are trimmed first.
    const bigBody = "x".repeat(4000);
    const comments = Array.from({ length: 10 }, (_, i) => ({
      id: `c-${i}`,
      body: `comment ${i}: ${bigBody}`,
      createdAt: 1000 + i,
    }));
    const metadata = makeMetadata({
      comments,
      attempts: [{ id: "a1", status: "failed" as const, startedAt: 1, updatedAt: 2 }],
      diagnostics: [
        { kind: "stale" as const, severity: "warning" as const, message: "d", detectedAt: 1 },
      ],
      notifications: [{ kind: "completed" as const, message: "n", createdAt: 1, readAt: 2 }],
      proof: [{ id: "p1", status: "passed" as const, label: "l", createdAt: 1 }],
    });

    const trimmed = trimMetadataToBudget(metadata);

    // After trimming, metadata must be within budget.
    const byteSize = Buffer.byteLength(JSON.stringify(trimmed), "utf8");
    expect(byteSize).toBeLessThanOrEqual(MAX_CARD_METADATA_BYTES);

    // Comments must have been trimmed (fewer than 10 remain).
    expect(trimmed.comments?.length ?? 0).toBeLessThan(comments.length);

    // Critical invariant: the most recent comment must survive.
    // We trim from the front, so the LAST comment is preserved.
    const lastComment = trimmed.comments?.at(-1);
    expect(lastComment?.id).toBe("c-9");

    // Proof with preserveProofId must be retained.
    const preserved = trimMetadataToBudget(metadata, { preserveProofId: "p1" });
    expect(preserved.proof?.some((p) => p.id === "p1")).toBe(true);
  });

  it("does not throw when only comments exist and they exceed budget", () => {
    // Pure comment overload — no other fields to trim.
    const bigBody = "y".repeat(4000);
    const comments = Array.from({ length: 20 }, (_, i) => ({
      id: `c-${i}`,
      body: `comment ${i}: ${bigBody}`,
      createdAt: 2000 + i,
    }));
    const metadata = makeMetadata({ comments });

    const trimmed = trimMetadataToBudget(metadata);
    const byteSize = Buffer.byteLength(JSON.stringify(trimmed), "utf8");
    expect(byteSize).toBeLessThanOrEqual(MAX_CARD_METADATA_BYTES);
    expect(trimmed.comments?.length ?? 0).toBeGreaterThan(0);
    expect(trimmed.comments?.length ?? 0).toBeLessThan(comments.length);
  });
});
