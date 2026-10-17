import { describe, expect, it } from "vitest";
import { normalizeMetadata } from "./metadata-normalization.ts";

describe("Workboard automation metadata boundary", () => {
  it("keeps valid fields and filters malformed optional fields without losing string bytes", () => {
    expect(
      normalizeMetadata({
        automation: {
          tenant: "  tenant  ",
          boardId: "ops",
          summary: 1,
          skills: ["", " ", "  review ", 1],
          createdCardIds: ["card", null],
          workspace: { kind: "worktree", path: " /work ", sourceBranch: "main", unknown: true },
          workspaceAccess: { unrestricted: false, roots: ["", " /work ", 42], writable: true },
          maxRetries: 3,
          unknown: true,
        },
      }),
    ).toEqual({
      automation: {
        tenant: "  tenant  ",
        boardId: "ops",
        skills: ["  review "],
        createdCardIds: ["card"],
        workspace: { kind: "worktree", path: " /work ", sourceBranch: "main" },
        workspaceAccess: { unrestricted: false, roots: ["", " /work "], writable: true },
        maxRetries: 3,
      },
    });
  });

  it.each([
    {
      value: { skills: [null, " "], workspace: { kind: "invalid", path: "/work" } },
      expected: undefined,
    },
    {
      value: { workspaceAccess: { unrestricted: true, roots: ["/ignored"], writable: false } },
      expected: { workspaceAccess: { unrestricted: true } },
    },
    {
      value: { workspaceAccess: { unrestricted: false, roots: [], writable: true } },
      expected: { workspaceAccess: { unrestricted: false, roots: [], writable: true } },
    },
    {
      value: { workspaceAccess: { unrestricted: false, roots: [], writable: "yes" } },
      expected: undefined,
    },
    {
      value: { maxRuntimeSeconds: Number.NaN, maxRetries: Number.POSITIVE_INFINITY },
      expected: { maxRuntimeSeconds: Number.NaN, maxRetries: Number.POSITIVE_INFINITY },
    },
  ])("preserves optional-field tolerance for $value", ({ value, expected }) => {
    expect(normalizeMetadata({ automation: value })).toEqual(
      expected ? { automation: expected } : undefined,
    );
  });
});
