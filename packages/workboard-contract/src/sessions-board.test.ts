import { describe, expect, expectTypeOf, it } from "vitest";
import {
  normalizeWorkboardSessionsBoardSpec,
  type WorkboardSessionFacts,
} from "./sessions-board.js";

it("exposes optional PR card details and rate-limit status without requiring enrichment", () => {
  expectTypeOf<WorkboardSessionFacts["pullRequests"][number]>().toEqualTypeOf<{
    number: number;
    state: "open" | "draft" | "merged" | "closed";
    url?: string;
    title?: string;
  }>();
  expectTypeOf<WorkboardSessionFacts["pullRequestsRateLimited"]>().toEqualTypeOf<
    true | undefined
  >();
});

function specWithMatch(match: unknown) {
  return {
    columns: [
      { id: "matched", label: "Matched", description: "Matching sessions.", match },
      { id: "rest", label: "Rest", description: "Other sessions.", fallback: true },
    ],
  };
}

describe("Sessions board match normalization", () => {
  it.each([
    {},
    { includeAutomation: true, includeHome: true },
    { includeAutomation: false, includeHome: false },
  ])("preserves optional scope opt-ins: %j", (scope) => {
    expect(normalizeWorkboardSessionsBoardSpec({ ...specWithMatch({}), scope }).scope).toEqual(
      scope,
    );
  });

  it.each(["includeAutomation", "includeHome"])("rejects non-boolean scope.%s", (field) => {
    expect(() =>
      normalizeWorkboardSessionsBoardSpec({ ...specWithMatch({}), scope: { [field]: "true" } }),
    ).toThrow(`scope.${field} must be a boolean`);
  });

  it.each([
    { name: "one rule", match: { run: ["active"] }, expected: { run: ["active"] } },
    { name: "a singleton array", match: [{ run: ["active"] }], expected: { run: ["active"] } },
    {
      name: "any-of rules",
      match: [{ health: ["stuck", "failed", "stuck"] }, { run: ["failed"] }],
      expected: [{ health: ["stuck", "failed"] }, { run: ["failed"] }],
    },
  ])("normalizes $name to its minimal stored form", ({ match, expected }) => {
    expect(normalizeWorkboardSessionsBoardSpec(specWithMatch(match)).columns[0]?.match).toEqual(
      expected,
    );
  });

  it.each([
    { name: "an empty array", match: [], error: "at least one rule" },
    { name: "nested rule arrays", match: [[{ run: ["active"] }]], error: "must be an object" },
    { name: "null rules", match: [null], error: "must be an object" },
    { name: "string rules", match: ["failed"], error: "must be an object" },
    { name: "unknown fields", match: [{ state: ["failed"] }], error: "Unknown column match" },
    { name: "invalid facts", match: [{ run: ["unknown"] }], error: "unsupported value" },
  ])("rejects $name", ({ match, error }) => {
    expect(() => normalizeWorkboardSessionsBoardSpec(specWithMatch(match))).toThrow(error);
  });
});
